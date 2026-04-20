import { getCorsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  cors["Access-Control-Allow-Methods"] = "GET, OPTIONS";

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  try {
    const res = await fetch("https://open.epic.com/MyApps/EndpointsJson");
    const data = await res.json();

    return new Response(JSON.stringify(data), {
      headers: {
        ...cors,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Failed to fetch Epic endpoints" }), {
      status: 502,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
