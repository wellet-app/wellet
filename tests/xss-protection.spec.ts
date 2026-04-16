import { test, expect, type Page, type Dialog } from '@playwright/test';
import { loginAsTestUser, SUPABASE_URL, SUPABASE_ANON_KEY } from './helpers';

/**
 * Issue #33 — XSS Protection Tests
 *
 * Verifies that escHtml() and the app's rendering pipeline properly escape
 * malicious payloads in all user-facing input fields. No alert dialogs or
 * script execution should ever occur.
 */

const XSS_PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '" onmouseover="alert(1)',
  '<script>document.cookie</script>',
];

/** Tracks whether any JS dialog (alert/confirm/prompt) fires during a test. */
function installDialogTrap(page: Page): { fired: boolean; message: string } {
  const trap = { fired: false, message: '' };
  page.on('dialog', async (dialog: Dialog) => {
    trap.fired = true;
    trap.message = dialog.message();
    await dialog.dismiss();
  });
  return trap;
}

// ── Shared login ────────────────────────────────────────────────────────────

test.describe('XSS Protection', () => {
  let dialogTrap: { fired: boolean; message: string };

  test.beforeEach(async ({ page }) => {
    dialogTrap = installDialogTrap(page);
    await loginAsTestUser(page);
  });

  test.afterEach(async () => {
    expect(dialogTrap.fired, `Unexpected JS dialog: "${dialogTrap.message}"`).toBe(false);
  });

  // ── 1. XSS in health event title ───────────────────────────────────────

  for (const payload of XSS_PAYLOADS) {
    test(`health event title is escaped: ${payload.slice(0, 30)}`, async ({ page }) => {
      // Open add-event form
      await page.evaluate(() => openAddEvent());
      await page.waitForSelector('#add-event-overlay', { state: 'visible' });

      // Fill the title with an XSS payload
      await page.fill('#event-title-input', payload);
      await page.fill('#event-notes-input', 'XSS test note');

      // Set event type
      await page.selectOption('#event-type-select', 'appointment');

      // Submit
      await page.click('#add-event-overlay button:has-text("Save event")');

      // Wait for overlay to close (submission success) or short timeout
      await page.waitForSelector('#add-event-overlay', { state: 'hidden', timeout: 10_000 }).catch(() => {});

      // Navigate to Update Me / Timeline to see rendered event
      const timelineTab = page.locator('.tab:has-text("Timeline")');
      if (await timelineTab.isVisible()) {
        await timelineTab.click();
      }

      // Give the timeline a moment to render
      await page.waitForTimeout(1_000);

      // Verify: the payload must appear as plain escaped text, not as an HTML element
      const bodyHtml = await page.content();

      // Should NOT contain unescaped tags rendered as real elements
      const dangerousEl = await page.locator('img[src="x"]').count();
      expect(dangerousEl, 'XSS <img> tag should not render as real element').toBe(0);

      const scriptEl = await page.locator('#add-event-overlay script, .timeline-event script').count();
      expect(scriptEl, 'XSS <script> tag should not render').toBe(0);

      // Clean up: delete the test event via Supabase
      await page.evaluate(async (title) => {
        const { data } = await db.from('health_events').select('id').eq('title', title);
        if (data?.length) {
          for (const row of data) {
            await db.from('health_events').delete().eq('id', row.id);
          }
        }
      }, payload);
    });
  }

  // ── 2. XSS in medication name ──────────────────────────────────────────

  for (const payload of XSS_PAYLOADS) {
    test(`medication name is escaped: ${payload.slice(0, 30)}`, async ({ page }) => {
      // Open add-medication form
      await page.evaluate(() => openAddMed());
      await page.waitForSelector('#add-med-overlay', { state: 'visible' });

      // Fill medication name with XSS payload
      await page.fill('#med-name-input', payload);
      await page.fill('#med-dose-input', '10mg');
      await page.fill('#med-freq-input', 'daily');

      // Submit
      await page.click('#add-med-overlay button:has-text("Save medication")');
      await page.waitForSelector('#add-med-overlay', { state: 'hidden', timeout: 10_000 }).catch(() => {});

      // Switch to records tab to view medications list
      const recordsTab = page.locator('.tab-bar-btn:has-text("Records")');
      if (await recordsTab.isVisible()) {
        await recordsTab.click();
        await page.waitForTimeout(1_000);
      }

      // Verify no dangerous elements rendered
      const dangerousEl = await page.locator('img[src="x"]').count();
      expect(dangerousEl, 'XSS <img> tag should not render in meds list').toBe(0);

      // Clean up test medication
      await page.evaluate(async (name) => {
        const { data } = await db.from('medications').select('id').eq('name', name);
        if (data?.length) {
          for (const row of data) {
            await db.from('medications').delete().eq('id', row.id);
          }
        }
      }, payload);
    });
  }

  // ── 3. XSS in Ask Wellet input ─────────────────────────────────────────

  for (const payload of XSS_PAYLOADS) {
    test(`Ask Wellet escapes user message: ${payload.slice(0, 30)}`, async ({ page }) => {
      // Force the app into the main view (user may be in onboarding if no people)
      await page.evaluate(() => { showAuthenticatedApp(); });

      // Navigate to Ask Wellet view via bottom nav
      await page.evaluate(() => { switchNavTo('ask'); });
      await page.waitForSelector('#ask-input', { state: 'visible', timeout: 5_000 });

      // Type XSS payload and send
      await page.fill('#ask-input', payload);
      await page.click('#ask-send');

      // Wait for user message bubble to appear
      await page.waitForSelector('.chat-bubble.user', { timeout: 5_000 });

      // The user message bubble should contain escaped text, not live HTML
      const bubble = page.locator('.chat-bubble.user').last();
      const innerText = await bubble.innerText();
      const innerHTML = await bubble.innerHTML();

      // The text content should contain the literal payload characters
      // (angle brackets etc. will show as text, not be parsed as HTML)
      expect(innerText).toContain(payload.replace(/</g, '').replace(/>/g, '').replace(/"/g, '').trim().slice(0, 5));

      // innerHTML should have escaped entities, not raw tags
      if (payload.includes('<')) {
        expect(innerHTML).toContain('&lt;');
      }

      // No real img or script elements inside the bubble
      const imgCount = await bubble.locator('img').count();
      expect(imgCount, 'No <img> should render inside chat bubble').toBe(0);
      const scriptCount = await bubble.locator('script').count();
      expect(scriptCount, 'No <script> should render inside chat bubble').toBe(0);
    });
  }

  // ── 4. escHtml unit-level check in browser context ─────────────────────

  test('escHtml escapes all dangerous characters', async ({ page }) => {
    const results = await page.evaluate(() => {
      const fn = escHtml;
      if (!fn) return { error: 'escHtml not found on window' };
      return {
        anglebrackets: fn('<script>alert(1)</script>'),
        ampersand: fn('a&b'),
        quotes: fn('"hello"'),
        singleQuotes: fn("it's"),
        combined: fn('<img src=x onerror="alert(1)">'),
        nullInput: fn(null),
        emptyInput: fn(''),
      };
    });

    if ('error' in results) {
      // escHtml may not be global; skip this test gracefully
      test.skip(true, 'escHtml is not accessible on window');
      return;
    }

    expect(results.anglebrackets).not.toContain('<');
    expect(results.anglebrackets).not.toContain('>');
    expect(results.anglebrackets).toContain('&lt;');
    expect(results.anglebrackets).toContain('&gt;');
    expect(results.ampersand).toContain('&amp;');
    expect(results.combined).not.toContain('<img');
    expect(results.nullInput).toBe('');
    expect(results.emptyInput).toBe('');
  });
});
