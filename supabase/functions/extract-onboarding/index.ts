// Supabase Edge Function: extract-onboarding
// Called during upload-first onboarding to extract patient name,
// conditions, and medications from uploaded files (EHR ZIPs, images, PDFs).
// Returns structured data for the name confirmation screen.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? '';

  // Authenticate the caller
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return jsonResponse({ error: 'No authorization header' }, 401);
  }

  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const anonClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userError } = await anonClient.auth.getUser();
  if (userError || !user) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // Service-role client for storage access
  const db = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { paths, user_id } = await req.json();
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return jsonResponse({ error: 'paths array required' }, 400);
    }

    // Verify user_id matches authenticated user
    if (user_id !== user.id) {
      return jsonResponse({ error: 'User mismatch' }, 403);
    }

    // Aggregate extraction results across all files
    let patientName: string | null = null;
    const allConditions: string[] = [];
    const allMedications: Array<{ name: string; dose?: string; frequency?: string }> = [];
    const allAllergies: string[] = [];
    let docCount = 0;
    const errors: Array<{ file: string; message: string }> = [];

    for (const filePath of paths) {
      try {
        const { data: fileData, error: dlError } = await db.storage
          .from('documents')
          .download(filePath);

        if (dlError || !fileData) {
          errors.push({ file: filePath, message: dlError?.message || 'Download failed' });
          continue;
        }

        const ext = filePath.split('.').pop()?.toLowerCase() || '';

        if (ext === 'zip') {
          // ZIP: Unzip in-memory, find CDA XMLs, parse structured data
          const zipBuffer = new Uint8Array(await fileData.arrayBuffer());
          const result = await processZipFile(zipBuffer);
          if (result.patientName && !patientName) patientName = result.patientName;
          allConditions.push(...result.conditions);
          allMedications.push(...result.medications);
          allAllergies.push(...result.allergies);
          docCount += result.docCount;
        } else if (['jpg', 'jpeg', 'png', 'heic', 'webp'].includes(ext)) {
          // IMAGE: Use AI vision to extract health data
          if (openaiKey) {
            const imageBytes = new Uint8Array(await fileData.arrayBuffer());
            const base64 = btoa(String.fromCharCode(...imageBytes));
            const mimeType = ext === 'png' ? 'image/png' : ext === 'heic' ? 'image/heic' : 'image/jpeg';
            const aiResult = await extractWithVision(openaiKey, base64, mimeType);
            if (aiResult.patientName && !patientName) patientName = aiResult.patientName;
            allConditions.push(...aiResult.conditions);
            allMedications.push(...aiResult.medications);
            docCount += 1;
          } else {
            docCount += 1;
          }
        } else if (ext === 'pdf') {
          // PDF: count for now, full text extraction later
          docCount += 1;
        } else {
          docCount += 1;
        }
      } catch (e) {
        errors.push({ file: filePath, message: (e as Error).message });
      }
    }

    // Deduplicate
    const uniqueConditions = [...new Set(allConditions)];
    const uniqueAllergies = [...new Set(allAllergies)];
    const uniqueMeds = deduplicateMeds(allMedications);

    return jsonResponse({
      patient_name: patientName,
      conditions: uniqueConditions,
      medications: uniqueMeds,
      allergies: uniqueAllergies,
      doc_count: docCount,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (e) {
    console.error('extract-onboarding error:', e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});


// ── ZIP PROCESSING ──────────────────────────────────────────────────────────

interface ZipResult {
  patientName: string | null;
  conditions: string[];
  medications: Array<{ name: string; dose?: string; frequency?: string }>;
  allergies: string[];
  docCount: number;
}

async function processZipFile(zipBuffer: Uint8Array): Promise<ZipResult> {
  let patientName: string | null = null;
  const conditions: string[] = [];
  const medications: Array<{ name: string; dose?: string; frequency?: string }> = [];
  const allergies: string[] = [];
  let docCount = 0;

  try {
    // Dynamic import fflate for ZIP decompression
    const { unzipSync } = await import('npm:fflate@0.8.2');
    const files = unzipSync(zipBuffer);

    for (const path in files) {
      const lower = path.toLowerCase();

      // Skip directories, metadata, and OS junk
      if (lower.endsWith('/') || lower.includes('__macosx') || lower.includes('.ds_store')) continue;

      if (lower.endsWith('.xml') && !lower.endsWith('metadata.xml')) {
        const content = new TextDecoder().decode(files[path]);

        // Only process CDA clinical documents
        if (content.includes('ClinicalDocument') || content.includes('urn:hl7-org:v3')) {
          const parsed = parseCdaXml(content);
          if (parsed.patientName && !patientName) patientName = parsed.patientName;
          conditions.push(...parsed.conditions);
          medications.push(...parsed.medications);
          allergies.push(...parsed.allergies);
          docCount++;
        }
      } else if (lower.endsWith('.pdf') || lower.endsWith('.jpg') || lower.endsWith('.png')) {
        docCount++;
      }
    }
  } catch (e) {
    console.error('ZIP extraction error:', e);
  }

  return { patientName, conditions, medications, allergies, docCount };
}


// ── CDA XML PARSER ──────────────────────────────────────────────────────────
// Pragmatic regex-based parser for C-CDA documents.
// Extracts common fields from Epic MyChart, Cerner, and generic C-CDA exports.

interface CdaParsed {
  patientName: string | null;
  conditions: string[];
  medications: Array<{ name: string; dose?: string; frequency?: string }>;
  allergies: string[];
}

// Regex patterns compiled once
const RE_ANY = '[\\s\\S]'; // matches any char including newlines
const RE_PATIENT = new RegExp('<patient[^>]*>' + RE_ANY + '*?</patient>', 'i');
const RE_ENTRY = new RegExp('<entry' + RE_ANY + '*?</entry>', 'gi');
const RE_SECTION = new RegExp('<section' + RE_ANY + '*?</section>', 'gi');
const RE_TEXT_BLOCK = new RegExp('<text' + RE_ANY + '*?</text>', 'i');
const RE_PARTICIPANT = new RegExp('<participant' + RE_ANY + '*?</participant>', 'i');
const RE_TD = /<td[^>]*>([^<]+)<\/td>/gi;
const RE_DATE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

function parseCdaXml(xml: string): CdaParsed {
  let patientName: string | null = null;
  const conditions: string[] = [];
  const medications: Array<{ name: string; dose?: string }> = [];
  const allergies: string[] = [];

  try {
    // Patient Name
    const patientMatch = xml.match(RE_PATIENT);
    if (patientMatch) {
      const block = patientMatch[0];
      const given = extractTagText(block, 'given');
      const family = extractTagText(block, 'family');
      if (given || family) {
        patientName = [given, family].filter(Boolean).join(' ').trim();
      }
    }

    // Conditions / Problems (LOINC 11450-4, 11348-0)
    const problemSections = findSectionsByLoinc(xml, ['11450-4', '11348-0']);
    for (const section of problemSections) {
      const entries = matchAll(section, RE_ENTRY);
      for (const entry of entries) {
        const name = extractDisplayName(entry, 'value') || extractDisplayName(entry, 'code');
        if (name && name.length > 2 && !isGarbageValue(name)) {
          conditions.push(name);
        }
      }
      const textConditions = extractNarrativeTableItems(section);
      for (const tc of textConditions) {
        if (!conditions.some(c => c.toLowerCase() === tc.toLowerCase())) {
          conditions.push(tc);
        }
      }
    }

    // Medications (LOINC 10160-0)
    const medSections = findSectionsByLoinc(xml, ['10160-0']);
    for (const section of medSections) {
      const entries = matchAll(section, RE_ENTRY);
      for (const entry of entries) {
        let medName = extractNestedDisplayName(entry, 'manufacturedMaterial');
        if (!medName || isGarbageValue(medName)) {
          const refId = extractReference(entry);
          if (refId) medName = resolveReference(section, refId);
        }
        if (!medName || isGarbageValue(medName)) {
          medName = extractDisplayName(entry, 'code');
        }
        if (medName && medName.length > 2 && !isGarbageValue(medName)) {
          const doseMatch = entry.match(/<doseQuantity[^>]*value="([^"]+)"[^>]*unit="([^"]+)"/i);
          const dose = doseMatch ? doseMatch[1] + ' ' + doseMatch[2] : undefined;
          medications.push({ name: medName, dose });
        }
      }
    }

    // Allergies (LOINC 48765-2)
    const allergySections = findSectionsByLoinc(xml, ['48765-2']);
    for (const section of allergySections) {
      const entries = matchAll(section, RE_ENTRY);
      for (const entry of entries) {
        const participantMatch = entry.match(RE_PARTICIPANT);
        let allergen: string | null = null;
        if (participantMatch) {
          allergen = extractDisplayName(participantMatch[0], 'code');
        }
        if (!allergen || isGarbageValue(allergen)) {
          allergen = extractDisplayName(entry, 'value');
        }
        if (!allergen || isGarbageValue(allergen)) {
          const refId = extractReference(entry);
          if (refId) allergen = resolveReference(section, refId);
        }
        if (allergen && allergen.length > 1 && !isGarbageValue(allergen)) {
          allergies.push(allergen);
        }
      }
    }
  } catch (e) {
    console.error('CDA parse error:', e);
  }

  return { patientName, conditions, medications, allergies };
}


// ── XML UTILITY FUNCTIONS ───────────────────────────────────────────────────

function matchAll(text: string, re: RegExp): string[] {
  // Reset global regex and collect all matches
  const results: string[] = [];
  const copy = new RegExp(re.source, re.flags);
  let m;
  while ((m = copy.exec(text)) !== null) {
    results.push(m[0]);
  }
  return results;
}

function extractTagText(xml: string, tagName: string): string | null {
  const re = new RegExp('<' + tagName + '[^>]*>([^<]*)</' + tagName + '>', 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : null;
}

function extractDisplayName(xml: string, tagName: string): string | null {
  const re = new RegExp('<' + tagName + '[^>]*displayName="([^"]+)"', 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : null;
}

function extractNestedDisplayName(xml: string, containerTag: string): string | null {
  const re = new RegExp('<' + containerTag + RE_ANY + '*?</' + containerTag + '>', 'i');
  const match = xml.match(re);
  if (!match) return null;
  const codeMatch = match[0].match(/displayName="([^"]+)"/i);
  return codeMatch ? codeMatch[1].trim() : null;
}

function extractReference(entry: string): string | null {
  const match = entry.match(/<reference\s+value="#([^"]+)"/i);
  return match ? match[1] : null;
}

function resolveReference(section: string, refId: string): string | null {
  const re1 = new RegExp('ID="' + refId + '"[^>]*>([^<]+)<', 'i');
  const re2 = new RegExp('id="' + refId + '"[^>]*>([^<]+)<', 'i');
  for (const re of [re1, re2]) {
    const match = section.match(re);
    if (match && match[1].trim().length > 1) {
      return match[1].trim();
    }
  }
  return null;
}

function findSectionsByLoinc(xml: string, loincCodes: string[]): string[] {
  const sections: string[] = [];
  const sectionMatches = matchAll(xml, RE_SECTION);
  for (const s of sectionMatches) {
    for (const code of loincCodes) {
      if (s.includes('code="' + code + '"') || s.includes('"' + code + '"')) {
        sections.push(s);
        break;
      }
    }
  }
  return sections;
}

function extractNarrativeTableItems(section: string): string[] {
  const items: string[] = [];
  const textMatch = section.match(RE_TEXT_BLOCK);
  if (!textMatch) return items;
  const tdMatches = matchAll(textMatch[0], RE_TD);
  for (const td of tdMatches) {
    const content = td.replace(/<[^>]+>/g, '').trim();
    if (content.length > 3 && !isTableLabel(content)) {
      items.push(content);
    }
  }
  return items;
}

function isGarbageValue(val: string): boolean {
  const garbage = [
    'active', 'inactive', 'resolved', 'other', 'unknown',
    'see comments', 'low criticality', 'high criticality',
    'no known', 'none', 'n/a', 'null', 'unspecified'
  ];
  return garbage.includes(val.toLowerCase().trim());
}

function isTableLabel(val: string): boolean {
  const labels = [
    'status', 'severity', 'date', 'name', 'dose', 'frequency',
    'active', 'inactive', 'yes', 'no', 'ongoing', 'route', 'oral'
  ];
  return labels.includes(val.toLowerCase().trim()) || RE_DATE.test(val);
}


// ── AI VISION EXTRACTION ────────────────────────────────────────────────────

interface VisionResult {
  patientName: string | null;
  conditions: string[];
  medications: Array<{ name: string; dose?: string }>;
}

async function extractWithVision(
  apiKey: string,
  base64Image: string,
  mimeType: string
): Promise<VisionResult> {
  const result: VisionResult = { patientName: null, conditions: [], medications: [] };

  try {
    const systemPrompt = [
      'You are a medical document reader for a caregiver health app.',
      'Extract structured data from health documents.',
      '',
      'Return ONLY valid JSON with this exact structure:',
      '{ "patient_name": "First Last" or null,',
      '  "conditions": ["condition 1", "condition 2"],',
      '  "medications": [{"name": "med name", "dose": "dose info"}] }',
      '',
      'Rules:',
      '- patient_name: the patient name if visible. Not the doctor name.',
      '- conditions: diagnosed conditions, illnesses, problems mentioned',
      '- medications: medication names with dosages if visible',
      '- If you cannot find a field, use null or empty array',
      '- Be precise: only include what you can clearly read'
    ].join('\n');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1000,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extract the patient name, conditions, and medications from this health document.' },
              { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64Image } }
            ]
          }
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      console.error('OpenAI API error:', response.status, await response.text());
      return result;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return result;

    const parsed = JSON.parse(content);
    result.patientName = parsed.patient_name || null;
    result.conditions = Array.isArray(parsed.conditions) ? parsed.conditions : [];
    result.medications = Array.isArray(parsed.medications) ? parsed.medications : [];
  } catch (e) {
    console.error('Vision extraction error:', e);
  }

  return result;
}


// ── DEDUPLICATION ───────────────────────────────────────────────────────────

function deduplicateMeds(
  meds: Array<{ name: string; dose?: string; frequency?: string }>
): Array<{ name: string; dose?: string; frequency?: string }> {
  const seen = new Set<string>();
  return meds.filter(m => {
    const key = m.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
