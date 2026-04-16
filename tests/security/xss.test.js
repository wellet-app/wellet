// @ts-check
var { test, expect } = require('@playwright/test');

var APP_URL = 'https://mywellet.com';
var QA_EMAIL = 'qa-test-1776217285478@getwellet.com';
var QA_PASSWORD = 'TestPass123!';

/**
 * Helper: sign in using the app's own Supabase client (`db`).
 * Bypasses the alpha allowlist check so the QA test user can log in.
 */
async function loginViaAppClient(page) {
  await page.waitForFunction(function () {
    return typeof db !== 'undefined' && db && db.auth;
  }, { timeout: 15000 });

  // Bypass the alpha allowlist check for the test user
  await page.evaluate(function () {
    window._origCheckAlphaAllowlist = checkAlphaAllowlist;
    checkAlphaAllowlist = async function () { return true; };
  });

  await page.evaluate(async function (creds) {
    var { error } = await db.auth.signInWithPassword({
      email: creds.email,
      password: creds.password,
    });
    if (error) throw new Error('Login failed: ' + error.message);
  }, { email: QA_EMAIL, password: QA_PASSWORD });
}

test.describe('XSS Protection (#33)', function () {
  /** Track if any dialog (alert/confirm/prompt) fires — that means XSS executed */
  var dialogFired;

  test.beforeEach(async function ({ page }) {
    dialogFired = false;
    page.on('dialog', async function (dialog) {
      dialogFired = true;
      await dialog.dismiss();
    });

    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await loginViaAppClient(page);
    await page.waitForSelector('#app', { state: 'visible', timeout: 30000 });
  });

  test('XSS in person name is escaped', async function ({ page }) {
    var xssPayload = '<img src=x onerror=alert(1)>';

    // Inject the XSS payload into the people list and re-render
    await page.evaluate(function (payload) {
      currentPeople.push({
        id: 'xss-test-' + Date.now(),
        name: payload,
        relationship: 'Test',
        avatar_initials: 'XT',
        user_id: currentUser ? currentUser.id : 'test',
      });
      renderPeopleView();
    }, xssPayload);

    // Navigate to People view
    await page.evaluate(function () {
      switchNavTo('people');
    });
    await page.waitForTimeout(500);

    // Verify the payload appears as escaped text, not as an HTML element
    var personCards = await page.locator('.person-card-name').allTextContents();
    var found = personCards.some(function (text) {
      return text.indexOf('<img') !== -1 || text.indexOf('onerror') !== -1;
    });
    expect(found).toBe(true);

    // Verify no <img> element was actually created from the payload
    var imgElements = await page.locator('.person-card-name img').count();
    expect(imgElements).toBe(0);

    // No alert should have fired
    expect(dialogFired).toBe(false);

    // Clean up: remove the test person from memory
    await page.evaluate(function () {
      currentPeople = currentPeople.filter(function (p) {
        return p.id.indexOf('xss-test-') !== 0;
      });
    });
  });

  test('XSS in Ask Wellet input is escaped', async function ({ page }) {
    var xssPayload = '<img/src=x onerror=alert(1)>';

    // Dismiss any overlay modals (e.g. welcome-overlay) that may block interaction
    await page.evaluate(function () {
      var overlays = document.querySelectorAll('.qa-overlay.show');
      overlays.forEach(function (el) { el.classList.remove('show'); });
    });

    // Navigate to Ask Wellet view
    await page.evaluate(function () {
      switchNavTo('ask');
    });
    await page.waitForTimeout(500);

    // Use addUserMessage directly to test the escaping output path.
    // This is the same function that sendAskMessage calls with the user's text.
    await page.evaluate(function (payload) {
      addUserMessage(payload);
    }, xssPayload);
    await page.waitForTimeout(300);

    // The user message bubble should show escaped text
    var userBubbles = await page.locator('.chat-bubble.user').allTextContents();
    var lastBubble = userBubbles[userBubbles.length - 1];
    expect(lastBubble).toContain('<img');
    expect(lastBubble).toContain('onerror');

    // No <img> element should exist inside chat bubbles
    var imgInBubbles = await page.locator('.chat-bubble.user img').count();
    expect(imgInBubbles).toBe(0);

    // No alert should have fired
    expect(dialogFired).toBe(false);
  });

  test('XSS in medication name is escaped', async function ({ page }) {
    var xssPayload = '" onmouseover="alert(1)';

    // Inject a medication with XSS payload into liveMeds (must have active: true)
    // and re-render the records view
    await page.evaluate(function (payload) {
      liveMeds.push({
        id: 'xss-med-test-' + Date.now(),
        person_id: currentPersonId,
        name: payload,
        dose: '10mg',
        frequency: 'daily',
        active: true,
      });
    }, xssPayload);

    // Navigate to records view and re-render
    await page.evaluate(function () {
      switchNavTo('records');
      renderRecordsView();
    });
    await page.waitForTimeout(500);

    // The medication name renders in .record-label inside the records view
    var recordLabels = await page.locator('#view-records .record-label').allTextContents();
    var foundXss = recordLabels.some(function (text) {
      return text.indexOf('onmouseover') !== -1;
    });
    expect(foundXss).toBe(true);

    // No alert should have fired
    expect(dialogFired).toBe(false);

    // Clean up
    await page.evaluate(function () {
      liveMeds = liveMeds.filter(function (m) {
        return !m.id || m.id.indexOf('xss-med-test-') !== 0;
      });
    });
  });

  test('XSS in health event title is escaped', async function ({ page }) {
    var xssPayload = '<script>document.cookie</script>';

    // Inject an event with XSS title into liveEvents and re-render
    // Events render in the home view under tab-timeline
    await page.evaluate(function (payload) {
      liveEvents.push({
        id: 'xss-event-test-' + Date.now(),
        person_id: currentPersonId,
        title: payload,
        event_date: new Date().toISOString().split('T')[0],
        notes: '',
      });
    }, xssPayload);

    // Navigate to the home view and re-render timeline
    await page.evaluate(function () {
      switchNavTo('home');
      renderTimeline();
    });
    await page.waitForTimeout(500);

    // Check that no <script> element was actually created in the timeline pane
    var scriptTags = await page.evaluate(function () {
      var pane = document.getElementById('tab-timeline');
      if (!pane) return 0;
      return pane.querySelectorAll('script').length;
    });
    expect(scriptTags).toBe(0);

    // The event title renders in .tl-card-title — check it contains escaped text
    var titleTexts = await page.locator('.tl-card-title').allTextContents();
    var foundEscaped = titleTexts.some(function (text) {
      // The literal <script> tags should appear as text (escaped by escHtml)
      return text.indexOf('document.cookie') !== -1;
    });
    expect(foundEscaped).toBe(true);

    // Also verify that the inner HTML does NOT contain a raw <script> tag
    var tabTimeline = page.locator('#tab-timeline');
    var timelineHtml = await tabTimeline.innerHTML();
    var hasRawScript = timelineHtml.indexOf('<script>document.cookie</script>') !== -1;
    expect(hasRawScript).toBe(false);

    // No alert should have fired
    expect(dialogFired).toBe(false);

    // Clean up
    await page.evaluate(function () {
      liveEvents = liveEvents.filter(function (e) {
        return !e.id || e.id.indexOf('xss-event-test-') !== 0;
      });
    });
  });

  test('XSS in feedback form does not execute', async function ({ page }) {
    var xssPayload = '<img src=x onerror=alert(document.cookie)>';

    // Open feedback sheet
    await page.evaluate(function () {
      openFeedbackSheet();
    });
    await page.waitForSelector('#feedback-overlay.show', { timeout: 5000 });

    // Enter XSS payload in feedback textarea
    await page.locator('#feedback-text').fill(xssPayload);

    // Verify the textarea value is the raw string (not interpreted as HTML)
    var textareaValue = await page.locator('#feedback-text').inputValue();
    expect(textareaValue).toBe(xssPayload);

    // The textarea should not have caused any script execution
    expect(dialogFired).toBe(false);

    // Close without submitting to avoid side effects
    await page.evaluate(function () {
      closeSheet('feedback-overlay');
    });
  });
});
