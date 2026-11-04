import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { OfflineManager } from '../offline.js';

const base = new URL('../', import.meta.url);
const bytes = [new TextEncoder().encode('verified Ryan phrase audio'), new TextEncoder().encode('verified Ryan example audio')];
const files = bytes.map((value, i) => ({ path: `audio/test-${i}.mp3`, bytes: value.byteLength, sha256: createHash('sha256').update(value).digest('hex') }));
const shell = ['./', 'index.html', 'styles.css', 'app.js', 'engine.js', 'data.js', 'offline.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable.png', 'icons/apple-touch-icon.png', 'audio/manifest.json'];
const key = value => typeof value === 'string' ? value : value.url || value.href;
class MemoryCache {
  entries = new Map();
  async match(value) { return this.entries.get(key(value))?.clone(); }
  async put(value, response) { this.entries.set(key(value), response.clone()); }
  async delete(value) { return this.entries.delete(key(value)); }
}
class MemoryCaches {
  stores = new Map();
  async open(name) { if (!this.stores.has(name)) this.stores.set(name, new MemoryCache()); return this.stores.get(name); }
  async delete(name) { return this.stores.delete(name); }
  async keys() { return [...this.stores.keys()]; }
}

async function setup(t, callbacks = {}) {
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} });
  globalThis.caches = new MemoryCaches();
  t.after(() => {
    globalThis.fetch = previousFetch;
    delete globalThis.isSecureContext;
    delete navigator.serviceWorker;
    delete globalThis.caches;
  });
  const shellCache = await caches.open('hp-pocket-shell-v4');
  for (const path of shell) await shellCache.put(new URL(path, base).href, new Response(path === 'audio/manifest.json' ? JSON.stringify({ voice: 'en-GB-RyanNeural', files }) : 'shell'));
  const requested = [];
  globalThis.fetch = async url => {
    const index = files.findIndex(file => new URL(file.path, base).href === String(url));
    requested.push(index);
    if (index < 0) throw new Error('Unexpected fetch');
    return new Response(bytes[index]);
  };
  const manager = new OfflineManager(callbacks);
  manager.manifest = { voice: 'en-GB-RyanNeural', files };
  return { manager, requested, shellCache, cache: await caches.open('hp-pocket-audio-v1') };
}

test('download checks all hashes; repeat reuses valid audio and repairs corruption', async t => {
  const { manager, requested, cache } = await setup(t);
  assert.equal((await manager.download()).complete, true);
  assert.deepEqual(requested, [0, 1]);
  await manager.download();
  assert.deepEqual(requested, [0, 1]);
  await cache.put(new URL(files[0].path, base).href, new Response('broken'));
  assert.equal((await manager.inspect()).cached, 1);
  await manager.download();
  assert.deepEqual(requested, [0, 1, 0]);
});

test('corrupt download is never saved or reported complete', async t => {
  const { manager, cache } = await setup(t);
  globalThis.fetch = async () => new Response('not the expected MP3');
  await assert.rejects(manager.download(), /скачалась не полностью/);
  assert.equal((await manager.inspect()).cached, 0);
  assert.equal(await cache.match(new URL(files[0].path, base).href), undefined);
});

test('interrupted download retains finished files and resumes only missing files', async t => {
  let manager;
  const state = await setup(t, { onProgress: progress => { if (progress.cached === 1) manager.cancel(); } });
  manager = state.manager;
  await assert.rejects(manager.download(), { name: 'AbortError' });
  assert.equal((await manager.inspect()).cached, 1);
  manager.onProgress = () => {};
  await manager.download();
  assert.deepEqual(state.requested, [0, 1]);
});

test('missing shell prevents an offline-ready claim; selective removal keeps unrelated caches', async t => {
  const { manager, shellCache } = await setup(t);
  await manager.download();
  await (await caches.open('englex-pocket-audio')).put('https://example.test/englex.mp3', new Response('other app'));
  await manager.clearAudio([files[0].path]);
  assert.equal((await manager.inspect()).cached, 1);
  assert.ok(await (await caches.open('englex-pocket-audio')).match('https://example.test/englex.mp3'));
  await shellCache.delete(new URL('app.js', base).href);
  const status = await manager.inspect([files[1].path]);
  assert.equal(status.cached, 1);
  assert.equal(status.shellReady, false);
  assert.equal(status.complete, false);
  await assert.rejects(manager.download(['audio/unknown.mp3']), /нет проверенной озвучки/);
});

