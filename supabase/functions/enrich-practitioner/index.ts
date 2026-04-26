// Supabase Edge Function: enrich-practitioner (v2)
//
// Why this exists:
//   Epic FHIR endpoints (Duke confirmed; UNC and other Epic hospitals
//   strongly suspected) return Practitioner / PractitionerRole resources
//   with telecom (phone/fax/email) and practice addresses empty. The app
//   would otherwise display "No contact info on file" for every Care
//   Team card, which is useless to families coordinating care.
//
// What this does (3-tier cascade):
//   1. practitioner_contact_cache in Supabase (30-day TTL) — keyed by
//      NPI when known, or by adapter-specific slug otherwise.
//   2. Hospital directory adapter (Tier 2.5) — high-confidence,
//      hospital-specific. Adapters live in ./adapters/*.ts and register
//      themselves via ./adapters/index.ts. Today only Duke is wired up;
//      the registry exists so adding UNC/WakeMed/Cone/Atrium is a new
//      adapter file plus one registerAdapter() line.
//   3. NPPES NPI registry — federal Tier 3 fallback. Always available
//      but addresses can be years stale, so confidence = "medium".
//
// Returns a Wellet-shaped practitioner contact object plus source
// attribution so the UI can render "Phone: … · from Duke Health".
//
// Safety:
//   - Never writes to any FHIR resource.
//   - Never writes to ehr_connections or any patient-scoped table.
//   - Only writes to the dedicated practitioner_contact_cache table
//     (non-PHI: public directory info keyed by NPI / slug).
//   - All external HTTP calls have 8-second timeouts inside the adapters.
//   - Fails soft: if every source misses, returns { found: false }
//     instead of 500'ing the card.
//
// v2 refactor (multi-hospital/registry-refactor branch):
//   The previously inlined dukehealth.org lookup moved to
//   ./adapters/duke.ts. Behavior for Duke is intentionally identical —
//   same URL pattern, same regexes, same lookup_key shape, same
//   source_name "dukehealth.org". This refactor is observably a no-op
//   for current Duke users; its purpose is to make adding the next
//   hospital a small, contained change.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import type {
  EnrichedContact,
  EnrichInput,
} from "../_shared/practitioner-types.ts";
import {
  runDirectoryLookup,
  tentativeCacheKeysFor,
} from "../_shared/hospital-directory-registry.ts";
// Importing this file is what registers every adapter into the registry.
// Do NOT remove — it is the composition root.
import "./adapters/index.ts";

// ── Types ─────────────────────────────────────────────────────────────
// (Address / EnrichedContact / EnrichInput now live in
// ../_shared/practitioner-types.ts so adapters and this handler share
// one definition.)

const CACHE_TTL_DAYS = 30;
const FETCH_TIMEOUT_MS = 8_000;
const USER_AGENT =
  "Wellet/1.0 (+https://getwellet.com; contact@getwellet.com) provider-directory-lookup";

