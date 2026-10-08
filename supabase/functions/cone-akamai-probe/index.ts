// RETIRED: Cone Akamai probe. Delete this function from the Supabase dashboard.
// Result recorded 2026-09-05: 9/9 requests to conehealth.com from Supabase
// edge egress returned HTTP 403 (Akamai Access Denied) regardless of UA.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(() => new Response(
  JSON.stringify({
    status: "retired",
    note: "See wellet-ios-rebuild wiki, Cone adapter entry, for probe result.",
  }),
  { status: 410, headers: { "Content-Type": "application/json" } },
));
