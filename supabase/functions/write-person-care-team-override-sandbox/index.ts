// Supabase Edge Function: write-person-care-team-override-sandbox (v-final, 2026-09-11)
//
// Retired stub. verify_jwt is intentionally off so the 410 body reaches the
// caller; the endpoint returns nothing else and touches no data.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

serve((_req: Request) => new Response(
  JSON.stringify({
    error: 'gone',
    detail: 'This sandbox slug has been retired. Call write-person-care-team-override.',
  }),
  { status: 410, headers: { 'Content-Type': 'application/json' } },
));