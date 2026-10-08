// Supabase Edge Function: bdb-stats
// Public, read-only, no-auth endpoint that returns sanitized lifetime counts
// for the BDB application receipts page at getwellet.com/bdb.
//
// IMPORTANT: This endpoint is publicly callable (verify_jwt=false). It MUST
// only return aggregate counts and zero PII. No emails, no names, no row ids.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// Day-one anchor: April 14, 2026 — when Supabase auth + real data layer landed.
// The March 17 commits were a static HTML demo mockup, not the product build.
// Verified: 6 commits on 3/17, then nothing until 4/14 when the build actually began.
const FIRST_COMMIT_DATE = '2026-04-14';

// 2026-05-28 refresh for BDB submission numbers (locked for June 1):
// - commits_total: 572 mywellet + 97 getwellet = 669 across both repos
// - commits_30d: 304 mywellet + 46 getwellet = 350 across both repos
// - edge_functions_active: 66 ACTIVE in Supabase (counted via list_edge_functions)
// - crons_active: 8 scheduled crons in production
// - db_migrations_total: 129 applied (supabase_migrations.schema_migrations)
// - hospital_systems_activated: 30 (Epic Client ID Downloads as of 2026-05-28,
//   visible at fhir.epic.com/Developer/Apps for the Wellet Confidential client)
// - hospital_systems_requested: 486 (Epic Client ID Requests)
//
// 2026-05-28 PATCH: live_fhir_vendors now counts DISTINCT connected hospital_name
// rather than vendor-bucket substrings. The old substring logic only recognized
// duke/unc/va and dropped HSS/MSK/Montefiore/Mount Sinai into "other" — which
// were then excluded from the vendor count, returning 2 when the real number of
// live patient connections was 6. The vendorBucket function and ehr_connections_by_vendor
// shape are retained for backward compatibility with any downstream consumer,
// but the headline tile now reflects live patient connections.
const COMMITS_TOTAL = 669;
const COMMITS_30D = 350;
const EDGE_FUNCTIONS_ACTIVE = 66;
const CRONS_ACTIVE = 8;
const DB_MIGRATIONS_TOTAL = 129;
const HOSPITAL_SYSTEMS_ACTIVATED = 30;
const HOSPITAL_SYSTEMS_REQUESTED = 486;

function getAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(supabaseUrl, supabaseServiceKey);
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
}

function vendorBucket(hospitalName: string): 'duke' | 'unc' | 'va' | 'other' {
  const lower = (hospitalName || '').toLowerCase();
  if (lower.includes('duke')) return 'duke';
  if (lower.includes('unc')) return 'unc';
  if (lower.includes('va') || lower.includes('veteran')) return 'va';
  return 'other';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'GET only' }, 405);
  }

  try {
    const admin = getAdminClient();
    const updatedAt = new Date().toISOString();

    let signupsLifetime = 0;
    try {
      let page = 1;
      while (page <= 20) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) break;
        const users = data?.users || [];
        for (const u of users) {
          const email = (u.email || '').toLowerCase();
          if (!email) continue;
          if (email.startsWith('betsy.eble')) continue;
          if (email.startsWith('test+') && email.endsWith('@mywellet.com')) continue;
          if (email.includes('+qa@')) continue;
          signupsLifetime += 1;
        }
        if (users.length < 1000) break;
        page += 1;
      }
    } catch (_e) { }

    let ehrLifetime = 0;
    const vendorCounts: Record<string, number> = { duke: 0, unc: 0, va: 0, other: 0 };
    const distinctHospitals = new Set<string>();
    try {
      const { data: ehrRows } = await admin.from('ehr_connections')
        .select('hospital_name')
        .eq('status', 'connected');
      if (Array.isArray(ehrRows)) {
        ehrLifetime = ehrRows.length;
        for (const r of ehrRows) {
          const name = (r as { hospital_name?: string }).hospital_name || '';
          if (name) distinctHospitals.add(name.trim().toLowerCase());
          const bucket = vendorBucket(name);
          vendorCounts[bucket] += 1;
        }
      }
    } catch (_e) { }

    // PATCH 2026-05-28: live_fhir_vendors now = distinct connected hospitals,
    // not substring-bucketed vendors. Today this returns 6 (Duke, UNC, MSK,
    // Mount Sinai, Montefiore, HSS) instead of the old 2.
    const liveFhirVendors = distinctHospitals.size;

    let hospitalRequests = 0;
    try {
      const { count } = await admin.from('hospital_connect_requests')
        .select('id', { count: 'exact', head: true })
        .not('contact_email', 'ilike', 'betsy.eble%@%')
        .not('contact_email', 'ilike', 'test+%@mywellet.com')
        .not('hospital_name', 'ilike', '%testytest%');
      hospitalRequests = count || 0;
    } catch (_e) { }

    let bugReports7d = 0;
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { count } = await admin.from('bug_reports')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', sevenDaysAgo)
        .not('user_email', 'ilike', 'betsy.eble%@%')
        .not('user_email', 'ilike', 'test+%@mywellet.com')
        .not('description', 'ilike', '%diagnostic%')
        .not('description', 'ilike', '%testytest%');
      bugReports7d = count || 0;
    } catch (_e) { }

    let opsEventsLifetime = 0;
    try {
      const { count } = await admin.from('wellet_ops_events')
        .select('id', { count: 'exact', head: true });
      opsEventsLifetime = count || 0;
    } catch (_e) { }

    const firstCommit = new Date(FIRST_COMMIT_DATE + 'T00:00:00Z').getTime();
    const daysSinceFirstCommit = Math.max(1, Math.floor((Date.now() - firstCommit) / (24 * 60 * 60 * 1000)));

    return jsonResponse({
      updated_at: updatedAt,
      signups_lifetime: signupsLifetime,
      ehr_connections_lifetime: ehrLifetime,
      ehr_connections_by_vendor: vendorCounts,
      live_fhir_vendors: liveFhirVendors,
      live_patient_connections: liveFhirVendors,
      bug_reports_7d: bugReports7d,
      hospital_requests_lifetime: hospitalRequests,
      ops_events_lifetime: opsEventsLifetime,
      commits_total: COMMITS_TOTAL,
      commits_30d: COMMITS_30D,
      days_since_first_commit: daysSinceFirstCommit,
      edge_functions_active: EDGE_FUNCTIONS_ACTIVE,
      crons_active: CRONS_ACTIVE,
      db_migrations_total: DB_MIGRATIONS_TOTAL,
      hospital_systems_activated: HOSPITAL_SYSTEMS_ACTIVATED,
      hospital_systems_requested: HOSPITAL_SYSTEMS_REQUESTED,
    });
  } catch (err) {
    console.error('bdb-stats error', err);
    return jsonResponse({
      updated_at: new Date().toISOString(),
      error: 'partial',
      commits_total: COMMITS_TOTAL,
      commits_30d: COMMITS_30D,
      edge_functions_active: EDGE_FUNCTIONS_ACTIVE,
      crons_active: CRONS_ACTIVE,
      db_migrations_total: DB_MIGRATIONS_TOTAL,
      hospital_systems_activated: HOSPITAL_SYSTEMS_ACTIVATED,
      hospital_systems_requested: HOSPITAL_SYSTEMS_REQUESTED,
    }, 200);
  }
});
