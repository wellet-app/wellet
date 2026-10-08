// Retired sandbox slug. Replaced by the corresponding prod slug on 2026-09-09.
// Returns HTTP 410 Gone for every request so any lingering caller fails loudly.
Deno.serve((_req: Request) => {
  return new Response(
    JSON.stringify({
      error: "gone",
      message: "sandbox slug retired 2026-09-09; use the corresponding prod slug",
    }),
    {
      status: 410,
      headers: { "content-type": "application/json" },
    },
  );
});
