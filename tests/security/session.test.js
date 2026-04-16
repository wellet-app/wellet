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
  // Wait for the app's Supabase client to be ready
  await page.waitForFunction(function () {
    return typeof db !== 'undefined' && db && db.auth;
  }, { timeout: 15000 });

  // Bypass the alpha allowlist check for the test user
  await page.evaluate(function () {
    window._origCheckAlphaAllowlist = checkAlphaAllowlist;
    checkAlphaAllowlist = async function () { return true; };
  });

  // Sign in via the app's db client — triggers onAuthStateChange
  await page.evaluate(async function (creds) {
    var { error } = await db.auth.signInWithPassword({
      email: creds.email,
      password: creds.password,
    });
    if (error) throw new Error('Login failed: ' + error.message);
  }, { email: QA_EMAIL, password: QA_PASSWORD });
}

test.describe('PHI Clearing + Session Timeout (#32)', function () {
  test('localStorage PHI keys are cleared on logout', async function ({ page }) {
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await loginViaAppClient(page);

    // Wait for the app to load after auth state change
    await page.waitForSelector('#app', { state: 'visible', timeout: 30000 });

    // Seed PHI keys in localStorage to simulate cached data
    await page.evaluate(function () {
      localStorage.setItem('wellet_ehr_person123', JSON.stringify({ data: { test: true }, synced_at: new Date().toISOString() }));
      localStorage.setItem('wellet_er_brief_person123', JSON.stringify({ text: 'Brief text', timestamp: Date.now() }));
    });

    // Verify PHI keys exist
    var phiKeysBefore = await page.evaluate(function () {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && (k.indexOf('wellet_ehr_') === 0 || k.indexOf('wellet_er_brief_') === 0)) {
          keys.push(k);
        }
      }
      return keys;
    });
    expect(phiKeysBefore.length).toBeGreaterThanOrEqual(2);

    // Trigger logout via the app's handleLogout function
    await page.evaluate(function () {
      handleLogout();
    });

    // Wait for auth screen to appear (indicates logout completed)
    await page.waitForSelector('#auth-screen', { state: 'visible', timeout: 10000 });

    // Verify PHI keys are gone
    var phiKeysAfter = await page.evaluate(function () {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && (k.indexOf('wellet_ehr_') === 0 || k.indexOf('wellet_er_brief_') === 0)) {
          keys.push(k);
        }
      }
      return keys;
    });
    expect(phiKeysAfter).toHaveLength(0);
  });

  test('15-minute inactivity timeout triggers logout', async function ({ page }) {
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await loginViaAppClient(page);

    // Wait for app to load
    await page.waitForSelector('#app', { state: 'visible', timeout: 30000 });

    // Fast-forward the inactivity timer by setting a very short limit
    // and restarting the timer
    await page.evaluate(function () {
      // Clear the existing inactivity timer
      if (_inactivityTimer) clearTimeout(_inactivityTimer);

      // Set limit to 100ms so it fires almost immediately
      INACTIVITY_LIMIT_MS = 100;

      // Restart the timer with the short limit
      resetInactivityTimer();
    });

    // Wait for the auth screen to appear (indicates timeout-triggered logout)
    await page.waitForSelector('#auth-screen', { state: 'visible', timeout: 10000 });

    // Verify we're on the login screen
    var authVisible = await page.isVisible('#auth-screen');
    expect(authVisible).toBe(true);
  });

  test('in-memory caches cleared after logout', async function ({ page }) {
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await loginViaAppClient(page);

    // Wait for app to load
    await page.waitForSelector('#app', { state: 'visible', timeout: 30000 });

    // Seed in-memory caches
    await page.evaluate(function () {
      ehrCache['testPerson'] = { data: { test: true }, synced_at: new Date().toISOString() };
      _emergencyBriefCache['testPerson'] = { text: 'Test brief', timestamp: Date.now() };
    });

    // Trigger logout
    await page.evaluate(function () {
      handleLogout();
    });

    // Wait for auth screen
    await page.waitForSelector('#auth-screen', { state: 'visible', timeout: 10000 });

    // Verify in-memory caches are empty
    var caches = await page.evaluate(function () {
      return {
        ehrCacheKeys: Object.keys(ehrCache),
        briefCacheKeys: Object.keys(_emergencyBriefCache),
      };
    });
    expect(caches.ehrCacheKeys).toHaveLength(0);
    expect(caches.briefCacheKeys).toHaveLength(0);
  });
});
