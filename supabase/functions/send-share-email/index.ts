// Supabase Edge Function: send-share-email
// Sends health update share emails via Brevo SMTP.
// POST body: { to: [{email, name}], person_name, sender_name, share_url, summary_text, include_meds, medications }
// Returns: { success: true, sent: number }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';

const BREVO_SMTP_URL = 'https://api.brevo.com/v3/smtp/email';
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') ?? '';

function buildEmailHtml(
  personName: string,
  senderName: string,
  shareUrl: string,
  summaryText: string,
  includeMeds: boolean,
  medications: { name: string; dose?: string; frequency?: string }[]
): string {
  const medsHtml = includeMeds && medications && medications.length > 0
    ? `<div style="margin:20px 0 0;">
        <div style="font-size:13px;font-weight:600;color:#2C2A26;margin-bottom:8px;">Current Medications</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          ${medications.map(m =>
            `<tr style="border-bottom:1px solid #eee;">
              <td style="padding:6px 0;color:#2C2A26;">${escHtml(m.name)}</td>
              <td style="padding:6px 0;color:#6B6560;text-align:right;">${escHtml(m.dose || '')}${m.frequency ? ' · ' + escHtml(m.frequency) : ''}</td>
            </tr>`
          ).join('')}
        </table>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f3f0;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:20px;">
    <!-- Header -->
    <div style="background:#608F7C;border-radius:12px 12px 0 0;padding:20px 24px;">
      <div style="font-family:'DM Serif Display',Georgia,serif;font-size:22px;color:white;letter-spacing:0.01em;">Wellet</div>
    </div>
    <!-- Body -->
    <div style="background:white;padding:28px 24px;border-radius:0 0 12px 12px;">
      <div style="font-size:15px;color:#2C2A26;line-height:1.6;margin-bottom:20px;">
        <strong>${escHtml(senderName)}</strong> shared a health update for <strong>${escHtml(personName)}</strong> with you.
      </div>
      <div style="background:#f5f3f0;border-radius:10px;padding:16px 18px;margin-bottom:20px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6B6560;font-weight:500;margin-bottom:6px;">Summary</div>
        <div style="font-size:14px;color:#2C2A26;line-height:1.55;">${escHtml(summaryText)}</div>
      </div>
      ${medsHtml}
      <div style="margin-top:24px;text-align:center;">
        <a href="${escHtml(shareUrl)}" style="display:inline-block;background:#608F7C;color:white;text-decoration:none;padding:12px 32px;border-radius:10px;font-size:14px;font-weight:500;">View Full Summary</a>
      </div>
      <div style="font-size:11px;color:#A09B96;margin-top:20px;text-align:center;">This link expires in 7 days.</div>
    </div>
    <!-- Footer -->
    <div style="text-align:center;padding:20px 0;font-size:11px;color:#A09B96;line-height:1.6;">
      Sent via <a href="https://mywellet.com" style="color:#608F7C;text-decoration:none;">Wellet</a> &middot; mywellet.com<br>
      The AI care companion for families
    </div>
  </div>
</body>
</html>`;
}

function escHtml(text: string): string {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

    // Verify the user with their JWT
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const { to, person_name, sender_name, share_url, summary_text, include_meds, medications } = body;

    if (!to || !Array.isArray(to) || to.length === 0) {
      return new Response(JSON.stringify({ error: 'At least one recipient is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!person_name || !share_url) {
      return new Response(JSON.stringify({ error: 'person_name and share_url are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const senderDisplay = sender_name || user.email || 'A Wellet user';
    const subject = `${senderDisplay} shared a health update for ${person_name} — Wellet`;
    const htmlContent = buildEmailHtml(
      person_name,
      senderDisplay,
      share_url,
      summary_text || '',
      include_meds !== false,
      medications || []
    );

    // Send via Brevo transactional email API
    const brevoPayload = {
      sender: { name: 'Wellet', email: 'hello@mywellet.com' },
      to: to.map((r: { email: string; name?: string }) => ({
        email: r.email,
        name: r.name || r.email,
      })),
      subject,
      htmlContent,
    };

    const brevoResp = await fetch(BREVO_SMTP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': BREVO_API_KEY,
      },
      body: JSON.stringify(brevoPayload),
    });

    if (!brevoResp.ok) {
      const errText = await brevoResp.text();
      console.error('Brevo error:', brevoResp.status, errText);
      return new Response(JSON.stringify({ error: 'Failed to send email', details: errText }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true, sent: to.length }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('send-share-email error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
