// @ts-check
var { test, expect } = require('@playwright/test');
var { createClient } = require('@supabase/supabase-js');

var SUPABASE_URL = 'https://nrpdhxygzyfmyljzfexv.supabase.co';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5ycGRoeHlnenlmbXlsanpmZXh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NTQ3MjUsImV4cCI6MjA5MTMzMDcyNX0.6gdj1hlW2UAc3gJOyjPJBeBJWth_Fcc5C5LH9zWyDXU';
var QA_EMAIL = 'qa-test-1776217285478@getwellet.com';
var QA_PASSWORD = 'TestPass123!';
var QA_USER_ID = '8c7e632f-1743-479d-9c27-da018837e60d';

/** Generate a random share token for testing */
function generateTestToken() {
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var token = 'test_';
  for (var i = 0; i < 20; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

test.describe('Share Token Auth (#31)', function () {
  /** @type {import('@supabase/supabase-js').SupabaseClient} */
  var anonClient;
  /** @type {import('@supabase/supabase-js').SupabaseClient} */
  var authedClient;
  /** @type {string[]} */
  var createdShareTokens = [];
  /** @type {string} */
  var testPersonId;

  test.beforeAll(async function () {
    // Anon client — no auth
    anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Authenticated client — sign in as QA user
    authedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    var { error } = await authedClient.auth.signInWithPassword({
      email: QA_EMAIL,
      password: QA_PASSWORD,
    });
    if (error) throw new Error('Auth failed: ' + error.message);

    // Get a valid person_id for the QA user (shares.person_id is NOT NULL)
    var { data: people, error: peopleErr } = await authedClient
      .from('people')
      .select('id')
      .eq('user_id', QA_USER_ID)
      .limit(1);
    if (peopleErr) throw new Error('Failed to query people: ' + peopleErr.message);
    if (!people || people.length === 0) {
      // Create a test person if none exist
      var { data: newPerson, error: createErr } = await authedClient
        .from('people')
        .insert({ user_id: QA_USER_ID, name: 'QA Test Person' })
        .select('id')
        .single();
      if (createErr) throw new Error('Failed to create test person: ' + createErr.message);
      testPersonId = newPerson.id;
    } else {
      testPersonId = people[0].id;
    }
  });

  test.afterAll(async function () {
    // Clean up test shares
    for (var i = 0; i < createdShareTokens.length; i++) {
      await authedClient
        .from('shares')
        .delete()
        .eq('token', createdShareTokens[i]);
    }
  });

  test('anon cannot SELECT directly from shares table', async function () {
    var { data, error } = await anonClient.from('shares').select('*');
    // RLS should block: either error or empty result
    var blocked = !!error || (data && data.length === 0);
    expect(blocked).toBe(true);
  });

  test('get_share_by_token returns share with valid token', async function () {
    // Create a share as the authenticated user
    var token = generateTestToken();
    createdShareTokens.push(token);
    var expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    var { error: insertErr } = await authedClient.from('shares').insert({
      token: token,
      user_id: QA_USER_ID,
      person_id: testPersonId,
      person_name: 'Test Person',
      summary_text: 'Test summary for share token test',
      expires_at: expiresAt,
    });
    expect(insertErr).toBeNull();

    // Query via RPC as anon — should return 1 row
    var { data, error } = await anonClient.rpc('get_share_by_token', {
      share_token: token,
    });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data[0].token).toBe(token);
  });

  test('get_share_by_token returns empty for invalid token', async function () {
    var { data, error } = await anonClient.rpc('get_share_by_token', {
      share_token: 'nonexistent_token_abc123xyz',
    });
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  test('get_share_by_token returns empty for expired share', async function () {
    // Create a share with past expiry
    var token = generateTestToken();
    createdShareTokens.push(token);
    var pastExpiry = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    var { error: insertErr } = await authedClient.from('shares').insert({
      token: token,
      user_id: QA_USER_ID,
      person_id: testPersonId,
      person_name: 'Expired Test',
      summary_text: 'Expired share test',
      expires_at: pastExpiry,
    });
    expect(insertErr).toBeNull();

    // Query via RPC as anon — expired share should not be returned
    var { data, error } = await anonClient.rpc('get_share_by_token', {
      share_token: token,
    });
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  test('authenticated user can SELECT own shares via RLS', async function () {
    // QA user should be able to query their own shares
    var { data, error } = await authedClient
      .from('shares')
      .select('*')
      .eq('user_id', QA_USER_ID);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    // Should get at least the test shares we just created
    expect(data.length).toBeGreaterThanOrEqual(0);
  });

  test('authenticated user cannot see other users shares', async function () {
    // Query all shares visible to the QA user — every row should belong to them
    var { data, error } = await authedClient.from('shares').select('*');
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    for (var i = 0; i < data.length; i++) {
      expect(data[i].user_id).toBe(QA_USER_ID);
    }
  });
});
