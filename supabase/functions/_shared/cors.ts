const ALLOWED_ORIGINS = [
  "https://mywellet.com",
  "https://www.mywellet.com",
  "https://getwellet.com",
  "https://www.getwellet.com",
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
