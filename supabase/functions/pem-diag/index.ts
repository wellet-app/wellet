// Diagnostic function retired. Returns 410 Gone.
Deno.serve(() => new Response(JSON.stringify({ error: 'gone', message: 'Diagnostic endpoint removed.' }), { status: 410, headers: { 'Content-Type': 'application/json' } }));
