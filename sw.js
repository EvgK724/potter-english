/* Bump the shell version whenever app files change in a published release. */
const SHELL_CACHE = 'hp-pocket-shell-v3';
const AUDIO_CACHE = 'hp-pocket-audio-v1';
const BASE = new URL('./', self.location.href);
const SHELL_ASSETS = [
  './', 'index.html', 'styles.css', 'app.js', 'engine.js', 'data.js',
  'offline.js', 'manifest.webmanifest', 'icons/icon-192.png',
  'icons/icon-512.png', 'icons/icon-maskable.png', 'icons/apple-touch-icon.png', 'audio/manifest.json',
];
const SHELL_URLS = new Set(SHELL_ASSETS.map(path => new URL(path, BASE).href));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll([...SHELL_URLS].map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name =>
      (name.startsWith('hp-pocket-shell-') || name.startsWith('hp-pocket-audio-'))
      && name !== SHELL_CACHE && name !== AUDIO_CACHE,
    ).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

function unavailable() {
  return new Response('Запись ещё не скачана для офлайн. Подключитесь к интернету и сохраните озвучку.', {
    status: 503, statusText: 'Offline file unavailable', headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

async function audioResponse(request, cached) {
  const range = request.headers.get('range');
  if (!range) return cached;
  const buffer = await cached.arrayBuffer();
  const size = buffer.byteLength;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  const invalid = () => new Response(null, {
    status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
  });
  if (!match || (!match[1] && !match[2]) || !size) return invalid();
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid();
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return invalid();
    end = Math.min(end, size - 1);
  }
  const headers = new Headers(cached.headers);
  headers.set('Content-Type', 'audio/mpeg');
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  headers.delete('Content-Encoding');
  return new Response(buffer.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  const relative = url.pathname.slice(BASE.pathname.length);
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) return response;
      } catch { /* Serve the previously saved shell. */ }
      return await (await caches.open(SHELL_CACHE)).match(new URL('index.html', BASE).href)
        || new Response('Приложение ещё не сохранено. Откройте его один раз с интернетом.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    })());
    return;
  }
  if (/^audio\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.mp3$/.test(relative) && !relative.includes('..')) {
    event.respondWith((async () => {
      const cached = await (await caches.open(AUDIO_CACHE)).match(new URL(relative, BASE).href);
      if (cached) return audioResponse(request, cached);
      try { return await fetch(request); } catch { return unavailable(); }
    })());
    return;
  }
  const canonical = new URL(url.pathname, BASE.origin).href;
  if (SHELL_URLS.has(canonical)) {
    event.respondWith((async () => {
      const cached = await (await caches.open(SHELL_CACHE)).match(canonical);
      if (cached) return cached;
      try { return await fetch(request); } catch { return unavailable(); }
    })());
  }
});
