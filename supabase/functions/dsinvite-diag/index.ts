// Retired diagnostic stub. The dsinvite-diag function was used 2026-05-18 to
// uncover a service-role auth regression in the data-source-invite edge
// function (post-Supabase key rotation). The fix is shipped; this stub stays
// to keep the slug retired without deleting it.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

Deno.serve(() => {
  return new Response(
    JSON.stringify({ error: 'retired', retired_at: '2026-05-18' }),
    {
      status: 410,
      headers: { 'Content-Type': 'application/json' },
    },
  )
})
