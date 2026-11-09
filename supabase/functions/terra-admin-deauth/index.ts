// Neutralized \u2014 one-shot admin tool has been retired. Always returns 410 Gone.
Deno.serve(() => new Response(JSON.stringify({ error: 'gone' }), { status: 410, headers: { 'Content-Type': 'application/json' } }));
