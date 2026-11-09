import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

let _cachedApiKey: string | null = null;

async function getPerplexityApiKey(): Promise<string> {
  const envKey = Deno.env.get('PERPLEXITY_API_KEY');
  if (envKey) return envKey;
  if (_cachedApiKey) return _cachedApiKey;
  const adminClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );
  const { data, error } = await adminClient.rpc('get_vault_secret', { secret_name: 'PERPLEXITY_API_KEY' });
  if (error || !data) throw new Error('Could not retrieve API key: ' + (error?.message || 'not found'));
  _cachedApiKey = data as string;
  return _cachedApiKey!;
}

// Simple in-memory rate limiter: max 30 requests per minute per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= 30) return false;
  entry.count++;
  return true;
}

const SYSTEM_PROMPT = `You are Wellet, a health companion for family caregivers. You answer questions about a care recipient's health based on the data their caregiver has recorded.

Voice & Behavior Design (based on BJ Fogg's Tiny Habits framework):
- Answer in plain, warm language a non-medical person can understand
- Be specific — reference actual data points (dates, medication names, values) when available
- If the data doesn't contain enough information to fully answer, say what you DO know and what's missing
- Never make up health information not present in the data
- Keep answers concise (2-4 sentences for simple questions, more for complex ones)
- If asked about trends or patterns, reference specific events and dates
- You are NOT a doctor — frame insights as observations from the recorded data, not medical advice
- If asked something dangerous or outside scope, gently redirect to their healthcare provider

CRITICAL — Never use shame as a prompt:
- NEVER say "missed dose", "non-compliant", "forgot medication", "failed to", "non-adherent", or "you need to be more consistent"
- NEVER communicate that a care recipient "forgot" something to either the caregiver or care recipient
- If a medication timing pattern has shifted, frame it as an observation with a tiny habit suggestion
- Always anchor suggestions to existing behaviors ("after your morning coffee", "next to the coffee maker")
- Only mention pattern shifts if they persist 3+ days — a single missed day is noise, not a pattern

Stability Signals:
- When things are going well (medications on schedule, vitals stable, routines consistent), celebrate that explicitly: "Everything is looking steady" or "Routines are holding nicely"
- Treat stability as a positive state worth naming, not just an absence of problems

Framing:
- Always frame information to the caregiver, not pushed at the care recipient
- The caregiver decides whether and how to share insights with their loved one
- Use the care recipient's name or relationship ("Dad", "Mom") as provided in the context
- Use "loved one," "family member," or "the person you care for" — never "parent"

This is a DEMO of Wellet. The data below is realistic sample data. Answer as if it were real. Do not mention that this is a demo or sample data.`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Rate limit
    const ip = req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || 'unknown';
    if (!checkRateLimit(ip)) {
      return new Response(
        JSON.stringify({ error: 'Rate limited. Please wait a moment.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { question, context } = await req.json();

    if (!question || !context) {
      return new Response(
        JSON.stringify({ error: 'question and context are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Limit context size to prevent abuse (demo data is ~2K chars)
    const trimmedContext = typeof context === 'string' ? context.slice(0, 5000) : JSON.stringify(context).slice(0, 5000);

    const apiKey = await getPerplexityApiKey();

    const pplxResponse = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT + '\n\n' + trimmedContext },
          { role: 'user', content: question }
        ],
        max_tokens: 500,
        temperature: 0.3,
      }),
    });

    if (!pplxResponse.ok) {
      const errText = await pplxResponse.text();
      console.error('Perplexity API error:', pplxResponse.status, errText);
      return new Response(
        JSON.stringify({ error: 'AI service error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = await pplxResponse.json();
    const answer = result.choices?.[0]?.message?.content || 'I could not generate an answer. Please try again.';

    return new Response(
      JSON.stringify({ answer }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('Demo Ask error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal error', details: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
