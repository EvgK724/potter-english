const BASE_URL = new URL('./', import.meta.url);
const SHELL_CACHE = 'hp-pocket-shell-v4';
const AUDIO_CACHE = 'hp-pocket-audio-v1';
const MANIFEST_URL = new URL('audio/manifest.json', BASE_URL).href;
const SHELL_ASSETS = [
  './', 'index.html', 'styles.css', 'app.js', 'engine.js', 'data.js',
  'offline.js', 'manifest.webmanifest', 'icons/icon-192.png',
  'icons/icon-512.png', 'icons/icon-maskable.png', 'icons/apple-touch-icon.png', 'audio/manifest.json',
];

const abortError = () => new DOMException('Загрузка остановлена. Сохранённые файлы останутся на устройстве.', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
  .map(value => value.toString(16).padStart(2, '0')).join('');

function validateManifest(value) {
  if (!value || value.voice !== 'en-GB-RyanNeural' || !Array.isArray(value.files) || value.files.length > 20000) {
    throw new Error('Не удалось проверить каталог озвучки Ryan. Попробуйте обновить приложение с интернетом.');
  }
  const seen = new Set();
  for (const file of value.files) {
    if (!file || !/^audio\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.mp3$/.test(file.path)
      || file.path.includes('..') || seen.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 100 * 1024 * 1024
      || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw new Error('Каталог озвучки повреждён. Загрузка не начата.');
    }
    seen.add(file.path);
  }
  return value;
}

function waitUntilActive(registration) {
  if (registration.active) return Promise.resolve();
  const worker = registration.installing || registration.waiting;
  if (!worker) return Promise.reject(new Error('Не удалось подготовить приложение к работе без интернета.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Сохранение приложения заняло слишком долго. Повторите с интернетом.')), 20000);
    const finish = error => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', changed);
      error ? reject(error) : resolve();
    };
    const changed = () => {
      if (worker.state === 'activated') finish();
      else if (worker.state === 'redundant') finish(new Error('Не все файлы приложения доступны. Повторите с интернетом.'));
    };
    worker.addEventListener('statechange', changed);
    changed();
  });
}

/** All caches belong to this app. Imported book text never enters Cache Storage. */
export class OfflineManager {
  constructor({ onProgress = () => {}, onStatus = () => {} } = {}) {
    this.onProgress = onProgress;
    this.onStatus = onStatus;
    this.manifest = null;
    this.controller = null;
    this.supported = Boolean(globalThis.isSecureContext && 'serviceWorker' in navigator
      && 'caches' in globalThis && globalThis.crypto?.subtle);
  }

  async init() {
    if (!this.supported) return this.inspect();
    try {
      this.registration = await navigator.serviceWorker.register(new URL('sw.js', BASE_URL), { scope: BASE_URL.pathname });
      await waitUntilActive(this.registration);
      await this.ensureShell();
      await this.loadManifest();
      return await this.inspect();
    } catch (error) {
      this.onStatus({ supported: this.supported, complete: false, shellReady: false, error: error.message });
      throw error;
    }
  }

