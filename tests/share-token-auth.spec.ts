import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, QA_USER } from './helpers';

/**
 * Issue #31 — Share Token Auth Tests
 *
 * Verifies the RLS policies and get_share_by_token() function:
 * 1. Anon users cannot SELECT directly from the shares table
 * 2. get_share_by_token(valid_token) returns a share
 * 3. get_share_by_token(invalid_token) returns empty
 * 4. get_share_by_token(expired_token) returns empty
 * 5. Authenticated users can see their own shares but not others'
 *
 * These tests use the Supabase JS client directly (not Playwright browser)
 * to test database-level security policies.
 */

let anonClient: SupabaseClient;
let authedClient: SupabaseClient;
let testShareToken: string | null = null;
let testShareId: string | null = null;
let expiredShareToken: string | null = null;
let expiredShareId: string | null = null;
let createdPersonId: string | null = null; // track if we created a test person

test.beforeAll(async () => {
  // Create anon client (no auth)
  anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Create authenticated client for the QA test user
  authedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: authError } = await authedClient.auth.signInWithPassword({
    email: QA_USER.email,
    password: QA_USER.password,
  });
  if (authError) throw new Error(`Auth failed: ${authError.message}`);

  // Fetch (or create) a person for this user to create test shares against
  const { data: people } = await authedClient
    .from('people')
    .select('id, name')
    .limit(1);

  let testPerson: { id: string; name: string };

  if (people?.length) {
    testPerson = people[0];
  } else {
    // Create a test person so we can create shares (user_id required by RLS)
    const { data: newPerson, error: personError } = await authedClient
      .from('people')
      .insert({
        user_id: QA_USER.id,
        name: 'Test Person (QA)',
        relationship: 'other',
        avatar_initials: 'TP',
        sort_order: 0,
      })
      .select('id, name')
      .single();
    if (personError) throw new Error(`Failed to create test person: ${personError.message}`);
    testPerson = newPerson;
    createdPersonId = newPerson.id;
  }

  // Create a valid (non-expired) test share
  const validToken = 'test_valid_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const { data: validShare, error: insertError } = await authedClient
    .from('shares')
    .insert({
      token: validToken,
      user_id: QA_USER.id,
      person_id: testPerson.id,
      person_name: testPerson.name || 'Test Person',
      summary_text: 'Test share for integration testing',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single();

  if (insertError) throw new Error(`Failed to create test share: ${insertError.message}`);
  testShareToken = validShare.token;
  testShareId = validShare.id;

  // Create an expired test share
  const expToken = 'test_exp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const { data: expShare, error: expError } = await authedClient
    .from('shares')
    .insert({
      token: expToken,
      user_id: QA_USER.id,
      person_id: testPerson.id,
      person_name: testPerson.name || 'Test Person',
      summary_text: 'Expired test share',
      expires_at: new Date(Date.now() - 60 * 1000).toISOString(), // 1 minute ago
    })
    .select()
    .single();

  if (expError) throw new Error(`Failed to create expired share: ${expError.message}`);
  expiredShareToken = expShare.token;
  expiredShareId = expShare.id;
});

test.afterAll(async () => {
  // Clean up test shares
  if (testShareId) {
    await authedClient.from('shares').delete().eq('id', testShareId);
  }
  if (expiredShareId) {
    await authedClient.from('shares').delete().eq('id', expiredShareId);
  }
  // Clean up test person if we created one
  if (createdPersonId) {
    await authedClient.from('people').delete().eq('id', createdPersonId);
  }
  await authedClient.auth.signOut();
});

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Share Token Auth — RLS Policies', () => {
  test('1. anon cannot SELECT directly from shares table', async () => {
    const { data, error } = await anonClient.from('shares').select('*');

    // RLS should either return an error or an empty result
    // After the migration, anon SELECT is revoked so Supabase returns an error
    const blocked = error !== null || (data !== null && data.length === 0);
    expect(blocked, 'Anon should not be able to SELECT from shares').toBe(true);
  });

  test('2. anon cannot SELECT from shares even with a known token filter', async () => {
    const { data, error } = await anonClient
      .from('shares')
      .select('*')
      .eq('token', testShareToken!);

    const blocked = error !== null || (data !== null && data.length === 0);
    expect(blocked, 'Anon should not bypass RLS with a WHERE clause').toBe(true);
  });

  test('3. get_share_by_token returns a share for a valid token', async () => {
    const { data, error } = await anonClient.rpc('get_share_by_token', {
      share_token: testShareToken!,
    });

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data.length).toBe(1);
    expect(data[0].token).toBe(testShareToken);
    expect(data[0].summary_text).toBe('Test share for integration testing');
  });

  test('4. get_share_by_token returns empty for an invalid token', async () => {
    const { data, error } = await anonClient.rpc('get_share_by_token', {
      share_token: 'completely-invalid-nonexistent-token',
    });

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data.length).toBe(0);
  });

  test('5. get_share_by_token returns empty for an expired token', async () => {
    const { data, error } = await anonClient.rpc('get_share_by_token', {
      share_token: expiredShareToken!,
    });

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data.length, 'Expired share should not be returned').toBe(0);
  });

  test('6. authenticated user can see their own shares', async () => {
    const { data, error } = await authedClient
      .from('shares')
      .select('*')
      .eq('id', testShareId!);

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBe(1);
    expect(data![0].user_id).toBe(QA_USER.id);
  });

  test('7. authenticated user cannot see other users shares', async () => {
    // Query all shares — RLS should filter to only the current user's
    const { data, error } = await authedClient
      .from('shares')
      .select('user_id');

    expect(error).toBeNull();
    expect(data).not.toBeNull();

    // Every returned row must belong to the QA user
    for (const row of data!) {
      expect(row.user_id).toBe(QA_USER.id);
    }
  });

  test('8. get_share_by_token also works for authenticated users', async () => {
    const { data, error } = await authedClient.rpc('get_share_by_token', {
      share_token: testShareToken!,
    });

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data.length).toBe(1);
    expect(data[0].token).toBe(testShareToken);
  });
});
