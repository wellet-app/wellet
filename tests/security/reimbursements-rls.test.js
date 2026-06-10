// @ts-check
// RLS regression for public.reimbursement_assessments (Reimbursements PR 1).
//
// The policy "Users see own reimbursements" is FOR ALL USING
// (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id). We verify:
//   1. Anonymous clients cannot read the table.
//   2. The authed QA user can insert + read their OWN row.
//   3. WITH CHECK blocks inserting a row for a different user_id
//      (write isolation — user A cannot plant a row as user B).
//   4. A SELECT by the authed user only ever returns rows they own
//      (read isolation — user A cannot read user B's rows).
//
// The edge function writes with the service role, which bypasses RLS, so
// these client-side policies do not interfere with normal app writes.

var { test, expect } = require('@playwright/test');
var { createClient } = require('@supabase/supabase-js');

var SUPABASE_URL = 'https://nrpdhxygzyfmyljzfexv.supabase.co';
var SUPABASE_ANON_KEY = '[REDACTED-JWT]';
var QA_EMAIL = 'qa-test-1776217285478@getwellet.com';
var QA_PASSWORD = 'TestPass123!';
var QA_USER_ID = '8c7e632f-1743-479d-9c27-da018837e60d';

// A well-formed UUID that is NOT the QA user — used to attempt a cross-user
// insert that RLS WITH CHECK must reject.
var OTHER_USER_ID = '00000000-0000-4000-8000-000000000abc';

test.describe('Reimbursements RLS (reimbursement_assessments)', function () {
  /** @type {import('@supabase/supabase-js').SupabaseClient} */
  var anonClient;
  /** @type {import('@supabase/supabase-js').SupabaseClient} */
  var authedClient;
  /** @type {string} */
  var testPersonId;
  /** @type {string[]} */
  var createdAssessmentIds = [];

  test.beforeAll(async function () {
    anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    authedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    var { error } = await authedClient.auth.signInWithPassword({
      email: QA_EMAIL,
      password: QA_PASSWORD,
    });
    if (error) throw new Error('Auth failed: ' + error.message);

    // Need a person owned by the QA user (FK target for person_id).
    var { data: people, error: peopleErr } = await authedClient
      .from('people')
      .select('id')
      .eq('user_id', QA_USER_ID)
      .limit(1);
    if (peopleErr) throw new Error('Failed to query people: ' + peopleErr.message);
    if (!people || people.length === 0) {
      var { data: newPerson, error: createErr } = await authedClient
        .from('people')
        .insert({ user_id: QA_USER_ID, name: 'QA Reimbursements Person' })
        .select('id')
        .single();
      if (createErr) throw new Error('Failed to create test person: ' + createErr.message);
      testPersonId = newPerson.id;
    } else {
      testPersonId = people[0].id;
    }
  });

  test.afterAll(async function () {
    for (var i = 0; i < createdAssessmentIds.length; i++) {
      await authedClient
        .from('reimbursement_assessments')
        .delete()
        .eq('id', createdAssessmentIds[i]);
    }
  });

  test('anon cannot SELECT from reimbursement_assessments', async function () {
    var { data, error } = await anonClient
      .from('reimbursement_assessments')
      .select('*');
    var blocked = !!error || (data && data.length === 0);
    expect(blocked).toBe(true);
  });

  test('authed user can insert and read their own assessment', async function () {
    var { data, error } = await authedClient
      .from('reimbursement_assessments')
      .insert({
        person_id: testPersonId,
        user_id: QA_USER_ID,
        adl_level: '1_2',
        caregiver_role: 'primary',
      })
      .select('id, user_id, stale_at, assessed_at')
      .single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data.user_id).toBe(QA_USER_ID);
    // The freshness trigger must have populated stale_at = assessed_at + 90d.
    expect(data.stale_at).not.toBeNull();
    var delta = new Date(data.stale_at).getTime() - new Date(data.assessed_at).getTime();
    var ninetyDays = 90 * 24 * 60 * 60 * 1000;
    expect(Math.abs(delta - ninetyDays)).toBeLessThan(60 * 1000);
    createdAssessmentIds.push(data.id);

    var { data: readBack, error: readErr } = await authedClient
      .from('reimbursement_assessments')
      .select('id')
      .eq('id', data.id)
      .maybeSingle();
    expect(readErr).toBeNull();
    expect(readBack).not.toBeNull();
  });

  test('WITH CHECK blocks inserting a row owned by a different user', async function () {
    var { data, error } = await authedClient
      .from('reimbursement_assessments')
      .insert({
        person_id: testPersonId,
        user_id: OTHER_USER_ID, // not auth.uid() — must be rejected
        adl_level: 'none',
      })
      .select('id');
    // RLS WITH CHECK rejects the row: error, or no row returned.
    var blocked = !!error || !data || data.length === 0;
    expect(blocked).toBe(true);
  });

  test('authed SELECT only returns rows owned by the current user', async function () {
    var { data, error } = await authedClient
      .from('reimbursement_assessments')
      .select('user_id');
    expect(error).toBeNull();
    (data || []).forEach(function (row) {
      expect(row.user_id).toBe(QA_USER_ID);
    });
  });
});
