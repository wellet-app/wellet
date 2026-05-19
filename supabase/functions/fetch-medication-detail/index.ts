// ============================================================================
// fetch-medication-detail/index.ts v1
// Med Detail v2 — one call returns all 5 tile payloads for the Medication
// detail screen on Wellet. Public-source data only. Wellet never offers
// medical advice; we surface what U.S. NLM, FDA, and MedlinePlus publish.
//
// Sources (no API keys required):
//   - RxNorm (rxnav.nlm.nih.gov) — drug name → RXCUI normalization
//   - MedlinePlus Connect (connect.medlineplus.gov) — plain-English leaflet URL
//   - MedlinePlus public leaflet HTML — parsed for About / Use / Side effects
//   - openFDA drug labels (api.fda.gov/drug/label) — FDA SPL prose
//
// Tiles returned:
//   1. pill: text description (shape/color/imprint from openFDA — Pillbox retired May 2026)
//   2. about: "Why is this medication prescribed?" (MedlinePlus) + indications (FDA fallback)
//   3. use: "How should this medicine be used?" (MedlinePlus) + dosage (FDA fallback)
//   4. side_effects: "What side effects can this medication cause?" (MedlinePlus) + adverse_reactions (FDA fallback)
//   5. interactions: openFDA drug_interactions narrative + warnings
//   6. full_label: links into the FDA / MedlinePlus full leaflet
//
// Voice (NON-NEGOTIABLE):
//   - "loved one" / "family member", never "parent"
//   - "notices" / "watches for", never "track" / "monitor"
//   - CareSignals is one word
//   - Never claim a match, never recommend, never interpret
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://mywellet.com",
  "https://www.mywellet.com",
  "https://getwellet.com",
  "https://www.getwellet.com",
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResp(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function sha256(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CACHE_SOURCE = "medication_detail_tile";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — drug label data is very slow-moving
const FETCH_TIMEOUT_MS = 6000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface PillDescription {
  shape?: string;
  color?: string;
  imprint?: string;
  size_mm?: string;
  text?: string; // free-form how_supplied prose
  ndc?: string;
}

interface MedDetailPayload {
  rxcui: string;
  resolved_name: string;          // RxNorm canonical name (or fallback to input)
  ingredients: string[];          // active ingredients per RxNorm
  pill: PillDescription | null;
  about: { text: string; source: string; url?: string } | null;
  use: { text: string; source: string; url?: string } | null;
  side_effects: { text: string; source: string; url?: string } | null;
  interactions: { text: string; source: string; url?: string } | null;
  full_label: { medlineplus_url?: string; openfda_url?: string } | null;
  fetched_at: string;
  warnings: string[];             // soft errors (e.g. "couldn't find RXCUI")
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — timeouts
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWithTimeout(url: string, ms: number = FETCH_TIMEOUT_MS): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(ms) });
  } catch (err) {
    console.warn("[fetch-medication-detail] fetch failed:", url, String(err).slice(0, 200));
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — RxNorm: name → RXCUI + ingredients
// ─────────────────────────────────────────────────────────────────────────────
async function resolveRxnorm(name: string): Promise<{ rxcui: string; resolved_name: string; ingredients: string[] }> {
  const trimmed = name.trim();
  if (!trimmed) return { rxcui: "", resolved_name: "", ingredients: [] };

  // Try exact first
  let rxcui = "";
  let resolved = trimmed;

  const direct = await fetchWithTimeout(
    `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(trimmed)}&search=2`
  );
  if (direct) {
    try {
      const j = await direct.json();
      const ids: string[] = j?.idGroup?.rxnormId || [];
      if (ids.length > 0) rxcui = ids[0];
    } catch { /* ignore */ }
  }

  // Approximate match fallback (handles "Lisinopril/HCTZ", "Ramipril 2.5mg" etc.)
  if (!rxcui) {
    const approx = await fetchWithTimeout(
      `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(trimmed)}&maxEntries=1`
    );
    if (approx) {
      try {
        const j = await approx.json();
        const candidates = j?.approximateGroup?.candidate || [];
        if (candidates.length > 0 && candidates[0].rxcui) {
          rxcui = candidates[0].rxcui;
          if (candidates[0].name) resolved = candidates[0].name;
        }
      } catch { /* ignore */ }
    }
  }

  // Get canonical name + ingredients (helps the interactions tile)
  let ingredients: string[] = [];
  if (rxcui) {
    const props = await fetchWithTimeout(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/properties.json`);
    if (props) {
      try {
        const j = await props.json();
        if (j?.properties?.name) resolved = j.properties.name;
      } catch { /* ignore */ }
    }
    const related = await fetchWithTimeout(
      `https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/related.json?tty=IN`
    );
    if (related) {
      try {
        const j = await related.json();
        const groups = j?.relatedGroup?.conceptGroup || [];
        for (const g of groups) {
          const props = g?.conceptProperties || [];
          for (const p of props) {
            if (p?.name) ingredients.push(p.name);
          }
        }
      } catch { /* ignore */ }
    }
  }

  return { rxcui, resolved_name: resolved, ingredients };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — MedlinePlus Connect: RXCUI → leaflet URL
// ─────────────────────────────────────────────────────────────────────────────
async function fetchMedlineplusUrl(rxcui: string): Promise<string> {
  if (!rxcui) return "";
  const url = `https://connect.medlineplus.gov/service?mainSearchCriteria.v.cs=2.16.840.1.113883.6.88&mainSearchCriteria.v.c=${rxcui}&informationRecipient.languageCode.c=en&knowledgeResponseType=application/json`;
  const r = await fetchWithTimeout(url);
  if (!r) return "";
  try {
    const j = await r.json();
    const entries = j?.feed?.entry || [];
    for (const e of entries) {
      const link = (e?.link || []).find((l: any) => l?.title?.includes?.("MedlinePlus")) || (e?.link || [])[0];
      if (link?.href) return link.href;
    }
  } catch { /* ignore */ }
  return "";
}

// Strip HTML tags, decode common entities, collapse whitespace
function htmlToText(html: string, maxLen: number = 1400): string {
  if (!html) return "";
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.length > maxLen) {
    t = t.slice(0, maxLen);
    const lastPeriod = t.lastIndexOf(". ");
    if (lastPeriod > maxLen * 0.6) t = t.slice(0, lastPeriod + 1);
    t += " …";
  }
  return t;
}

// Parse a section out of MedlinePlus leaflet HTML between two <h2>s
function extractMedlineplusSection(html: string, headingPattern: RegExp): string {
  if (!html) return "";
  const headingMatch = html.match(headingPattern);
  if (!headingMatch || headingMatch.index === undefined) return "";
  const startIdx = headingMatch.index + headingMatch[0].length;
  const restAfter = html.slice(startIdx);
  // MedlinePlus uses h2 for the major sections we care about
  const nextHeading = restAfter.search(/<h2\b/i);
  const sectionHtml = nextHeading > 0 ? restAfter.slice(0, nextHeading) : restAfter.slice(0, 4000);
  return htmlToText(sectionHtml, 1400);
}

async function fetchMedlineplusLeaflet(leafletUrl: string): Promise<{ about: string; use: string; side_effects: string }> {
  const out = { about: "", use: "", side_effects: "" };
  if (!leafletUrl) return out;
  const r = await fetchWithTimeout(leafletUrl, 8000);
  if (!r || !r.ok) return out;
  let html = "";
  try { html = await r.text(); } catch { return out; }

  out.about = extractMedlineplusSection(html, /<h2[^>]*>\s*Why is this medic[^<]*<\/h2>/i);
  out.use = extractMedlineplusSection(html, /<h2[^>]*>\s*How should this medic[^<]*<\/h2>/i);
  out.side_effects = extractMedlineplusSection(html, /<h2[^>]*>\s*What side effects[^<]*<\/h2>/i);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — openFDA label
// ─────────────────────────────────────────────────────────────────────────────
interface OpenFdaLabel {
  indications_and_usage?: string[];
  dosage_and_administration?: string[];
  adverse_reactions?: string[];
  drug_interactions?: string[];
  warnings?: string[];
  warnings_and_cautions?: string[];
  contraindications?: string[];
  description?: string[];
  how_supplied?: string[];
  spl_product_data_elements?: string[];
  openfda?: {
    generic_name?: string[];
    brand_name?: string[];
    product_ndc?: string[];
    rxcui?: string[];
  };
  id?: string;
}

async function fetchOpenFda(rxcui: string, name: string, ingredients: string[]): Promise<OpenFdaLabel | null> {
  const tries: string[] = [];
  if (rxcui) tries.push(`openfda.rxcui:"${rxcui}"`);
  if (name) {
    const cleanName = name.replace(/[^a-zA-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean)[0] || name;
    tries.push(`openfda.generic_name:"${cleanName.toLowerCase()}"`);
    tries.push(`openfda.brand_name:"${cleanName.toLowerCase()}"`);
  }
  for (const ing of ingredients.slice(0, 2)) {
    tries.push(`openfda.generic_name:"${ing.toLowerCase()}"`);
  }

  for (const q of tries) {
    const url = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(q)}&limit=1`;
    const r = await fetchWithTimeout(url);
    if (!r) continue;
    if (r.status === 404) continue;
    if (!r.ok) continue;
    try {
      const j = await r.json();
      const results = j?.results || [];
      if (results.length > 0) return results[0] as OpenFdaLabel;
    } catch { /* ignore */ }
  }
  return null;
}

function firstString(arr: string[] | undefined, maxLen: number = 1400): string {
  if (!arr || arr.length === 0) return "";
  let s = String(arr[0] || "");
  // openFDA strings often have leading "1 INDICATIONS AND USAGE" — strip
  s = s.replace(/^\s*\d+(\.\d+)?\s+[A-Z][A-Z \-\/&]+\n+/, "").trim();
  if (s.length > maxLen) {
    s = s.slice(0, maxLen);
    const lastPeriod = s.lastIndexOf(". ");
    if (lastPeriod > maxLen * 0.6) s = s.slice(0, lastPeriod + 1);
    s += " …";
  }
  return s;
}

function extractPillDescription(label: OpenFdaLabel | null): PillDescription | null {
  if (!label) return null;
  const out: PillDescription = {};
  const supplied = firstString(label.how_supplied, 800);
  const spl = firstString(label.spl_product_data_elements, 800);
  const blob = (supplied + " " + spl).toLowerCase();

  // Shape
  const shapeMatch = blob.match(/\b(round|oval|capsule|triangle|triangular|square|rectangle|rectangular|diamond|pentagon|hexagon|tear|teardrop)\b/);
  if (shapeMatch) out.shape = shapeMatch[1];

  // Color (allow compound like "light blue", "pink and white")
  const colorMatch = blob.match(/\b((?:light |dark |pale |bright )?(?:white|yellow|pink|orange|red|blue|green|brown|tan|beige|peach|purple|gray|grey|black)(?:\s+(?:and|to)\s+(?:white|yellow|pink|orange|red|blue|green|brown|tan|beige|peach|purple|gray|grey|black))?)\b/);
  if (colorMatch) out.color = colorMatch[1];

  // Imprint — look for quoted strings or "imprinted with"
  const imprintMatch = blob.match(/imprint(?:ed)? (?:with )?["']?([a-z0-9 \-]{2,20})["']?/i)
    || blob.match(/debossed (?:with )?["']?([a-z0-9 \-]{2,20})["']?/i);
  if (imprintMatch) out.imprint = imprintMatch[1].trim().toUpperCase().replace(/\s+/g, " ");

  // Size in mm
  const sizeMatch = blob.match(/(\d+(?:\.\d+)?)\s*mm/);
  if (sizeMatch) out.size_mm = sizeMatch[1] + " mm";

  // NDC
  if (label.openfda?.product_ndc && label.openfda.product_ndc.length > 0) {
    out.ndc = label.openfda.product_ndc[0];
  }

  // Prose fallback if no structured fields parsed
  if (!out.shape && !out.color && !out.imprint) {
    if (supplied) {
      out.text = supplied.slice(0, 600);
    } else if (spl) {
      out.text = spl.slice(0, 600);
    } else {
      return null;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache layer (reuses public_data_cache table)
// ─────────────────────────────────────────────────────────────────────────────
async function cacheGet(admin: ReturnType<typeof createClient>, cacheKey: string): Promise<MedDetailPayload | null> {
  try {
    const { data } = await admin.from("public_data_cache")
      .select("response, expires_at")
      .eq("source", CACHE_SOURCE).eq("cache_key", cacheKey).maybeSingle();
    if (!data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    return data.response as MedDetailPayload;
  } catch { return null; }
}

async function cachePut(
  admin: ReturnType<typeof createClient>,
  cacheKey: string,
  inputName: string,
  payload: MedDetailPayload,
) {
  try {
    await admin.from("public_data_cache").upsert({
      source: CACHE_SOURCE,
      cache_key: cacheKey,
      query_meta: { input_name: inputName, rxcui: payload.rxcui },
      response: payload,
      fetched_at: payload.fetched_at,
      expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    }, { onConflict: "source,cache_key" });
  } catch (err) {
    console.warn("[fetch-medication-detail] cache write failed:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return jsonResp({ error: "method_not_allowed" }, 405, cors);

  let body: { name?: string; rxcui?: string; person_id?: string };
  try { body = await req.json(); }
  catch { return jsonResp({ error: "invalid_json" }, 200, cors); }

  const inputName = (body.name || "").trim();
  const inputRxcui = (body.rxcui || "").trim();
  if (!inputName && !inputRxcui) {
    return jsonResp({ error: "missing_name_or_rxcui" }, 200, cors);
  }

  // Normalize cache key on lowercase trimmed name + rxcui hint
  const cacheInput = `${inputName.toLowerCase()}|${inputRxcui}`;
  const cacheKey = await sha256(cacheInput);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const cached = await cacheGet(admin, cacheKey);
  if (cached) {
    return jsonResp({ ...cached, cached: true }, 200, cors);
  }

  const warnings: string[] = [];

  // 1) RxNorm normalize (or pass through provided rxcui)
  let rxcui = inputRxcui;
  let resolvedName = inputName;
  let ingredients: string[] = [];
  if (!rxcui && inputName) {
    const norm = await resolveRxnorm(inputName);
    rxcui = norm.rxcui;
    resolvedName = norm.resolved_name || inputName;
    ingredients = norm.ingredients;
  } else if (rxcui) {
    // Still pull ingredients/properties for given rxcui
    const props = await fetchWithTimeout(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/properties.json`);
    if (props) {
      try {
        const j = await props.json();
        if (j?.properties?.name) resolvedName = j.properties.name;
      } catch { /* ignore */ }
    }
    const related = await fetchWithTimeout(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/related.json?tty=IN`);
    if (related) {
      try {
        const j = await related.json();
        const groups = j?.relatedGroup?.conceptGroup || [];
        for (const g of groups) {
          for (const p of (g?.conceptProperties || [])) if (p?.name) ingredients.push(p.name);
        }
      } catch { /* ignore */ }
    }
  }
  if (!rxcui) warnings.push("rxnorm_not_found");

  // 2) MedlinePlus Connect → leaflet URL, then parse the leaflet HTML
  let medlineplusUrl = "";
  let mlp = { about: "", use: "", side_effects: "" };
  if (rxcui) {
    medlineplusUrl = await fetchMedlineplusUrl(rxcui);
    if (medlineplusUrl) {
      mlp = await fetchMedlineplusLeaflet(medlineplusUrl);
    } else {
      warnings.push("medlineplus_no_leaflet");
    }
  }

  // 3) openFDA label (in parallel with #2 ideally, but for simplicity stay sequential)
  const fdaLabel = await fetchOpenFda(rxcui, resolvedName || inputName, ingredients);
  if (!fdaLabel) warnings.push("openfda_no_label");

  // Compose payload
  const fdaIndications = firstString(fdaLabel?.indications_and_usage);
  const fdaDosage = firstString(fdaLabel?.dosage_and_administration);
  const fdaAdverse = firstString(fdaLabel?.adverse_reactions);
  const fdaInteractions = firstString(fdaLabel?.drug_interactions);
  const fdaWarnings = firstString(fdaLabel?.warnings_and_cautions || fdaLabel?.warnings);

  const openfdaSetId = fdaLabel?.id || "";
  const openfdaUrl = openfdaSetId
    ? `https://nctr-crs.fda.gov/fdalabel/services/spl/set-ids/${openfdaSetId}/spl-doc`
    : "";

  // Build tiles — prefer MedlinePlus plain-English; fall back to FDA SPL where MLP empty.
  const about = mlp.about
    ? { text: mlp.about, source: "MedlinePlus, U.S. National Library of Medicine", url: medlineplusUrl }
    : (fdaIndications
        ? { text: fdaIndications, source: "FDA drug label (openFDA)", url: openfdaUrl || undefined }
        : null);

  const use = mlp.use
    ? { text: mlp.use, source: "MedlinePlus, U.S. National Library of Medicine", url: medlineplusUrl }
    : (fdaDosage
        ? { text: fdaDosage, source: "FDA drug label (openFDA)", url: openfdaUrl || undefined }
        : null);

  const side_effects = mlp.side_effects
    ? { text: mlp.side_effects, source: "MedlinePlus, U.S. National Library of Medicine", url: medlineplusUrl }
    : (fdaAdverse
        ? { text: fdaAdverse, source: "FDA drug label (openFDA)", url: openfdaUrl || undefined }
        : null);

  const interactionsText = [fdaInteractions, fdaWarnings].filter(Boolean).join("\n\n").trim();
  const interactions = interactionsText
    ? { text: interactionsText.slice(0, 1600) + (interactionsText.length > 1600 ? " …" : ""),
        source: "FDA drug label (openFDA)", url: openfdaUrl || undefined }
    : null;

  const pill = extractPillDescription(fdaLabel);

  const payload: MedDetailPayload = {
    rxcui,
    resolved_name: resolvedName || inputName,
    ingredients: Array.from(new Set(ingredients)).slice(0, 8),
    pill,
    about,
    use,
    side_effects,
    interactions,
    full_label: (medlineplusUrl || openfdaUrl)
      ? { medlineplus_url: medlineplusUrl || undefined, openfda_url: openfdaUrl || undefined }
      : null,
    fetched_at: new Date().toISOString(),
    warnings,
  };

  await cachePut(admin, cacheKey, inputName, payload);

  return jsonResp({ ...payload, cached: false }, 200, cors);
});
