import { type Page } from '@playwright/test';

export const SUPABASE_URL = 'https://nrpdhxygzyfmyljzfexv.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5ycGRoeHlnenlmbXlsanpmZXh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NTQ3MjUsImV4cCI6MjA5MTMzMDcyNX0.6gdj1hlW2UAc3gJOyjPJBeBJWth_Fcc5C5LH9zWyDXU';

export const QA_USER = {
  email: 'qa-test-1776217285478@getwellet.com',
  password: 'TestPass123!',
  id: '8c7e632f-1743-479d-9c27-da018837e60d',
};

/**
 * Login the QA test user and initialize the app's authenticated state.
 *
 * The app has an alpha allowlist gate that signs out users not on the list.
 * Instead of reloading (which triggers initApp → checkAlphaAllowlist → signOut),
 * we sign in via the app's `db` client, then manually set currentUser and call
 * loadUserData() to initialize the authenticated view directly.
 */
export async function loginAsTestUser(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  // Wait for the app's Supabase client and initApp to finish
  await page.waitForFunction(
    () => {
      try { return typeof db !== 'undefined' && !!db.auth && typeof loadUserData === 'function'; }
      catch { return false; }
    },
    { timeout: 15_000 },
  );

  // Sign in and manually initialize the authenticated app state
  const loginResult = await page.evaluate(
    async ({ email, password }) => {
      // Sign in via the app's own Supabase client
      const { data, error } = await db.auth.signInWithPassword({ email, password });
      if (error) return { error: error.message };

      // Manually set the app's global state (bypasses allowlist check)
      currentUser = data.user;
      await loadUserData();

      return { success: true };
    },
    { email: QA_USER.email, password: QA_USER.password },
  );

  if ((loginResult as any).error) {
    throw new Error(`Login failed: ${(loginResult as any).error}`);
  }

  // Wait for the app to render authenticated content
  await page.waitForFunction(
    () => {
      const auth = document.getElementById('auth-screen');
      const app = document.getElementById('app');
      return (auth && auth.style.display === 'none') ||
             (app && getComputedStyle(app).display !== 'none');
    },
    { timeout: 15_000 },
  );
}
