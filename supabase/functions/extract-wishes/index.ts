// extract-wishes v1 — AI-surfaced directives & preferences from a loved one's record
//
// Reads everything available for one person (documents, visit notes, health_events,
// Ask Wellet sessions, check_ins) and asks Azure OpenAI gpt-4o (PHI: true) to
// identify directives, preferences, and wishes that already live in the data.
// Writes each finding to public.wishes with status='suggested', a verbatim source
// quote, and provenance. Caregiver confirms in the UI.
//
// IMPORTANT: every wish MUST carry a source quote. The model is instructed to
// drop any candidate it can't quote. We never invent wishes.
//
// Invoked two ways:
//   1. On-demand from the app: POST { person_id }
//   2. Nightly cron at 03:07 ET via service-role + person_id
//
// Returns: { ok, person_id, suggested, deduped, raw_candidates }
//   suggested: # new wishes inserted as 'suggested'
//   deduped:   # candidates that matched an existing dedupe_key (skipped)
//
// Voice rules:
//   - "loved one" / "family member", never "parent"
//   - "notices" / "watches for", never "track"/"monitor"

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { aiChat } from "../_shared/azureOpenAI.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `You are reviewing a caregiver's record of their loved one to surface "wishes" — directives, preferences, or stated wants that already exist in the source material. You do not invent. You do not infer beyond what the text says.

For each wish you find, you MUST be able to quote it verbatim (or paraphrase a 1-sentence span) from the source. If you cannot quote it, drop it.

What counts as a wish:
- Code status: DNR, DNI, full code, "comfort care only", "no extraordinary measures"
- Advance directives: POLST/MOLST contents, living will instructions, healthcare proxy/POA names
- Care preferences: things the loved one wants or doesn't want in everyday care ("hates IV fluids", "wants the blue blanket", "prefers home over hospital", "always gets nauseous on opioids")
- Contacts: named POA, healthcare proxy, "call my sister first", emergency contact preferences
- Religious or cultural preferences: faith-based care choices, end-of-life rituals, dietary

