/** Real v1 -> v2 service-worker update; no source material or live service is used. */
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const EVIDENCE = path.join(ROOT, 'evidence');
const OLD = 'd81bc577d350711070d4ec34cc7b771035f399c5';
const BASE = 'http://127.0.0.1:4177/potter-english/';
const WIDTHS = [320, 390, 430, 440, 480, 760, 820, 1280];
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.mp3': 'audio/mpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const oldFiles = new Map();
const report = [];
let release = 'old', disconnected = false, browser;

function oldFile(name) {
  if (!oldFiles.has(name)) oldFiles.set(name, execFileSync('git', ['show', `${OLD}:${name}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }));
  return oldFiles.get(name);
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const server = http.createServer((req, res) => {
  if (disconnected) { req.socket.destroy(); return; }
  try {
    const url = new URL(req.url, BASE);
    if (!url.pathname.startsWith('/potter-english/')) { res.writeHead(404); res.end(); return; }
    const name = decodeURIComponent(url.pathname.slice('/potter-english/'.length)) || 'index.html';
    const file = path.resolve(DIST, name);
    if (!file.startsWith(DIST + path.sep)) { res.writeHead(403); res.end(); return; }
    const bytes = release === 'old' ? oldFile(name) : fs.readFileSync(file);
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});

async function snapshot(page) {
  return page.evaluate(async () => {
    const cache = await caches.open('hp-pocket-audio-v1');
    const audio = [];
    for (const req of await cache.keys()) {
      const response = await cache.match(req);
      const bytes = await response.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      audio.push({ path: new URL(req.url).pathname, bytes: bytes.byteLength, sha256: hash });
    }
    audio.sort((a, b) => a.path.localeCompare(b.path));
    const external = await (await caches.open('englex-pocket-v1')).match(new URL('englex-sentinel', location.href));
    return { progress: localStorage.getItem('potter-english-v1'), audio, external: external ? await external.text() : null };
  });
}

async function noOverflow(page, label) {
  const result = await page.evaluate(() => {
    const dialog = document.querySelector('#detail-dialog');
    return {
      page: document.documentElement.scrollWidth - innerWidth,
      dialog: dialog.open ? dialog.scrollWidth - dialog.clientWidth : 0,
      study: [...document.querySelectorAll('.card-phrase,.card-meaning,.detail-meaning,.example-text,.example-translation,.note-box,.meaning-prompt')]
        .filter(el => el.getClientRects().length && el.closest('[hidden]') === null)
        .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => `${el.className}: ${el.scrollWidth}/${el.clientWidth}`),
    };
  });
  assert.ok(result.page <= 1, `${label}: page horizontal overflow ${result.page}; study ${JSON.stringify(result.study)}`);
  assert.ok(result.dialog <= 1, `${label}: dialog horizontal overflow ${result.dialog}`);
  assert.deepEqual(result.study, [], `${label}: clipped study text`);
}

async function navGeometry(page, width, safeBottom = 0) {
  if (width > 760) return;
  const geometry = await page.evaluate(() => {
    const bar = document.querySelector('.sidebar');
    const rect = bar.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('#navigation button')].map(el => {
      const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, bottom: r.bottom };
    });
    return { bottom: rect.bottom, viewport: innerHeight, padding: parseFloat(getComputedStyle(bar).paddingBottom), buttons };
  });
  assert.ok(Math.abs(geometry.bottom - geometry.viewport) <= 1, `nav bottom at viewport, ${width}`);
  assert.ok(Math.abs(geometry.padding - safeBottom) <= 1, `safe bottom ${width}: expected ${safeBottom}, got ${geometry.padding}`);
  for (const button of geometry.buttons) {
    assert.ok(button.height >= 44 && button.width >= 44, `nav touch target ${width}`);
    assert.ok(button.bottom <= geometry.viewport - safeBottom + 1, `home indicator space ${width}`);
  }
}

async function reachable(page, selector, { dialog = false } = {}) {
  const locator = page.locator(selector).last();
  await locator.scrollIntoViewIfNeeded();
  if (!dialog) await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const rect = await locator.boundingBox();
  assert.ok(rect && rect.width >= 1 && rect.height >= 1, `${selector}: visible`);
  const hit = await locator.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const target = document.elementFromPoint(x, y);
    return y >= 0 && y <= innerHeight && (target === el || el.contains(target));
  });
  assert.ok(hit, `${selector}: reachable, not covered by bottom navigation`);
}

async function openCard(page, card) {
  await page.locator('[data-view="library"]').click();
  await page.locator('#search').fill(card.phrase);
  await page.locator(`[data-open="${card.id}"]`).click();
  await page.locator('#detail-dialog').waitFor({ state: 'visible' });
}

async function enlargeStudy(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.card-phrase,.card-meaning,.detail-meaning,.example-text,.example-translation,.note-box,.meaning-prompt')) {
      if (el.getClientRects().length && !el.dataset.enlargedForTest) {
        el.style.fontSize = `${parseFloat(getComputedStyle(el).fontSize) * 2}px`;
        el.dataset.enlargedForTest = 'true';
      }
    }
  });
}

(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  // UI-only release must retain public content and exact voice catalogue.
  for (const name of ['data.js', 'audio/manifest.json']) {
    assert.equal(digest(fs.readFileSync(path.join(DIST, name))), digest(oldFile(name)), `${name} unchanged since v1`);
  }
  assert.match(fs.readFileSync(path.join(DIST, 'sw.js'), 'utf8'), /hp-pocket-shell-v2/);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4177, '127.0.0.1', resolve); });
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    console.log(`${name}: install v1 and save progress/chapter17`);
    release = 'old'; disconnected = false;
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      const Original = window.Audio;
      window.Audio = function (...args) { const audio = new Original(...args); window.__testAudio = audio; return audio; };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('.expression-card').length > 0 && !!navigator.serviceWorker.controller);
    assert.equal(await page.locator('.card-meaning').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize)), 18, 'old CSS loaded');
    const cards = await page.evaluate(async () => (await import('./data.js')).BOOK_CARDS);
    await page.locator('[data-star]').first().click();
    await page.locator('#start-practice').click();
    await page.locator('#reveal-answer').click();
    await page.locator('[data-review="later"]').click();
    await page.locator('[data-view="offline"]').click();
    await page.locator('#offline-chapter').selectOption('17');
    await page.locator('#download-all').click();
    await page.waitForFunction(() => document.querySelector('#offline-status').textContent.startsWith('Готово офлайн') && !document.querySelector('#download-all').disabled, null, { timeout: 180000 });
    await page.evaluate(async () => (await caches.open('englex-pocket-v1')).put(new URL('englex-sentinel', location.href), new Response('unrelated-app-cache-preserved')));
    const before = await snapshot(page);
    const saved = JSON.parse(before.progress);
    assert.ok(saved.bookmarks.length > 0 && Object.keys(saved.reviews).length > 0, 'real UI progress seeded');
    const chapterPaths = new Set(cards.filter(card => card.chapters.includes(17)).flatMap(card => [card.audioPhrase, card.audioExample]));
    assert.equal(before.audio.length, chapterPaths.size, 'chapter audio only');

    console.log(`${name}: activate v2; verify existing data and audio`);
    release = 'new';
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const previous = registration.active;
      await registration.update();
      const next = registration.installing || registration.waiting || (registration.active !== previous ? registration.active : null);
      if (!next) throw new Error('Updated worker not found');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Updated worker did not activate and claim the page')), 60000);
        function finish(error) {
          clearTimeout(timer); next.removeEventListener('statechange', check); navigator.serviceWorker.removeEventListener('controllerchange', check);
          error ? reject(error) : resolve();
        }
        function check() {
          if (next.state === 'redundant') finish(new Error('Updated worker became redundant'));
          else if (next.state === 'activated' && navigator.serviceWorker.controller === next) finish();
        }
        next.addEventListener('statechange', check); navigator.serviceWorker.addEventListener('controllerchange', check); check();
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[data-view="library"]').click();
    const updatedMeaning = await page.locator('.card-meaning').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    if (updatedMeaning !== 20) console.log('CSS update diagnostic', await page.evaluate(async () => {
      const stored = await (await caches.open('hp-pocket-shell-v2')).match(new URL('styles.css', location.href));
      return { cacheNames: await caches.keys(), storedNewCSS: stored && (await stored.text()).includes('.card-meaning{font-size:20px}'), fetchedNewCSS: (await (await fetch('styles.css')).text()).includes('.card-meaning{font-size:20px}'), sheetLastRules: [...document.styleSheets[0].cssRules].slice(-10).map(rule => rule.cssText) };
    }));
    assert.equal(updatedMeaning, 20, 'new CSS loaded');
    assert.deepEqual(await snapshot(page), before, 'upgrade preserves byte-identical progress and all downloaded audio');
    assert.ok(!(await page.evaluate(() => caches.has('hp-pocket-shell-v1'))), 'obsolete shell removed');

    disconnected = true;
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('.expression-card').length > 0);
    assert.equal(await page.locator('.card-meaning').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize)), 20, 'updated UI works with HTTP server disconnected');
    const chapterCard = cards.find(card => card.chapters.includes(17));
    await openCard(page, chapterCard);
    for (const kind of ['phrase', 'example']) {
      await page.locator(`#detail-content [data-kind="${kind}"]`).click();
      await page.waitForFunction(() => window.__testAudio?.currentTime > .1 && !window.__testAudio.paused);
    }
    assert.equal(await page.locator('.audio-error').count(), 0, 'downloaded Ryan plays after offline update');
    await page.locator('#close-dialog').click();
    assert.deepEqual(await snapshot(page), before, 'offline reload retains progress and audio');
    const reopen = await context.newPage();
    await reopen.goto(BASE, { waitUntil: 'load' });
    await reopen.waitForFunction(() => document.querySelectorAll('.expression-card').length > 0);
    assert.equal(await reopen.locator('.card-meaning').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize)), 20, 'new offline tab uses v2');
    await reopen.close();

    const longest = [...new Map(['phrase', 'meaning', 'example'].map(field => {
      const card = cards.reduce((a, b) => a[field].length >= b[field].length ? a : b); return [card.id, card];
    })).values()];
    console.log(`${name}: mobile layout, long cards, safe area, enlarged text`);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('[data-view="library"]').click();
      await page.locator('#search').fill('');
      await noOverflow(page, `${name} ${width}`);
      await navGeometry(page, width);
      assert.equal(await page.locator('.card-meaning').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize)), 20, `meaning ${width}`);
      await reachable(page, '#load-more');
      for (const card of longest) {
        await openCard(page, card);
        await noOverflow(page, `${name} long ${card.id} at ${width}`);
        const exampleSize = await page.locator('#detail-content .example-text').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
        assert.equal(exampleSize, width <= 480 ? 18 : 19, `example ${width}`);
        await reachable(page, '#detail-content [data-kind="example"]', { dialog: true });
        await page.locator('#close-dialog').click();
      }
    }
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => document.documentElement.style.setProperty('--safe-bottom', '34px'));
      await navGeometry(page, width, 34);
      await page.locator('[data-view="library"]').click(); await page.locator('#search').fill('');
      await reachable(page, '#load-more');
      await page.locator('[data-view="book"]').click(); await reachable(page, '#export-progress');
      await page.locator('[data-view="offline"]').click(); await reachable(page, '#playback-rate');
      await page.locator('[data-view="practice"]').click();
      if (await page.locator('#reveal-answer').getAttribute('aria-expanded') !== 'true') await page.locator('#reveal-answer').click();
      await reachable(page, '[data-review="later"]');
      await noOverflow(page, `${name} safe-area practice ${width}`);
      await page.locator('[data-view="library"]').click(); await page.locator('#search').fill('');
      if (width !== 320) {
        await page.locator('.expression-card').first().evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 110));
        await page.screenshot({ path: path.join(EVIDENCE, `ui-update-${name}-${width}-cards.png`), fullPage: false, animations: 'disabled' });
        await openCard(page, longest[0]);
        await page.locator('#detail-dialog').evaluate(el => { el.scrollTop = 0; });
        await page.screenshot({ path: path.join(EVIDENCE, `ui-update-${name}-${width}-dialog.png`), fullPage: false, animations: 'disabled' });
        await page.locator('#close-dialog').click();
      }
    }
    await page.setViewportSize({ width: 320, height: 844 });
    await page.locator('[data-view="library"]').click(); await page.locator('#search').fill('');
    await enlargeStudy(page); await noOverflow(page, `${name} 200% study text library`); await reachable(page, '#load-more');
    for (const card of longest) {
      await openCard(page, card); await enlargeStudy(page); await noOverflow(page, `${name} 200% long dialog ${card.id}`);
      await reachable(page, '#detail-content [data-kind="example"]', { dialog: true });
      await page.locator('#close-dialog').click();
    }
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
    assert.ok(!/user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=\s*1(?:\D|$)/i.test(viewport), 'browser zoom remains allowed');
    assert.deepEqual(await snapshot(page), before, 'layout/reading checks leave existing state intact');
    assert.deepEqual(errors, [], 'no page errors');
    report.push({ browser: name, previousRelease: OLD, previousShell: 'hp-pocket-shell-v1', newShell: 'hp-pocket-shell-v2', audioCache: 'hp-pocket-audio-v1', cards: cards.length, chapter17Audio: before.audio.length, progressByteIdentical: true, audioPathsBytesAndSha256Identical: true, englexCachePreserved: true, physicalServerDisconnect: true, offlineReload: true, offlineNewTab: true, offlinePhraseAndExamplePlayback: true, widths: WIDTHS, meaning20px: true, examples18pxMobile19pxWide: true, longCardIds: longest.map(card => card.id), bottomNavAtViewportEdge: true, safeBottom34pxSimulated: true, navTargetsAtLeast44px: true, finalControlsReachable: true, studyText200Percent: true, browserZoomAllowed: true, hardwareInstallTested: false, pageErrors: errors });
    await browser.close(); browser = null;
    fs.writeFileSync(path.join(EVIDENCE, 'ui-update-report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
