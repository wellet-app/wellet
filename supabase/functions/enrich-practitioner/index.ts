// Supabase Edge Function: enrich-practitioner (v1)
//
// Why this exists:
//   Duke Health's Epic FHIR R4 endpoint returns Practitioner and
//   PractitionerRole resources without telecom (phone/fax/email) or
//   practice addresses populated. fetch-ehr-data captures telemetry
//   confirming this across every practitioner we've tried. The app
//   displays "No contact info on file" for every Care Team card, which
//   is useless to families coordinating care.
//
// What this does:
//   Given a Practitioner name (and optional NPI / Epic reference / state),
//   look up public contact info from, in order:
//     1. practitioner_contact_cache in Supabase (30-day TTL)
//     2. dukehealth.org provider directory (primary source — clean
//        Schema.org microdata, designed for machine consumption)
//     3. NPPES NPI registry (fallback — US federal registry, always
//        available, but addresses can be years stale)
//
// Returns a Wellet-shaped practitioner contact object plus source
// attribution so the UI can render "Phone: … · from dukehealth.org".
//
// Safety:
//   - Never writes to any FHIR resource.
//   - Never writes to ehr_connections or any patient-scoped table.
//   - Only writes to the dedicated practitioner_contact_cache table
//     (non-PHI: public directory info keyed by NPI).
//   - All external HTTP calls have 8-second timeouts.
//   - Fails soft: if every source misses, returns { found: false }
//     instead of 500'ing the card.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

// ── Types ─────────────────────────────────────────────────────────────

type Address = {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  label?: string;
};

type EnrichedContact = {
  found: boolean;
  lookup_key?: string;
  practitioner_ref?: string;
  name?: string;
  npi?: string;
  phones: string[];
  fax?: string;
  emails: string[];
  addresses: Address[];
  specialty?: string;
  bio?: string;
  photo_url?: string;
  source_name?: string;  // "dukehealth.org" | "NPPES" | "cache"
  source_url?: string;
  confidence?: "high" | "medium" | "low";
  cached?: boolean;
};