What does NOT count:
- A diagnosis or medication unless it's framed as a preference ("won't take statins" counts; "takes atorvastatin 20mg" does not)
- An allergy from the allergies list (that's already tracked elsewhere)
- A clinical observation or lab value
- An appointment or visit fact

Return JSON only, matching this shape exactly:

{
  "wishes": [
    {
      "content": "short, declarative statement of the wish (max 280 chars)",
      "category": "code_status" | "advance_directive" | "care_preference" | "contact" | "religious_cultural" | "other",
      "source_type": "document" | "health_event" | "visit_attachment" | "ask_wellet_session" | "check_in",
      "source_id": "the UUID of the source row, copied verbatim from the context",
      "source_quote": "the verbatim span from the source — must appear in the context",
      "confidence": "low" | "medium" | "high"
    }
  ]
}

Confidence guide:
- high: the source explicitly states the directive ("DNR confirmed", "POA: Jane Smith")
- medium: the source clearly implies it ("she always says she doesn't want a feeding tube")
- low: the source hints at it but is ambiguous

Voice rules:
- Use "loved one" or "family member", never "parent"
- Use "notices" / "watches for", never "track"/"monitor"

Return an empty list { "wishes": [] } if nothing qualifies. Never invent.`;

function decodeJwtSub(hdr: string): string | null {
  try {
    const tok = hdr.replace(/^bearer\s+/i, '').trim();
    const parts = tok.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub ?? null;
  } catch { return null; }
}

function dateOnly(d: any): string {
  if (!d) return 'unknown';
  const s = String(d);
  return s.includes('T') ? s.split('T')[0] : s;
}

function clip(s: any, n: number): string {
  const x = String(s ?? '');
  return x.length > n ? x.slice(0, n) + '…' : x;
}

interface Candidate {
  content: string;
  category: string;
  source_type: string;
  source_id: string;
  source_quote: string;
  confidence: string;
}

const VALID_CATEGORIES = new Set([
  'code_status','advance_directive','care_preference','contact','religious_cultural','other'
]);
const VALID_SOURCE_TYPES = new Set([
  'document','health_event','visit_attachment','ask_wellet_session','check_in'
]);
const VALID_CONFIDENCE = new Set(['low','medium','high']);

function validateCandidate(c: any): Candidate | null {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.content !== 'string' || !c.content.trim()) return null;
  if (c.content.length > 2000) return null;
  if (!VALID_CATEGORIES.has(c.category)) return null;
  if (!VALID_SOURCE_TYPES.has(c.source_type)) return null;
  if (typeof c.source_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(c.source_id)) return null;
  if (typeof c.source_quote !== 'string' || !c.source_quote.trim()) return null;
  if (!VALID_CONFIDENCE.has(c.confidence)) return null;
  return {
    content: c.content.trim().slice(0, 280),
    category: c.category,
    source_type: c.source_type,
    source_id: c.source_id,
    source_quote: c.source_quote.trim().slice(0, 1500),
    confidence: c.confidence,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const person_id = body?.person_id;
    if (!person_id) {
      return new Response(
        JSON.stringify({ error: 'person_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const jwtSub = decodeJwtSub(authHeader);

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    const supabase = createClient(
      SUPABASE_URL,
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Ownership check: RLS first, service-role fallback after sub match.
    let { data: person, error: personErr } = await supabase
      .from('people').select('id, name, user_id, date_of_birth, relationship').eq('id', person_id).maybeSingle();
    if (personErr) console.warn('person RLS lookup error:', personErr.message);
    if (!person && jwtSub) {
      const { data: adminPerson } = await admin
        .from('people').select('id, name, user_id, date_of_birth, relationship').eq('id', person_id).maybeSingle();
      if (adminPerson && adminPerson.user_id === jwtSub) person = adminPerson;
    }
    if (!person) {
      return new Response(
        JSON.stringify({ error: 'Person not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    async function safeQuery(builderFn: (c: any) => any) {
      const { data, error } = await builderFn(supabase);
      if (error) console.warn('RLS read error:', error.message);
      if (data && data.length > 0) return data;
      const { data: adminData } = await builderFn(admin);
      return adminData || [];
    }

    // Pull everything in parallel.
    const [docs, events, visitAttach, checkIns] = await Promise.all([
      safeQuery((c) => c.from('documents')
        .select('id, file_name, document_type, extracted_events, extraction_status, created_at')
        .eq('person_id', person_id)
        .eq('extraction_status', 'completed')
        .order('created_at', { ascending: false })
        .limit(50)),
      safeQuery((c) => c.from('health_events')
        .select('id, event_type, event_date, title, notes, source')
        .eq('person_id', person_id)
        .order('event_date', { ascending: false })
        .limit(200)),
      safeQuery((c) => c.from('visit_attachments')
        .select('id, file_name, kind, note, created_at')
        .eq('person_id', person_id)
        .order('created_at', { ascending: false })
        .limit(40)),
      safeQuery((c) => c.from('check_ins')
        .select('id, checked_in_at, mood, notes')
        .eq('person_id', person_id)
        .not('notes', 'is', null)
        .order('checked_in_at', { ascending: false })
        .limit(40)),
    ]);

    // Build a sectioned context the model can search. Each row carries its UUID
    // so the model can use it as source_id and we can validate.
    const sections: string[] = [];

    sections.push(`LOVED ONE: ${person.name}${person.relationship ? ` (relationship: ${person.relationship})` : ''}`);

    if (docs.length) {
      sections.push('\n=== DOCUMENTS ===');
      for (const d of docs as any[]) {
        const raw = d.extracted_events;
        // extracted_events can be:
        //   - an array of events [{title, summary, notes}, ...]
        //   - an object { transcript, summary, items } from voice notes / PDF extraction v27+
        //   - null / missing
        let body = '';
        if (Array.isArray(raw) && raw.length) {
          body = raw.map((e: any) => clip(`${e.title || e.type || 'event'}: ${e.summary || e.notes || ''}`, 400)).join(' | ');
        } else if (raw && typeof raw === 'object') {
          const parts: string[] = [];
          if (typeof raw.transcript === 'string' && raw.transcript.trim()) {
            parts.push(`transcript: ${clip(raw.transcript, 4000)}`);
          }
          if (typeof raw.summary === 'string' && raw.summary.trim()) {
            parts.push(`summary: ${clip(raw.summary, 1500)}`);
          }
          if (Array.isArray(raw.items) && raw.items.length) {
            const itemsText = raw.items
              .map((it: any) => clip(`${it.title || it.type || 'item'}: ${it.summary || it.notes || it.value || ''}`, 300))
              .join(' | ');
            if (itemsText.trim()) parts.push(`items: ${itemsText}`);
          }
          body = parts.join('\n  ');
        }
        if (!body) body = '(no extracted events)';
        sections.push(`[document source_id=${d.id}] ${d.document_type || 'document'} "${d.file_name || 'unnamed'}" (${dateOnly(d.created_at)})\n  ${body}`);
      }
    }

    if (events.length) {
      sections.push('\n=== HEALTH EVENTS ===');
      for (const e of events as any[]) {
        const notes = clip(e.notes, 600);
        if (!notes) continue;  // skip empty-notes rows — nothing to extract
        sections.push(`[health_event source_id=${e.id}] ${e.event_type} ${dateOnly(e.event_date)} — ${clip(e.title, 120)}\n  ${notes}`);
      }
    }

    if (visitAttach.length) {
      sections.push('\n=== VISIT ATTACHMENTS ===');
      for (const v of visitAttach as any[]) {
        if (!v.note) continue;
        sections.push(`[visit_attachment source_id=${v.id}] ${v.kind || 'attachment'} "${v.file_name || ''}" (${dateOnly(v.created_at)})\n  ${clip(v.note, 500)}`);
      }
    }

    if (checkIns.length) {
      sections.push('\n=== CAREGIVER CHECK-INS ===');
      for (const c of checkIns as any[]) {
        sections.push(`[check_in source_id=${c.id}] ${dateOnly(c.checked_in_at)}\n  ${clip(c.notes, 500)}`);
      }
    }

    const contextBlock = sections.join('\n');
    const contextSize = contextBlock.length;
    console.log('extract-wishes context built', { person_id, sections: sections.length, chars: contextSize });

    // Guardrail: if there's nothing to read, return early with a clear signal.
    if (contextSize < 100) {
      return new Response(
        JSON.stringify({ ok: true, person_id, suggested: 0, deduped: 0, raw_candidates: 0, reason: 'not enough source material' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Cap context to ~120K chars (~30K tokens) — well under gpt-4o's 128K window.
    const MAX_CONTEXT = 120_000;
    const trimmedContext = contextBlock.length > MAX_CONTEXT
      ? contextBlock.slice(0, MAX_CONTEXT) + '\n[…truncated]'
      : contextBlock;

    // Call Azure gpt-4o.
    let raw = '';
    try {
      const result = await aiChat({
        model: 'gpt-4o',
        phi: true,
        max_tokens: 2000,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Review this record and return wishes as JSON.\n\n${trimmedContext}` },
        ],
      });
      raw = result.content || '';
    } catch (e) {
      console.error('extract-wishes Azure call failed:', (e as Error).message);
      return new Response(
        JSON.stringify({ error: 'extraction failed', detail: (e as Error).message }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let parsed: any;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      console.warn('extract-wishes JSON parse failed:', raw.slice(0, 300));
      return new Response(
        JSON.stringify({ error: 'model returned malformed JSON' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const rawCandidates = Array.isArray(parsed?.wishes) ? parsed.wishes : [];
    console.log('extract-wishes raw candidates', { person_id, count: rawCandidates.length });

    // Validate each candidate; drop malformed ones. Cap at 50/run.
    const validated: Candidate[] = [];
    for (const c of rawCandidates.slice(0, 50)) {
      const v = validateCandidate(c);
      if (v) validated.push(v);
    }

    // Insert with ON CONFLICT DO NOTHING on dedupe_key — repeated runs won't duplicate.
    let suggested = 0;
    let deduped = 0;
    if (validated.length) {
      const rows = validated.map(v => ({
        person_id,
        content: v.content,
        category: v.category,
        source_type: v.source_type,
        source_id: v.source_id,
        source_quote: v.source_quote,
        confidence: v.confidence,
        status: 'suggested',
      }));
      const { data: inserted, error: insertErr } = await admin
        .from('wishes')
        .upsert(rows, { onConflict: 'dedupe_key', ignoreDuplicates: true })
        .select('id');
      if (insertErr) {
        console.error('extract-wishes insert failed:', insertErr.message);
        return new Response(
          JSON.stringify({ error: 'insert failed', detail: insertErr.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      suggested = (inserted || []).length;
      deduped = rows.length - suggested;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        person_id,
        suggested,
        deduped,
        raw_candidates: rawCandidates.length,
        validated: validated.length,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('extract-wishes unexpected error:', (e as Error).message);
    return new Response(
      JSON.stringify({ error: 'unexpected', detail: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
