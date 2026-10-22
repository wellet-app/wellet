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

// Hospitals where Wellet's confidential client is activated. Copied
// verbatim from ACTIVATED_FHIR_URLS in assets/wellet.js on 2026-10-21 so
// the iOS app reads the same list from one server copy. Until the web
// picker switches to `activated`, both copies must change together.
export const ACTIVATED_FHIR_URLS: string[] = [
  "https://epsoap.conehealth.com/FHIRProxy/api/FHIR/R4/", // Cone Health
  "https://health-apis.duke.edu/FHIR/api/FHIR/R4/", // Duke Health
  "https://epicrp.firsthealth.org/FHIR-PRD/api/FHIR/R4/", // FirstHealth of the Carolinas
  "https://epicproxy.et0798.epichosted.com/APIProxyPRD/api/FHIR/R4/", // Novant
  "https://epicfe.unch.unc.edu/FHIR/api/FHIR/R4/", // UNC Health Care
  "https://epic-soap.wakemed.org/FHIR/api/FHIR/R4/", // WakeMed
  "https://epicproxy.et0905.epichosted.com/FHIRProxy/api/FHIR/R4/", // Atrium Health
  "https://spp.caromonthealth.org/FhirProxy/api/FHIR/R4/", // CaroMont Health
  "https://prd-proxy.vidanthealth.com/FHIR/api/FHIR/R4/", // ECU Health (Vidant)
  "https://api.ccf.org/mu/api/FHIR/R4/", // Cleveland Clinic
  "https://ws-interconnect-fhir.partners.org/Interconnect-FHIR-MU-PRD/api/FHIR/R4/", // Mass General Brigham
  "https://unified-api.ucsf.edu/clinical/apex/api/FHIR/R4/", // UCSF Health
  "https://fhir.kp.org/service/ptnt_care/EpicEdiFhirRoutingSvc/v2014/esb-envlbl/212/api/FHIR/R4/", // Kaiser Permanente - Southern California
  "https://epicproxy-pub.et1089.epichosted.com/FHIRProxy/api/FHIR/R4/", // NewYork-Presbyterian + Weill Cornell Medicine (shared endpoint)
  "https://epicfhir.nyumc.org/FHIRPRD/api/FHIR/R4/", // NYU Langone Health
  "https://epicsoapproxyprd.mountsinai.org/FHIR-PRD/api/FHIR/R4/", // Mount Sinai (NYC) - also covers Health Center / Hudson Yards / Concierge Care
  "https://soapepic.montefiore.org/FhirProxyPrd/api/FHIR/R4/", // Montefiore Health System
  "https://epicproxy.et1353.epichosted.com/APIPROXYPRD/api/FHIR/R4/", // Memorial Sloan Kettering Cancer Center
  "https://epicproxy.et0927.epichosted.com/FHIRProxy/api/FHIR/R4/", // Hospital for Special Surgery
  "https://fhir.hfhs.org/FHIRProxy/api/FHIR/R4/", // Henry Ford Health System
  "https://epicrp-prd.eushc.org/OAUTH2-PRD/api/FHIR/R4/", // Emory Healthcare
  "https://webproxy.piedmont.org/ARR-FHIR/api/FHIR/R4/", // Piedmont Healthcare
  "https://epicsoap.wellstar.org/fhirproxy/api/FHIR/R4/", // Wellstar Health System
  "https://wpprod.choa.org/FHIR_PRD/api/FHIR/R4/", // Children's Healthcare of Atlanta (CHOA)
  "https://surescripts.gmh.edu/OAuth2PRD/api/FHIR/R4/", // Grady Health System
];

export function normFhirUrl(u: string): string {
  return String(u || "").toLowerCase().replace(/\/+$/, "");
}

const ACTIVATED_SET = new Set(ACTIVATED_FHIR_URLS.map(normFhirUrl));

// Same fix as _normalizeHospitalName in wellet.js: Epic publishes a few
// names with a double possessive ("Childrens's Healthcare of Atlanta").
export function normalizeHospitalName(name: string): string {
  let out = String(name || "");
  out = out.replace(/\bChildrens'?s\b/g, "Children's");
  out = out.replace(/\bChildrens(?=\s+(Healthcare|Hospital|Medical|Health|Specialty|Specialists|Mercy|National|Hospitals|of))/gi, "Children's");
  return out;
}

type Entry = { OrganizationName: string; FHIRPatientFacingURI: string };

// `activated` (POST body {"activated": true} or ?activated=1) returns only
// activated hospitals, names normalized, sorted by name, one row per
// name and URL. Without it the response is unchanged, so the web picker
// keeps working as before.
export function activatedOnly(entries: Entry[]): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const e of entries) {
    if (!ACTIVATED_SET.has(normFhirUrl(e.FHIRPatientFacingURI))) continue;
    const name = normalizeHospitalName(e.OrganizationName);
    const key = name.toLowerCase() + "|" + normFhirUrl(e.FHIRPatientFacingURI);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ OrganizationName: name, FHIRPatientFacingURI: e.FHIRPatientFacingURI });
  }
  return out.sort((a, b) => a.OrganizationName.localeCompare(b.OrganizationName));
}

async function wantsActivated(req: Request): Promise<boolean> {
  const url = new URL(req.url);
  if (url.searchParams.get("activated") === "1") return true;
  if (req.method !== "POST") return false;
  try {
    const body = await req.clone().json();
    return body && body.activated === true;
  } catch {
    return false;
  }
}

export async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);
  cors["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  try {
    const activated = await wantsActivated(req);
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

    const body = activated ? { Entries: activatedOnly(entries), Activated: true } : { Entries: entries };
    return new Response(JSON.stringify(body), {
      headers: {
        ...cors,
        "Content-Type": "application/json",
        // Do NOT let browsers/CDN cache this response. The picker has its own
        // 24h localStorage cache; an HTTP cache on top creates a trap where a
        // stale response (e.g. the old DSTU2 shape) keeps being served back
        // for 24h even after the function is updated. Seen in prod 2026-04-27:
        // users got DSTU2 URLs from disk cache after we shipped R4.
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Failed to fetch Epic endpoints" }), {
      status: 502,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
}

Deno.serve(handler);