// ── Utilities ─────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status: number, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Strip common suffixes ("MD", "DO", "PhD", "RN", commas, etc.) so we can
// split a display name into first/last reliably. Used by NPPES and the
// generic name-based cache key. Adapters have their own copy because
// they may want different splitting rules per hospital.
function splitName(display: string): { first: string; last: string; credential: string } {
  if (!display) return { first: "", last: "", credential: "" };
  const m = display.match(/^(.+?)(?:,\s*)?\b(MD|DO|DDS|DMD|PA-C|PA|NP|APRN|RN|PhD|PsyD|MSN|MPH|MBA)\b\.?\s*$/i);
  let core = display;
  let credential = "";
  if (m) {
    core = m[1].trim().replace(/,+$/, "").trim();
    credential = m[2].toUpperCase();
  }
  core = core.replace(/\s+/g, " ").trim();
  const parts = core.split(" ").filter(Boolean);
  if (parts.length === 0) return { first: "", last: "", credential };
  if (parts.length === 1) return { first: "", last: parts[0], credential };
  return { first: parts[0], last: parts[parts.length - 1], credential };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function buildLookupKey(input: { npi?: string; name?: string; state?: string }): string {
  if (input.npi) return `npi:${input.npi}`;
  const n = slugify(input.name || "unknown");
  const s = (input.state || "").toLowerCase();
  return s ? `name:${n}-${s}` : `name:${n}`;
}

function cacheIsFresh(updated_at: string): boolean {
  const then = new Date(updated_at).getTime();
  const now = Date.now();
  return (now - then) < CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
}

function formatPhoneUS(digits: string): string | null {
  const d = digits.replace(/\D/g, "");
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) {
    return `${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  }
  return null;
}

// ── NPPES fallback ────────────────────────────────────────────────────
//
// https://npiregistry.cms.hhs.gov/api/?version=2.1&first_name=X&last_name=Y&state=NC&limit=5
// Notes:
//   - addresses returned can be years stale (provider's registered
//     mailing/location addresses, not current practice)
//   - "practice location" address (address_purpose=LOCATION) is usually
//     the most useful for patient-facing display.
//   - no phones are guaranteed; many records omit telephone_number.
//
// NPPES intentionally lives in the handler, not in the adapter
// registry, because:
//   (a) it's federal — not hospital-specific — so it shouldn't be
//       routed by FHIR domain.
//   (b) it's the universal fallback, always tried last.

async function lookupNppes(input: EnrichInput): Promise<EnrichedContact | null> {
  const parts = input.first_name && input.last_name
    ? { first: input.first_name, last: input.last_name, credential: "" }
    : splitName(input.name);
  if (!parts.last) return null;

  const params = new URLSearchParams({ version: "2.1", limit: "5" });
  if (input.npi) {
    params.set("number", input.npi);
  } else {
    if (parts.first) params.set("first_name", parts.first);
    params.set("last_name", parts.last);
    if (input.state) params.set("state", input.state);
  }
  const url = `https://npiregistry.cms.hhs.gov/api/?${params.toString()}`;

  let res: Response;
  try {
    res = await timedFetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let data: Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    return null;
  }

  const results = (data.results as Record<string, unknown>[]) || [];
  if (results.length === 0) return null;

  const preferred = results.find((r) => {
    const basic = (r.basic as Record<string, unknown>) || {};
    const ln = ((basic.last_name as string) || "").toLowerCase();
    return ln === parts.last.toLowerCase();
  }) || results[0];

  const basic = (preferred.basic as Record<string, unknown>) || {};
  const addrs = (preferred.addresses as Record<string, unknown>[]) || [];
  const taxonomies = (preferred.taxonomies as Record<string, unknown>[]) || [];
  const npi = (preferred.number as string) || input.npi;

  const addresses = addrs.map((a) => ({
    street: [a.address_1, a.address_2].filter(Boolean).join(", ") as string,
    city: a.city as string,
    state: a.state as string,
    zip: a.postal_code as string,
    label: a.address_purpose as string,
  }));
  const phones: string[] = [];
  for (const a of addrs) {
    const t = (a.telephone_number as string) || "";
    if (t) {
      const fmt = formatPhoneUS(t.replace(/\D/g, "")) || t;
      if (!phones.includes(fmt)) phones.push(fmt);
    }
  }
  const fax = addrs.map((a) => a.fax_number as string).find(Boolean);
  const specialty =
    (taxonomies.find((t) => (t as Record<string, unknown>).primary) as Record<string, unknown> | undefined)
      ?.desc as string
    || (taxonomies[0]?.desc as string)
    || undefined;

  const fullName = [basic.first_name, basic.last_name].filter(Boolean).join(" ") as string;

  return {
    found: true,
    lookup_key: npi ? `npi:${npi}` : buildLookupKey({ name: fullName, state: input.state }),
    name: fullName || input.name,
    npi,
    phones,
    fax: fax ? (formatPhoneUS(fax.replace(/\D/g, "")) || fax) : undefined,
    emails: [],
    addresses,
    specialty,
    source_name: "NPPES",
    source_url: `https://npiregistry.cms.hhs.gov/provider-view/${npi}`,
    // NPPES can be years stale — never claim "high" confidence.
    confidence: "medium",
  };
}

// ── Cache read/write ─────────────────────────────────────────────────

async function readCache(
  admin: ReturnType<typeof createClient>,
  lookupKey: string,
): Promise<EnrichedContact | null> {
  const { data, error } = await admin
    .from("practitioner_contact_cache")
    .select("*")
    .eq("lookup_key", lookupKey)
    .maybeSingle();
  if (error || !data) return null;
  if (!cacheIsFresh(data.updated_at)) return null;
  return {
    found: true,
    lookup_key: data.lookup_key,
    practitioner_ref: data.practitioner_ref || undefined,
    name: data.name || undefined,
    npi: data.npi || undefined,
    phones: Array.isArray(data.phones) ? data.phones : [],
    fax: data.fax || undefined,
    emails: [],
    addresses: Array.isArray(data.addresses) ? data.addresses : [],
    specialty: data.specialty || undefined,
    bio: data.bio || undefined,
    photo_url: data.photo_url || undefined,
    source_name: data.source_name || undefined,
    source_url: data.source_url || undefined,
    confidence: (data.confidence as "high" | "medium" | "low") || undefined,
    cached: true,
  };
}

async function writeCache(
  admin: ReturnType<typeof createClient>,
  c: EnrichedContact,
  practitionerRef?: string,
): Promise<void> {
  if (!c.found || !c.lookup_key) return;
  const row = {
    lookup_key: c.lookup_key,
    practitioner_ref: practitionerRef || null,
    name: c.name || null,
    npi: c.npi || null,
    phones: c.phones || [],
    fax: c.fax || null,
    addresses: c.addresses || [],
    specialty: c.specialty || null,
    bio: c.bio || null,
    photo_url: c.photo_url || null,
    source_name: c.source_name || null,
    source_url: c.source_url || null,
    confidence: c.confidence || null,
    updated_at: new Date().toISOString(),
  };
  await admin
    .from("practitioner_contact_cache")
    .upsert(row, { onConflict: "lookup_key" });
}

// ── Main handler ─────────────────────────────────────────────────────

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "No authorization header" }, 401, corsHeaders);
    }

    const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
    }

    const admin = createClient(supabaseUrl, supabaseServiceKey);

    // ── Parse + validate input ─────────────────────────────────────
    let body: EnrichInput;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
    }
    if (!body.name || typeof body.name !== "string") {
      return jsonResponse({ error: "name required" }, 400, corsHeaders);
    }

    // ── Step 1: try cache ─────────────────────────────────────────
    // Tentative keys come from the registry: NPI first (if known),
    // then each matching adapter's slug variants. If no adapters match
    // (e.g. unknown FHIR domain), we still probe the generic name+state
    // key so cache hits from prior NPPES-only lookups still work.
    const tentativeKeys = tentativeCacheKeysFor(body);
    const parts = body.first_name && body.last_name
      ? { first: body.first_name, last: body.last_name }
      : splitName(body.name);
    if (parts.first && parts.last) {
      tentativeKeys.push(buildLookupKey({
        name: `${parts.first} ${parts.last}`,
        state: body.state,
      }));
    }
    for (const key of tentativeKeys) {
      const hit = await readCache(admin, key);
      if (hit) {
        return jsonResponse(hit, 200, corsHeaders);
      }
    }

    // ── Step 2: hospital directory adapter (Tier 2.5) ────────────
    // The router picks adapters whose fhir_domains or hint_org_keywords
    // match the input. If nothing matches, runDirectoryLookup returns
    // null immediately (no network calls) and we fall through to NPPES.
    let result: EnrichedContact | null = await runDirectoryLookup(body);

    // ── Step 3: NPPES fallback (Tier 3) ──────────────────────────
    if (!result) {
      result = await lookupNppes(body);
    }

    if (!result) {
      return jsonResponse(
        {
          found: false,
          phones: [],
          emails: [],
          addresses: [],
          searched_sources: ["hospital_directory", "NPPES"],
        },
        200,
        corsHeaders,
      );
    }

    // ── Step 4: cache + return ──────────────────────────────────
    try {
      await writeCache(admin, result, body.practitioner_ref);
    } catch (_) {
      // caching is best-effort — never fail the request on a cache write error
    }

    return jsonResponse(result, 200, corsHeaders);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      { error: "enrich-practitioner failed", detail: msg },
      500,
      getCorsHeaders(req),
    );
  }
});
