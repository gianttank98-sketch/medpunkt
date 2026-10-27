/* Фоновый помощник приложения «Учёт медикаментов».
 * 1) Хранит копию приложения на телефоне — оно открывается без интернета.
 * 2) Когда появляется сеть, сам отправляет накопленные операции (Android: даже если приложение закрыто).
 *    Пока приложение открыто на экране, отправляет оно само — помощник только просит его.
 * Номер операции защищает от двойного учёта: если одна и та же операция уйдёт дважды, сервер её узнает. */
'use strict';
const VERSION = '5a6088481ef7';
const CACHE = 'medpunkt-' + VERSION;
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'];
const CDN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/(@zxing\/library|qrcode-generator|tesseract\.js|tesseract\.js-core|@tesseract\.js-data\/[a-z]+)@/;

self.addEventListener('install', e => {
  // мимо HTTP-кэша браузера: новая версия должна поставить себе именно новые файлы
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('medpunkt-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return; // запросы к серверу (POST) — мимо кэша
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // сама страница: сразу из памяти телефона, а в фоне — свежая версия на следующий запуск
    if (req.mode === 'navigate') {
      e.respondWith(caches.open(CACHE).then(async c => {
        const cached = await c.match('./index.html');
        const fresh = fetch('./index.html', { cache: 'no-cache' }).then(r => { if (r.ok) c.put('./index.html', r.clone()); return r; }).catch(() => null);
        if (cached) { e.waitUntil(fresh); return cached; }
        return (await fresh) || new Response('Нет связи', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }));
      return;
    }
    e.respondWith(caches.open(CACHE).then(c => c.match(req, { ignoreSearch: true })).then(r => r || fetch(req)));
    return;
  }
  if (CDN.test(req.url)) { // сканер штрихкодов и QR — тоже без интернета
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    }));
  }
});

/* ---------- общее хранилище с приложением ---------- */
function kvOpen() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open('med5q', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function kvGet(k) { const db = await kvOpen(); return new Promise(res => { const rq = db.transaction('kv').objectStore('kv').get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(undefined); }); }
async function kvSet(k, v) { const db = await kvOpen(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function photoGet(key) {
  try {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('med5', 1); rq.onupgradeneeded = () => rq.result.createObjectStore('photos'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    return await new Promise(res => { const rq = db.transaction('photos').objectStore('photos').get(key); rq.onsuccess = () => res(rq.result || ''); rq.onerror = () => res(''); });
  } catch (e) { return ''; }
}
async function photoDel(key) {
  try {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('med5', 1); rq.onupgradeneeded = () => rq.result.createObjectStore('photos'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    db.transaction('photos', 'readwrite').objectStore('photos').delete(key);
  } catch (e) { }
}

async function post(api, action, payload) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 90000);
  try {
    const res = await fetch(api, { method: 'POST', body: JSON.stringify({ action, payload }), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return JSON.parse(await res.text());
  } finally { clearTimeout(tm); }
}

/** Отправить очередь. Если приложение открыто на экране — пусть отправит оно (у него свежая очередь). */
async function flushFromSW(force) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visible = wins.filter(w => w.visibilityState === 'visible');
  if (visible.length && !force) { visible.forEach(w => w.postMessage({ type: 'flush' })); return 'client'; }
  const run = () => flushLocked();
  let r;
  if (self.navigator && navigator.locks && navigator.locks.request) {
    // если приложение «уснуло» посреди отправки и держит очередь — не ждём вечно, браузер повторит позже
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 60000);
    try { r = await navigator.locks.request('med-flush', { signal: ctl.signal }, run); } finally { clearTimeout(tm); }
  } else r = await run();
  wins.forEach(w => w.postMessage({ type: 'flushed' }));
  return r;
}
async function flushLocked() {
  const api = await kvGet('api');
  const auth = await kvGet('auth');
  if (!api || !auth || !auth.sess) return 'noauth';
  let sent = 0;
  const skip = {};
  ((await kvGet('done')) || []).forEach(id => { skip[id] = 1; });
  ((await kvGet('swDone')) || []).forEach(e => { skip[typeof e === 'string' ? e : e.id] = 1; });
  // очередь всегда перечитывается заново и меняется только по номеру операции:
  // приложение могло дописать в неё новое, пока помощник отправлял (старую копию поверх не пишем)
  const mine = q => q.filter(o => o.userId === auth.userId && (!o.api || o.api === api));
  for (;;) {
    const op = mine((await kvGet('queue')) || [])[0];
    if (!op) break;
    if (skip[op.opId]) { await kvRemoveOp(op.opId); continue; } // уже ушла (старая копия очереди) — не повторяем
    const payload = Object.assign({}, op.payload, { sess: auth.sess, noState: true }); // помощнику состояние не нужно — сервер отвечает быстрее
    if (op.payload && op.payload.idb) { // фото (к форме или акт поставки) хранится отдельно — подставляем перед отправкой
      const b64 = await photoGet(op.payload.idb);
      if (!b64) { await markFailed(op, { code: 'E_BAD_PHOTO', info: {} }); await kvRemoveOp(op.opId); continue; }
      payload.b64 = b64;
    }
    const r = await post(api, op.action, payload); // нет связи — исключение, браузер повторит позже
    if (r && r.ok) {
      if (op.payload && op.payload.idb) await photoDel(op.payload.idb);
      const done = (await kvGet('swDone')) || [];
      // ответ нужен приложению, чтобы показать то же, что показало бы само (нехватка при списании, отмена)
      done.push({ id: op.opId, res: (op.action === 'spend' || op.action === 'undo' || op.action === 'receive') && r.result ? r.result : null });
      await kvSet('swDone', done.slice(-500));
      skip[op.opId] = 1;
      await kvRemoveOp(op.opId);
      sent++;
      continue;
    }
    const code = r ? r.code : 'E_SERVER';
    if (code === 'E_AUTH' || code === 'E_MUST_CHANGE') break; // войдёт снова — уйдёт
    const attempts = (op.attempts || 0) + 1;
    if ((!r || r.retry) && (code === 'E_BUSY' || attempts < 6)) {
      await kvPatchOp(op.opId, { attempts });
      throw new Error('retry ' + code);
    }
    await markFailed(op, { code, info: r ? r.info || {} : {} });
    await kvRemoveOp(op.opId);
  }
  const left = mine((await kvGet('queue')) || []).length;
  try { if (self.navigator.setAppBadge) { if (left) await navigator.setAppBadge(left); else await navigator.clearAppBadge(); } } catch (e) { }
  return 'sent:' + sent;
}
async function kvRemoveOp(id) { await kvSet('queue', ((await kvGet('queue')) || []).filter(o => o.opId !== id)); }
async function kvPatchOp(id, patch) { await kvSet('queue', ((await kvGet('queue')) || []).map(o => (o.opId === id ? Object.assign({}, o, patch) : o))); }
async function markFailed(op, error) {
  const f = (await kvGet('swFailed')) || [];
  f.push({ op, error });
  await kvSet('swFailed', f.slice(-200));
}

self.addEventListener('sync', e => { if (e.tag === 'med-flush') e.waitUntil(flushFromSW(false)); });
self.addEventListener('periodicsync', e => { if (e.tag === 'med-flush') e.waitUntil(flushFromSW(false).catch(() => { })); });
self.addEventListener('message', e => {
  const m = e.data || {};
  if (m.type === 'flushNow') e.waitUntil(flushFromSW(!!m.force).catch(() => { }));
});
