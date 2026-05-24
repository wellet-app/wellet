// Supabase Edge Function: fetch-ehr-document
// Fetches the contents of a DocumentReference attachment (After Visit Summary,
// Provider note, etc.) from the connected EHR on demand. The attachment URL is
// stored with the visit record; this function proxies the request using the
// person's stored access token so the browser never sees EHR credentials.
//
// Returns:
//   { content_type: string, data_base64: string, title?: string }
// Frontend can render by building a data URL: `data:${content_type};base64,${data_base64}`.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';

function getAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(supabaseUrl, supabaseServiceKey);
}

async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return null;
  return user;
}

// Encode ArrayBuffer → base64 in chunks (avoids call-stack overflow on big files)
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk) as number[]);
  }
  return btoa(binary);
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  function jsonResponse(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const { person_id, document_url, document_id } = body;
    console.log('fetch-ehr-document request', {
      has_person_id: !!person_id,
      has_document_id: !!document_id,
      has_document_url: !!document_url,
      document_url_preview: document_url ? String(document_url).slice(0, 120) : '',
      document_id_preview: document_id ? String(document_id).slice(0, 60) : '',
    });
    if (!person_id) return jsonResponse({ error: 'person_id is required' }, 400);
    if (!document_url && !document_id) {
      return jsonResponse({ error: 'document_url or document_id is required' }, 400);
    }

    const admin = getAdminClient();

    // Load EHR connections for this person. There may be multiple rows because:
    //   (a) the user has more than one hospital connected (e.g. Duke + VA), or
    //   (b) reconnects leave behind `superseded` rows alongside the live one.
    // Both cases broke the previous .single() lookup — it threw and we returned
    // a misleading 404 to the browser. Fix: pull all rows for this person and
    // pick the right one by status + (optional) FHIR origin match.
    const { data: conns, error: connError } = await admin.from('ehr_connections')
      .select('*')
      .eq('person_id', person_id)
      .eq('user_id', user.id);

    if (connError || !conns || conns.length === 0) {
      console.error('No ehr_connections rows', { person_id, user_id: user.id, connError });
      return jsonResponse({ error: 'No EHR connection found for this person' }, 404);
    }

    // Prefer rows with status='connected' and a present access_token.
    const liveConns = conns.filter((c) => c.status === 'connected' && c.access_token);
    let candidates = liveConns.length > 0 ? liveConns : conns.filter((c) => !!c.access_token);

    // If a document_url is supplied, prefer the connection whose fhir_base_url
    // matches the document URL's origin. This disambiguates Duke vs VA cleanly.
    let conn: Record<string, unknown> | null = null;
    if (document_url) {
      try {
        const docOrigin = new URL(document_url).origin;
        const originMatch = candidates.find((c) => {
          if (!c.fhir_base_url) return false;
          try { return new URL(c.fhir_base_url as string).origin === docOrigin; }
          catch { return false; }
        });
        if (originMatch) conn = originMatch;
      } catch { /* fall through */ }
    }

    // Fallback: take the most recently connected live row.
    if (!conn && candidates.length > 0) {
      candidates = candidates.slice().sort((a, b) => {
        const ta = a.connected_at ? new Date(a.connected_at as string).getTime() : 0;
        const tb = b.connected_at ? new Date(b.connected_at as string).getTime() : 0;
        return tb - ta;
      });
      conn = candidates[0];
    }

    if (!conn || !conn.access_token) {
      return jsonResponse({ error: 'No EHR connection found for this person' }, 404);
    }

    if (conn.token_expires_at && new Date(conn.token_expires_at as string) <= new Date()) {
      return jsonResponse({ error: 'Token expired. Please reconnect to Epic MyChart.' }, 401);
    }

    const encKey = Deno.env.get('EHR_ENCRYPTION_KEY') || '';
    const { data: decAccessToken } = await admin.rpc('decrypt_ehr_token', {
      encrypted_token: conn.access_token, enc_key: encKey,
    });
    const accessToken = decAccessToken || (conn.access_token as string);
    const fhirBaseUrl = (conn.fhir_base_url as string) || 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4';

    // Resolve target URL. If document_url is provided, validate it points at the
    // connected FHIR server. Otherwise fetch the DocumentReference by id, then
    // follow the attachment URL it contains.
    let targetUrl = '';
    let attachmentContentType = '';
    if (document_url) {
      try {
        const u = new URL(document_url);
        const base = new URL(fhirBaseUrl);
        // Require same origin as the configured FHIR base URL — prevents this
        // function from being used as an open proxy.
        if (u.origin !== base.origin) {
          console.error('Origin mismatch', { doc_origin: u.origin, base_origin: base.origin });
          return jsonResponse({ error: 'Document URL origin does not match connected EHR' }, 400);
        }
        targetUrl = u.toString();
      } catch (e) {
        console.error('Invalid document_url', document_url, e);
        return jsonResponse({ error: 'Invalid document_url' }, 400);
      }
    } else {
      // No url — fetch DocumentReference first to resolve the attachment URL.
      const docRefUrl = `${fhirBaseUrl}/DocumentReference/${encodeURIComponent(document_id)}`;
      const dr = await fetch(docRefUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/fhir+json',
        },
      });
      if (!dr.ok) {
        const errBody = await dr.text().catch(() => '');
        console.error('DocumentReference fetch failed', dr.status, errBody.slice(0, 500));
        return jsonResponse({ error: `DocumentReference fetch failed (${dr.status})` }, dr.status);
      }
      const drJson = await dr.json();
      const content = (drJson.content || [])[0] || {};
      const att = content.attachment || {};
      const attUrl: string = att.url || '';
      attachmentContentType = (att.contentType as string) || '';
      if (!attUrl) {
        return jsonResponse({ error: 'DocumentReference has no attachment URL' }, 404);
      }
      try {
        const u = new URL(attUrl);
        const base = new URL(fhirBaseUrl);
        if (u.origin !== base.origin) {
          console.error('DR attachment origin mismatch', { att_origin: u.origin, base_origin: base.origin });
          return jsonResponse({ error: 'Attachment origin does not match connected EHR' }, 400);
        }
        targetUrl = u.toString();
      } catch {
        return jsonResponse({ error: 'Invalid attachment URL on DocumentReference' }, 502);
      }
    }
    console.log('Fetching attachment from', targetUrl.slice(0, 160), 'ct=', attachmentContentType);

    // Epic's Binary endpoint is picky: it requires the Accept header to match the
    // attachment's contentType, or `application/fhir+json` to get a wrapped Binary
    // resource. We prefer fhir+json so we get a consistent JSON envelope.
    const res = await fetch(targetUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': attachmentContentType
          ? `${attachmentContentType}, application/fhir+json;q=0.9`
          : 'application/fhir+json, application/octet-stream;q=0.8, application/pdf;q=0.8, text/html;q=0.8, */*;q=0.1',
      },
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error('Document fetch failed', res.status, errBody.slice(0, 500));
      return jsonResponse({ error: `Document fetch failed (${res.status})` }, res.status);
    }

    const contentType = res.headers.get('Content-Type') || 'application/octet-stream';

    // If Epic returned a FHIR Binary resource (JSON), unwrap the inline data.
    if (contentType.includes('application/fhir+json') || contentType.includes('application/json')) {
      const binary = await res.json();
      const inlineData: string = binary.data || '';
      const innerContentType: string = binary.contentType || 'application/octet-stream';
      if (!inlineData) {
        return jsonResponse({ error: 'Binary resource contained no data' }, 502);
      }
      return jsonResponse({
        content_type: innerContentType,
        data_base64: inlineData, // already base64 per FHIR Binary spec
      });
    }

    // Otherwise treat the body as the raw attachment payload
    const buf = await res.arrayBuffer();
    const dataBase64 = arrayBufferToBase64(buf);
    return jsonResponse({
      content_type: contentType,
      data_base64: dataBase64,
    });

  } catch (err) {
    console.error('fetch-ehr-document error:', err);
    return jsonResponse({ error: (err as Error).message || 'Internal server error' }, 500);
  }
});