  async loadManifest() {
    if (this.manifest) return this.manifest;
    let response;
    try {
      response = await fetch(MANIFEST_URL, { cache: 'no-cache', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Manifest unavailable');
      this.manifest = validateManifest(await response.clone().json());
      await (await caches.open(SHELL_CACHE)).put(MANIFEST_URL, response);
    } catch (error) {
      const stored = await (await caches.open(SHELL_CACHE)).match(MANIFEST_URL);
      if (!stored) throw new Error('Каталог озвучки ещё не сохранён. Подключитесь к интернету и повторите загрузку.');
      this.manifest = validateManifest(await stored.json());
    }
    return this.manifest;
  }

  async filesFor(paths) {
    const manifest = await this.loadManifest();
    if (paths == null) return manifest.files;
    if (!Array.isArray(paths)) throw new TypeError('Нужен список файлов озвучки.');
    const requested = new Set(paths);
    const files = manifest.files.filter(file => requested.has(file.path));
    if (files.length !== requested.size) throw new Error('Для части карточек нет проверенной озвучки Ryan.');
    return files;
  }

  async validCached(cache, file) {
    const url = new URL(file.path, BASE_URL).href;
    const response = await cache.match(url);
    if (!response) return false;
    try {
      const bytes = await response.arrayBuffer();
      if (response.status === 200 && bytes.byteLength === file.bytes && await hash(bytes) === file.sha256.toLowerCase()) return true;
    } catch { /* A partially evicted or corrupt entry is unavailable. */ }
    await cache.delete(url);
    return false;
  }

  async shellEntryAvailable(cache, url) {
    const response = await cache.match(url);
    if (!response || response.status !== 200) return false;
    try {
      if (!(await response.clone().arrayBuffer()).byteLength) return false;
      if (url === MANIFEST_URL) validateManifest(await response.json());
      return true;
    } catch { return false; }
  }

  /** Repair only absent/broken whitelisted assets, including after cache eviction. */
  async ensureShell({ signal } = {}) {
    const cache = await caches.open(SHELL_CACHE);
    for (const path of SHELL_ASSETS) {
      checkAbort(signal);
      const url = new URL(path, BASE_URL).href;
      if (await this.shellEntryAvailable(cache, url)) continue;
      // Remove an invalid entry before fetching, so the service worker cannot
      // return that same broken cache-first response to the repair request.
      await cache.delete(url);
      const response = await fetch(url, { cache: 'reload', credentials: 'same-origin', signal });
      if (response.status !== 200 || !(await response.clone().arrayBuffer()).byteLength) {
        throw new Error('Не удалось сохранить файлы приложения. Проверьте подключение и повторите загрузку.');
      }
      if (url === MANIFEST_URL) validateManifest(await response.clone().json());
      checkAbort(signal);
      await cache.put(url, response);
    }
  }

  async shellAvailable() {
    const cache = await caches.open(SHELL_CACHE);
    const results = await Promise.all(SHELL_ASSETS.map(path => this.shellEntryAvailable(cache, new URL(path, BASE_URL).href)));
    return results.every(Boolean);
  }

  async inspect(paths) {
    if (!this.supported) {
      const status = { cached: 0, total: 0, bytes: 0, totalBytes: 0, complete: false, shellReady: false, supported: false };
      this.onStatus(status);
      return status;
    }
    const files = await this.filesFor(paths);
    const cache = await caches.open(AUDIO_CACHE);
    let cached = 0, bytes = 0;
    for (const file of files) {
      if (await this.validCached(cache, file)) { cached++; bytes += file.bytes; }
    }
    const shellReady = await this.shellAvailable();
    const status = {
      cached, total: files.length, bytes, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      complete: shellReady && cached === files.length, shellReady, supported: true,
    };
    this.onStatus(status);
    return status;
  }

  async download(paths, { signal } = {}) {
    if (!this.supported) throw new Error('Сохранение офлайн доступно в Safari или другом поддерживаемом браузере по HTTPS.');
    if (this.controller) throw new Error('Загрузка уже идёт. Дождитесь её или нажмите «Остановить».');
    checkAbort(signal);
    const controller = new AbortController();
    this.controller = controller;
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    let cached = 0, bytes = 0, total = 0, totalBytes = 0;
    const progress = (phase, currentPath = null) => this.onProgress({
      phase, cached, total, bytes, totalBytes, currentPath,
      percent: totalBytes ? Math.round(bytes * 100 / totalBytes) : 0,
    });
    try {
      const files = await this.filesFor(paths);
      await this.ensureShell({ signal: controller.signal });
      total = files.length;
      totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
      const cache = await caches.open(AUDIO_CACHE);
      const pending = [];
      for (const file of files) {
        checkAbort(controller.signal);
        if (await this.validCached(cache, file)) { cached++; bytes += file.bytes; }
        else pending.push(file);
      }
      progress('checking');
      for (const file of pending) {
        checkAbort(controller.signal);
        progress('downloading', file.path);
        const url = new URL(file.path, BASE_URL).href;
        const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (response.status !== 200) throw new Error(`Не удалось скачать запись Ryan (${response.status}). Повторная загрузка продолжится с сохранённых файлов.`);
        const buffer = await response.arrayBuffer();
        checkAbort(controller.signal);
        if (buffer.byteLength !== file.bytes || await hash(buffer) !== file.sha256.toLowerCase()) {
          throw new Error('Запись Ryan скачалась не полностью или изменилась. Повторите загрузку; повреждённый файл не сохранён.');
        }
        const headers = new Headers(response.headers);
        headers.set('Content-Type', 'audio/mpeg');
        headers.set('Content-Length', String(buffer.byteLength));
        headers.set('Accept-Ranges', 'bytes');
        headers.delete('Content-Encoding');
        headers.delete('Transfer-Encoding');
        await cache.put(url, new Response(buffer, { status: 200, headers }));
        cached++; bytes += file.bytes;
        progress('downloading', file.path);
      }
      checkAbort(controller.signal);
      const status = await this.inspect(paths);
      cached = status.cached; bytes = status.bytes;
      checkAbort(controller.signal);
      if (!status.shellReady) throw new Error('Озвучка сохранена, но файлы приложения ещё не готовы. Откройте приложение с интернетом и повторите проверку.');
      if (!status.complete) throw new Error('Не все записи сохранились на устройстве. Освободите место и повторите загрузку: будут скачаны только недостающие файлы.');
      progress('done');
      return status;
    } catch (error) {
      progress(controller.signal.aborted || error.name === 'AbortError' ? 'cancelled' : 'error');
      if (controller.signal.aborted) throw abortError();
      if (error.name === 'QuotaExceededError') throw new Error('Недостаточно места на устройстве. Удалите часть офлайн-озвучки и повторите загрузку.');
      if (error instanceof TypeError) throw new Error('Сеть недоступна или загрузка прервалась. Повторите; уже сохранённые записи останутся.');
      throw error;
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      this.controller = null;
    }
  }

  cancel() { this.controller?.abort(); }

  async clearAudio(paths) {
    if (!this.supported) return this.inspect();
    if (this.controller) throw new Error('Сначала остановите загрузку озвучки.');
    if (paths == null) await caches.delete(AUDIO_CACHE);
    else {
      const files = await this.filesFor(paths);
      const cache = await caches.open(AUDIO_CACHE);
      await Promise.all(files.map(file => cache.delete(new URL(file.path, BASE_URL).href)));
    }
    return this.inspect(paths);
  }
}
