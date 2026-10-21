// Retired 2026-10-21 (security batch). This one-off helper was protected only
// by a passphrase written into its code. Nothing in the web app, iOS app,
// database or cron calls it. Kept as a stub so the URL answers 410 instead of
// running anything; delete from the Supabase dashboard when convenient.
Deno.serve(() => new Response(JSON.stringify({ error: 'retired' }), {
  status: 410, headers: { 'Content-Type': 'application/json' },
}));
