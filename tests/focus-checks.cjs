/** Focus regression only. Runs inside the caller's isolated, touch-enabled context. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function focusState(page, label) {
  return page.evaluate(label => {
    const main = document.querySelector('#main'), active = document.activeElement;
    const outline = el => {
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor };
    };
    return {
      label, mainFocus: active === main, mainFocusVisible: main.matches(':focus-visible'),
      mainPointerFlag: main.hasAttribute('data-pointer-focus'), mainOutline: outline(main),
      active: { tag: active.tagName, id: active.id, className: active.className,
        focusVisible: active.matches(':focus-visible'), outline: outline(active), inMain: main.contains(active) },
      scrollY, hash: location.hash,
    };
  }, label);
}
const visibleOutline = value => value.style !== 'none' && value.width > 0;
function noMainOutline(value) {
  assert.ok(!visibleOutline(value.mainOutline), `${value.label}: unexpected main outline ${JSON.stringify(value)}`);
  assert.equal(value.mainPointerFlag, true, `${value.label}: pointer flag retained`);
}

async function checkFocus(page, { browserName, evidenceDir }) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const before = await page.evaluate(() => localStorage.getItem('potter-english-v1'));
  const steps = [await focusState(page, 'initial updated page')];
  const errors = [];
  const recordError = error => errors.push(error.message);
  page.on('pageerror', recordError);
  let keyboardPage;
  const url = new URL(page.url()); url.hash = 'library';
  await page.setViewportSize({ width: 430, height: 932 });
  const recordTouch = async label => {
    const value = await focusState(page, label); steps.push(value); noMainOutline(value); return value;
  };
  try {
    await page.locator('[data-view="library"]').tap();
    await page.locator('.hero-description').tap();
    assert.equal((await recordTouch('touch noninteractive hero')).mainFocus, true, 'actual main focus after text tap');
    await page.locator('[data-open]').first().tap();
    await page.locator('#close-dialog').tap();
    await page.locator('#detail-dialog').waitFor({ state: 'hidden' });
    await recordTouch('touch close native dialog');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(evidenceDir, `focus-fixed-${browserName}-430.png`), animations: 'disabled' });

    await page.locator('[data-open]').first().tap();
    const outside = await page.locator('#detail-dialog').evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.left > 2 ? { x: 1, y: Math.max(1, Math.min(innerHeight - 1, r.top + 20)) } : { x: innerWidth / 2, y: 1 };
    });
    await page.touchscreen.tap(outside.x, outside.y);
    await page.locator('#detail-dialog').waitFor({ state: 'hidden' });
    await recordTouch('touch dialog backdrop');
    await page.locator('.hero-description').tap();
    await recordTouch('further text tap after native restoration');
    for (const view of ['library', 'practice', 'book', 'offline']) {
      await page.locator(`[data-view="${view}"]`).tap();
      await page.locator(view === 'library' ? '.hero-description' : `#view-${view} .page-lead`).tap();
      assert.equal((await recordTouch(`touch ${view} content`)).mainFocus, true);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await recordTouch(`scroll ${view} content`);
    }

    const keyboardAttempts = [];
    async function freshKeyboardPage(key) {
      if (keyboardPage) await keyboardPage.close();
      keyboardPage = await page.context().newPage();
      keyboardPage.on('pageerror', recordError);
      await keyboardPage.setViewportSize({ width: 430, height: 932 });
      await keyboardPage.goto(url.href, { waitUntil: 'load' });
      await keyboardPage.waitForFunction(() => document.querySelectorAll('.expression-card').length > 0);
      await keyboardPage.keyboard.press(key);
      const state = await focusState(keyboardPage, `fresh page ${key}`);
      keyboardAttempts.push({ keys: [key], state });
      return keyboardPage.locator('.skip').evaluate(el => el === document.activeElement);
    }
    let skipKey = 'Tab', reachedSkip = await freshKeyboardPage(skipKey);
    if (!reachedSkip && browserName === 'webkit') {
      skipKey = 'Alt+Tab'; reachedSkip = await freshKeyboardPage(skipKey);
    }
    assert.ok(reachedSkip, `real keyboard did not reach skip-link: ${JSON.stringify(keyboardAttempts)}`);
    const skipState = await focusState(keyboardPage, `skip-link focused via ${skipKey}`);
    assert.ok(visibleOutline(skipState.active.outline), 'skip-link keyboard indicator visible');
    await keyboardPage.keyboard.press('Enter');
    const skipTarget = await focusState(keyboardPage, 'keyboard skip-link Enter'); steps.push(skipTarget);
    assert.equal(skipTarget.mainFocus, true, 'skip-link transfers actual focus to main');
    assert.equal(skipTarget.mainPointerFlag, false, 'keyboard clears pointer suppression');
    assert.ok(visibleOutline(skipTarget.mainOutline), 'main keyboard focus remains visible');
    await keyboardPage.screenshot({ path: path.join(evidenceDir, `focus-keyboard-${browserName}-430.png`), animations: 'disabled' });
    await keyboardPage.keyboard.press('Tab');
    const next = await focusState(keyboardPage, 'actual Tab after skip-link'); steps.push(next);
    assert.equal(next.active.tag, 'BUTTON', 'next Tab reaches a real button');
    assert.equal(next.active.inMain, true, 'next Tab stays in skipped-to content');
    assert.ok(next.active.focusVisible && visibleOutline(next.active.outline), 'existing button keyboard focus visible');
    await keyboardPage.locator('.hero-description').tap();
    const pointerAgain = await focusState(keyboardPage, 'touch after keyboard'); steps.push(pointerAgain);
    assert.equal(pointerAgain.mainFocus, true); noMainOutline(pointerAgain);
    assert.equal(await page.evaluate(() => localStorage.getItem('potter-english-v1')), before, 'focus checks do not change stored progress');
    assert.deepEqual(errors, [], 'focus checks have no page errors');
    return { browser: browserName, touchDialogClose: true, touchBackdropClose: true, fourNavTabs: true,
      scrollWithoutMainOutline: true, keyboardAttempts, skipLinkKey: skipKey, skipLinkTransfersFocus: true,
      keyboardMainOutline: true, actualTabButtonOutline: true, pointerAfterKeyboardHidesMainOutline: true,
      storedProgressByteIdentical: true, steps, pageErrors: errors };
  } finally {
    page.off('pageerror', recordError);
    if (keyboardPage) await keyboardPage.close();
  }
}

module.exports = { checkFocus };
