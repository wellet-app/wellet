import { getCorsHeaders } from "../_shared/cors.ts";

// Returns Epic's published R4 endpoints in the legacy
// `{ Entries: [{ OrganizationName, FHIRPatientFacingURI }] }` shape that the
// picker expects. We source from the R4 FHIR Bundle (not the DSTU2 legacy
// JSON) because the rest of Wellet — token exchange, FHIR fetch, storage —
// is R4-only. Serving DSTU2 URLs in the picker created a mismatch where the
// activated-hospital allow-list (R4) never matched any picker row.
//
// Source: https://open.epic.com/Endpoints/R4 (FHIR Bundle of Endpoint resources)
const EPIC_R4_BUNDLE_URL = "https://open.epic.com/Endpoints/R4";

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  cors["Access-Control-Allow-Methods"] = "GET, OPTIONS";

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  try {
    const res = await fetch(EPIC_R4_BUNDLE_URL);
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch Epic R4 bundle", status: res.status }),
        { status: 502, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    const bundle = await res.json();
    const entries: Array<{ OrganizationName: string; FHIRPatientFacingURI: string }> = [];

    if (bundle && Array.isArray(bundle.entry)) {
      for (const e of bundle.entry) {
        const r = e && e.resource;
        if (!r) continue;
        // Prefer the contained Organization name; fall back to the Endpoint's
        // own name if missing.
        let orgName: string | null = null;
        if (Array.isArray(r.contained) && r.contained.length > 0) {
          const org = r.contained.find((c: any) => c && c.resourceType === "Organization") || r.contained[0];
          if (org && typeof org.name === "string" && org.name.trim()) orgName = org.name.trim();
        }
        if (!orgName && typeof r.name === "string" && r.name.trim()) orgName = r.name.trim();

        const url = typeof r.address === "string" ? r.address.trim() : "";
        if (!orgName || !url) continue;

        entries.push({ OrganizationName: orgName, FHIRPatientFacingURI: url });
      }
    }

    return new Response(JSON.stringify({ Entries: entries }), {
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