type EnrichInput = {
  // At minimum we need a name. Everything else sharpens the match.
  name: string;               // full display name e.g. "Jaseela Illath, MD"
  first_name?: string;
  last_name?: string;
  npi?: string;               // if already known from anywhere
  practitioner_ref?: string;  // Epic "Practitioner/abc123"
  state?: string;             // 2-letter, biases NPPES matches
  hint_org?: string;          // e.g. "Duke" — picks dukehealth.org first
};

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
// split a display name into first/last reliably.
function splitName(display: string): { first: string; last: string; credential: string } {
  if (!display) return { first: "", last: "", credential: "" };
  // pull trailing credential (MD, DO, PA-C, NP, RN, PhD, etc.)
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
  // Assume first token is first name, last token is last name — middle names/initials ignored.
  return { first: parts[0], last: parts[parts.length - 1], credential };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")   // strip accents
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function buildLookupKey(input: { npi?: string; dukeSlug?: string; name?: string; state?: string }): string {
  if (input.npi) return `npi:${input.npi}`;
  if (input.dukeSlug) return `duke:${input.dukeSlug}`;
  const n = slugify(input.name || "unknown");
  const s = (input.state || "").toLowerCase();
  return s ? `name:${n}-${s}` : `name:${n}`;
}

function cacheIsFresh(updated_at: string): boolean {
  const then = new Date(updated_at).getTime();
  const now = Date.now();
  return (now - then) < CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
}

// ── dukehealth.org primary source ─────────────────────────────────────
//
// URL pattern: /find-doctors-physicians/{first}-{last}-{credential}
//   e.g. /find-doctors-physicians/jaseela-illath-md
//
// The page uses Schema.org microdata: itemprop="telephone" / "fax" /
// "streetAddress" / "addressLocality" / "addressRegion" / "postalCode" /
// "description" / "image". NPI and duke_id are embedded inside a
// drupal-settings-json <script> tag as "np_id" and "duke_id".

async function lookupDukeHealth(input: EnrichInput): Promise<EnrichedContact | null> {
  const parts = input.first_name && input.last_name
    ? { first: input.first_name, last: input.last_name, credential: "" }
    : splitName(input.name);

  if (!parts.last) return null;

  // Try most common credential suffixes if none provided.
  const credentials = parts.credential
    ? [parts.credential.toLowerCase()]
    : ["md", "do", "pa-c", "pa", "np", "aprn", "rn", "phd"];

  const baseSlug = slugify([parts.first, parts.last].filter(Boolean).join(" "));
  if (!baseSlug) return null;

  for (const cred of credentials) {
    const slug = cred ? `${baseSlug}-${cred}` : baseSlug;
    const url = `https://www.dukehealth.org/find-doctors-physicians/${slug}`;
    let res: Response;
    try {
      res = await timedFetch(url);
    } catch {
      continue;
    }
    if (!res.ok) continue;

    const html = await res.text();
    // Sanity check: is this actually a provider page?
    if (!html.includes('itemprop="')) continue;

    const parsed = parseDukeHealthHtml(html, url, slug);
    if (parsed && (parsed.phones.length || parsed.fax || parsed.addresses.length)) {
      parsed.confidence = "high";
      return parsed;
    }
    // If the page loaded but we couldn't parse useful info, don't keep
    // trying other credential suffixes — we found the right person.
    if (parsed) return parsed;
  }

  return null;
}

function parseDukeHealthHtml(html: string, sourceUrl: string, slug: string): EnrichedContact | null {
  const get = (re: RegExp): string | undefined => {
    const m = html.match(re);
    return m ? m[1].trim() : undefined;
  };

  // Name (from <h1> or og:title fallback)
  const name =
    get(/<h1[^>]*itemprop="name"[^>]*>\s*([^<]+?)\s*<\/h1>/i) ||
    get(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
    "";

  // All "tel:" links — captures per-location phones (dukehealth.org
  // wraps each location's phone in <a class="phone" href="tel:...">).
  const phones: string[] = [];
  const phoneRe = /href="tel:([0-9\-+() .]+)"/gi;
  let pm: RegExpExecArray | null;
  while ((pm = phoneRe.exec(html)) !== null) {
    const normalized = pm[1].replace(/[^0-9+]/g, "").replace(/^1(\d{10})$/, "$1");
    const formatted = formatPhoneUS(normalized) || pm[1].trim();
    if (formatted && !phones.includes(formatted)) phones.push(formatted);
  }
  // Also pick up the single itemprop="telephone" in case tel: links are absent.
  const ipTel = get(/<[^>]*itemprop="telephone"[^>]*>\s*([^<]+?)\s*</i);
  if (ipTel) {
    const norm = ipTel.replace(/[^0-9+]/g, "");
    const fmt = formatPhoneUS(norm) || ipTel.trim();
    if (fmt && !phones.includes(fmt)) phones.push(fmt);
  }

  // Fax
  const faxRaw = get(/<[^>]*itemprop="fax"[^>]*>\s*([^<]+?)\s*</i);
  const fax = faxRaw ? (formatPhoneUS(faxRaw.replace(/[^0-9+]/g, "")) || faxRaw.trim()) : undefined;

  // Addresses — dukehealth.org uses a <div itemprop="address"> wrapper
  // that contains nested divs. Naively matching to the next </div>
  // closes too early. Instead, slice the HTML between each
  // itemprop="address" marker and the start of the next one (or EOF),
  // and parse each slice for the microdata fields.
  const addresses: Address[] = [];
  const addrAnchors: number[] = [];
  const anchorRe = /itemprop="address"/gi;
  let aam: RegExpExecArray | null;
  while ((aam = anchorRe.exec(html)) !== null) addrAnchors.push(aam.index);
  for (let i = 0; i < addrAnchors.length; i++) {
    const start = addrAnchors[i];
    const end = i + 1 < addrAnchors.length ? addrAnchors[i + 1] : html.length;
    // Cap the window at 4KB so we don't walk into a different logical
    // section of the page (e.g. reviews, bio) on a malformed template.
    const block = html.slice(start, Math.min(end, start + 4096));
    const a: Address = {
      street: block.match(/itemprop="streetAddress"[^>]*>\s*([^<]+?)\s*</i)?.[1]?.trim(),
      city: block.match(/itemprop="addressLocality"[^>]*>\s*([^<]+?)\s*</i)?.[1]?.trim(),
      state: block.match(/itemprop="addressRegion"[^>]*>\s*([^<]+?)\s*</i)?.[1]?.trim(),
      zip: block.match(/itemprop="postalCode"[^>]*>\s*([^<]+?)\s*</i)?.[1]?.trim(),
    };
    // Try to grab the location name that usually precedes the address
    // microdata ("Duke Primary Care of Galloway Ridge").
    const labelMatch = block.match(/class="location-name-text"[^>]*>\s*([\s\S]*?)\s*<\/a>/i);
    if (labelMatch) {
      a.label = labelMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    }
    if (a.street || a.city || a.state || a.zip) {
      addresses.push(a);
    }
  }

  // Bio (itemprop="description" — can contain HTML, so strip tags)
  const bioRaw = get(/itemprop="description"[^>]*>([\s\S]*?)<\/(?:div|p|span)>/i);
  const bio = bioRaw ? stripHtml(bioRaw).trim() : undefined;

  // Photo — og:image is the high-quality version
  const photo_url =
    get(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) ||
    get(/itemprop="image"[^>]+(?:src|content)="([^"]+)"/i);

  // NPI + specialty from embedded drupal-settings JSON
  let npi: string | undefined;
  let specialty: string | undefined;
  const drupalMatch = html.match(/drupal-settings-json[^>]*>([\s\S]*?)<\/script>/i);
  if (drupalMatch) {
    const raw = drupalMatch[1];
    const npiMatch = raw.match(/"np_id":"(\d+)"/);
    if (npiMatch) npi = npiMatch[1];
    // physicianSpecialities: {"id":"Name", ...} — pick the first
    const specMatch = raw.match(/"physicianSpecialities":\{([^}]+)\}/);
    if (specMatch) {
      const firstName = specMatch[1].match(/"\d+":"([^"]+)"/);
      if (firstName) specialty = firstName[1];
    }
  }

  if (!name && phones.length === 0 && !fax && addresses.length === 0) return null;

  return {
    found: true,
    lookup_key: npi ? `npi:${npi}` : `duke:${slug}`,
    name: decodeHtmlEntities(name),
    npi,
    phones,
    fax,
    emails: [],
    addresses,
    specialty: specialty ? decodeHtmlEntities(specialty) : undefined,
    bio: bio ? decodeHtmlEntities(bio) : undefined,
    photo_url,
    source_name: "dukehealth.org",
    source_url: sourceUrl,
    confidence: "high",
  };
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&rsquo;/g, "\u2019")
    .replace(/&lsquo;/g, "\u2018")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&nbsp;/g, " ");
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

  // Prefer an exact last-name match. If multiple, return the first —
  // NPPES orders by NPI ascending which is basically arbitrary. Callers
  // should ideally pass an NPI when they have one.
  const preferred = results.find((r) => {
    const basic = (r.basic as Record<string, unknown>) || {};
    const ln = ((basic.last_name as string) || "").toLowerCase();
    return ln === parts.last.toLowerCase();
  }) || results[0];

  const basic = (preferred.basic as Record<string, unknown>) || {};
  const addrs = (preferred.addresses as Record<string, unknown>[]) || [];
  const taxonomies = (preferred.taxonomies as Record<string, unknown>[]) || [];
  const npi = (preferred.number as string) || input.npi;

  const addresses: Address[] = addrs.map((a) => ({
    street: [a.address_1, a.address_2].filter(Boolean).join(", ") as string,
    city: a.city as string,
    state: a.state as string,
    zip: a.postal_code as string,
    label: a.address_purpose as string, // "MAILING" | "LOCATION"
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
    const parts = body.first_name && body.last_name
      ? { first: body.first_name, last: body.last_name }
      : splitName(body.name);
    const tentativeKeys: string[] = [];
    if (body.npi) tentativeKeys.push(`npi:${body.npi}`);
    if (parts.first && parts.last) {
      const slug = slugify(`${parts.first} ${parts.last}`);
      // Duke-style slug with common credentials
      tentativeKeys.push(`duke:${slug}-md`);
      tentativeKeys.push(`duke:${slug}-do`);
      // Plain name+state key
      tentativeKeys.push(buildLookupKey({ name: `${parts.first} ${parts.last}`, state: body.state }));
    }
    for (const key of tentativeKeys) {
      const hit = await readCache(admin, key);
      if (hit) {
        return jsonResponse(hit, 200, corsHeaders);
      }
    }

    // ── Step 2: dukehealth.org (prefer when hint_org says Duke) ──
    // We try Duke first unconditionally because (a) it's by far the
    // highest-quality source when the provider is Duke, and (b) the
    // 404 cost is cheap — one fast request.
    let result: EnrichedContact | null = null;
    if (!body.hint_org || /duke/i.test(body.hint_org)) {
      result = await lookupDukeHealth(body);
    }

    // ── Step 3: NPPES fallback ───────────────────────────────────
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
          searched_sources: ["dukehealth.org", "NPPES"],
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
