// admin-reparse — neutralized stub.
// The one-shot reparse function was retired after use. Any incoming request
// is rejected with 410 Gone.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve((_req: Request) => {
  return new Response(JSON.stringify({ error: "gone", message: "admin-reparse has been retired" }), {
    status: 410,
    headers: { "Content-Type": "application/json" },
  });
});