test('init repairs an evicted shell with an active worker; downloads repair only missing assets', async t => {
  const { manager, requested } = await setup(t);
  navigator.serviceWorker.register = async () => ({ active: {} });
  const audioFetch = globalThis.fetch;
  const shellRequests = [];
  const allowed = new Set(shell.map(path => new URL(path, base).href));
  globalThis.fetch = async (url, options) => {
    if (!allowed.has(String(url))) return audioFetch(url, options);
    shellRequests.push(String(url));
    return new Response(String(url).endsWith('/audio/manifest.json') ? JSON.stringify(manager.manifest) : 'repaired shell');
  };
  await caches.delete('hp-pocket-shell-v4');
  const repaired = await manager.init();
  assert.equal(repaired.shellReady, true);
  assert.equal(repaired.complete, false);
  assert.deepEqual(new Set(shellRequests), allowed);
  await manager.download();
  assert.equal(shellRequests.length, shell.length, 'valid shell assets are not downloaded again');
  const shellCache = await caches.open('hp-pocket-shell-v4');
  const missingURL = new URL('app.js', base).href;
  await shellCache.delete(missingURL);
  assert.equal((await manager.download()).complete, true);
  assert.equal(shellRequests.length, shell.length + 1);
  assert.equal(shellRequests.at(-1), missingURL);
  assert.deepEqual(requested, [0, 1], 'valid audio is reused during shell repair');
});

test('failed shell repair cannot report the selected audio as offline-ready', async t => {
  const { manager, shellCache } = await setup(t);
  await shellCache.delete(new URL('app.js', base).href);
  globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
  await assert.rejects(manager.download(), /Не удалось сохранить файлы приложения/);
  assert.equal((await manager.inspect()).complete, false);
});

test('audio eviction during a download fails the final check and resumes only missing files', async t => {
  const phases = [];
  const { manager, cache, requested } = await setup(t);
  manager.onProgress = info => {
    phases.push(info);
    if (info.phase === 'downloading' && info.cached === info.total) {
      cache.entries.delete(new URL(files[0].path, base).href);
    }
  };
  await assert.rejects(manager.download(), /Не все записи сохранились/);
  assert.equal(phases.some(info => info.phase === 'done'), false);
  assert.equal(phases.at(-1).phase, 'error');
  assert.equal(phases.at(-1).cached, 1, 'progress reflects the verified cache, not earlier successful requests');
  manager.onProgress = () => {};
  assert.equal((await manager.download()).complete, true);
  assert.deepEqual(requested, [0, 1, 0]);
});

test('service worker supports Safari byte ranges and leaves external/private requests alone', async () => {
  const handlers = {};
  const context = vm.createContext({
    self: { location: { href: 'https://example.test/potter/sw.js' }, addEventListener: (name, fn) => { handlers[name] = fn; } },
    URL, Response, Request, Headers, fetch, caches: new MemoryCaches(),
  });
  vm.runInContext(await readFile(new URL('../sw.js', import.meta.url), 'utf8'), context);
  const rangeResponse = vm.runInContext('audioResponse', context);
  for (const [range, status, expected, contentRange] of [
    ['bytes=0-1', 206, 'ab', 'bytes 0-1/6'],
    ['bytes=3-', 206, 'def', 'bytes 3-5/6'],
    ['bytes=-2', 206, 'ef', 'bytes 4-5/6'],
    ['bytes=2-99', 206, 'cdef', 'bytes 2-5/6'],
    ['bytes=8-', 416, '', 'bytes */6'],
    ['bytes=2-1', 416, '', 'bytes */6'],
    ['bytes=0-1,3-4', 416, '', 'bytes */6'],
  ]) {
    const request = new Request('https://example.test/potter/audio/test.mp3', { headers: { range } });
    const result = await rangeResponse(request, new Response('abcdef'));
    assert.equal(result.status, status, range);
    assert.equal(result.headers.get('Content-Range'), contentRange, range);
    assert.equal(await result.text(), expected, range);
  }
  for (const url of ['https://other.test/potter/audio/test.mp3', 'https://example.test/englex/index.html', 'https://example.test/potter/private-book.txt']) {
    let intercepted = false;
    handlers.fetch({ request: new Request(url), respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, url);
  }
});
