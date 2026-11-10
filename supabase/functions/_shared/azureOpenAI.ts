// supabase/functions/_shared/azureOpenAI.ts
//
// Wellet AI vendor adapter.
//
// Single choke point for every PHI-touching AI call in the project.
//
// Compliance posture (see wellet-privacy-policy.md §1 and §4): Wellet is not
// a HIPAA covered entity, and we have not signed a BAA with any AI vendor.
// We route PHI-marked calls only to vendors that offer a BAA we could sign
// in the future, so this code stays compatible with a later compliance shift
// without rewiring call sites. The guardrails below enforce that posture.
//
// Vendor is selected by the WELLET_AI_VENDOR env var:
//   - "azure"         → Azure OpenAI Service (BAA-eligible, default for PHI)
//   - "openai_direct" → OpenAI direct API (legacy — emergency escape hatch only)
//   - "sonar"         → Perplexity Sonar (NON-PHI ONLY — adapter will throw if called for PHI paths)
//   - "bedrock"       → AWS Bedrock Claude (Phase 2, not yet implemented)
//
// Three public functions cover every call site:
//   aiChat       — text-in, text-out (or JSON-out)
//   aiTranscribe — audio-in, text-out (Whisper)
//   aiVision     — image + prompt → text
//
// Migration philosophy: keep the wrapper thin. Call sites should change by ~10–20 lines.
// One file = one vendor swap.

// =============================================================================
// Types
// =============================================================================

export type ChatModel = "gpt-4o" | "gpt-4o-mini";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  // string for plain text; array of content parts for vision (matches OpenAI shape)
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
  >;
}

export interface ChatOptions {
  model: ChatModel;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" } | { type: "text" };
  // If set, marks this call as PHI-touching. The adapter will refuse to route
  // to non-BAA vendors (sonar, openai_direct unless explicitly allowed) when true.
  phi?: boolean;
}

export interface ChatResult {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  vendor: string;
  model: string;
}

export interface TranscribeOptions {
  audio: Blob;
  filename?: string;
  language?: string; // ISO-639-1
  prompt?: string;
  response_format?: "json" | "text" | "verbose_json";
  phi?: boolean;
}

export interface TranscribeResult {
  text: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  vendor: string;
  model: string;
}

export interface VisionOptions {
  model: ChatModel;
  imageDataUrl: string; // "data:image/jpeg;base64,..." OR an https URL
  prompt: string;
  systemPrompt?: string;
  max_tokens?: number;
  phi?: boolean;
}

// =============================================================================
// Vendor selection + guardrails
// =============================================================================

type Vendor = "azure" | "openai_direct" | "sonar" | "bedrock";

function vendor(): Vendor {
  const v = (Deno.env.get("WELLET_AI_VENDOR") ?? "azure").toLowerCase();
  if (v === "azure" || v === "openai_direct" || v === "sonar" || v === "bedrock") return v;
  throw new Error(`[azureOpenAI] Unknown WELLET_AI_VENDOR: ${v}`);
}

// Hard guardrail: if the caller marked the request phi:true, only BAA-eligible
// vendors are allowed (Azure OpenAI, Bedrock). Sonar is always blocked.
// openai_direct is blocked unless WELLET_ALLOW_OPENAI_DIRECT_PHI=true is set
// (emergency override only). Wellet does not currently hold a signed BAA with
// any of these vendors — see file header for compliance posture.
function assertVendorAllowedForPhi(v: Vendor, phi: boolean) {
  if (!phi) return;
  if (v === "sonar") {
    throw new Error("[azureOpenAI] PHI call routed to Sonar — blocked. Sonar is not a BAA-eligible vendor.");
  }
  if (v === "openai_direct" && Deno.env.get("WELLET_ALLOW_OPENAI_DIRECT_PHI") !== "true") {
    throw new Error(
      "[azureOpenAI] PHI call routed to OpenAI direct — blocked. Set WELLET_ALLOW_OPENAI_DIRECT_PHI=true to override (emergency only)."
    );
  }
  if (v === "bedrock") {
    // Bedrock is BAA-eligible but the implementation isn't done.
    throw new Error("[azureOpenAI] Bedrock vendor not yet implemented (Phase 2).");
  }
}

// =============================================================================
// Public API
// =============================================================================

export async function aiChat(opts: ChatOptions): Promise<ChatResult> {
  const v = vendor();
  assertVendorAllowedForPhi(v, opts.phi ?? false);
  switch (v) {
    case "azure":         return azureChat(opts);
    case "openai_direct": return openaiDirectChat(opts);
    case "sonar":         return sonarChat(opts);
    case "bedrock":       throw new Error("Bedrock not implemented");
  }
}

export async function aiTranscribe(opts: TranscribeOptions): Promise<TranscribeResult> {
  const v = vendor();
  assertVendorAllowedForPhi(v, opts.phi ?? false);
  switch (v) {
    case "azure":         return azureTranscribe(opts);
    case "openai_direct": return openaiDirectTranscribe(opts);
    case "sonar":         throw new Error("Sonar does not support audio transcription");
    case "bedrock":       throw new Error("Bedrock not implemented");
  }
}

export async function aiVision(opts: VisionOptions): Promise<ChatResult> {
  // Vision is just chat with an image content part. Reuse aiChat.
  const messages: ChatMessage[] = [];
  if (opts.systemPrompt) messages.push({ role: "system", content: opts.systemPrompt });
  messages.push({
    role: "user",
    content: [
      { type: "text", text: opts.prompt },
      { type: "image_url", image_url: { url: opts.imageDataUrl, detail: "auto" } },
    ],
  });
  return aiChat({
    model: opts.model,
    messages,
    max_tokens: opts.max_tokens ?? 1500,
    phi: opts.phi,
  });
}

// =============================================================================
// Azure OpenAI implementation (primary, BAA)
// =============================================================================

// Wellet's Azure setup uses two AOAI resources because Foundry auto-provisioned
// Whisper into East US 2 (East US had no Whisper quota). Chat (gpt-4o) lives on
// the primary East US resource; Whisper lives on the secondary East US 2 resource.
// Each has its own endpoint + key.
function azureEnv(kind: "chat" | "whisper") {
  const apiVer = Deno.env.get("AZURE_OPENAI_API_VERSION") ?? "2024-10-21";
  if (kind === "chat") {
    const endpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
    const apiKey   = Deno.env.get("AZURE_OPENAI_API_KEY");
    if (!endpoint) throw new Error("[azureOpenAI] AZURE_OPENAI_ENDPOINT not set");
    if (!apiKey)   throw new Error("[azureOpenAI] AZURE_OPENAI_API_KEY not set");
    return { endpoint: endpoint.replace(/\/+$/, ""), apiKey, apiVer };
  }
  // whisper
  // Falls back to the chat endpoint/key if the dedicated whisper vars aren't set.
  const endpoint = Deno.env.get("AZURE_OPENAI_WHISPER_ENDPOINT") ?? Deno.env.get("AZURE_OPENAI_ENDPOINT");
  const apiKey   = Deno.env.get("AZURE_OPENAI_WHISPER_API_KEY") ?? Deno.env.get("AZURE_OPENAI_API_KEY");
  if (!endpoint) throw new Error("[azureOpenAI] AZURE_OPENAI_WHISPER_ENDPOINT (or AZURE_OPENAI_ENDPOINT) not set");
  if (!apiKey)   throw new Error("[azureOpenAI] AZURE_OPENAI_WHISPER_API_KEY (or AZURE_OPENAI_API_KEY) not set");
  // Whisper deployment uses 2024-06-01 api-version per Azure docs.
  const whisperApiVer = Deno.env.get("AZURE_OPENAI_WHISPER_API_VERSION") ?? "2024-06-01";
  return { endpoint: endpoint.replace(/\/+$/, ""), apiKey, apiVer: whisperApiVer };
}

function azureDeployment(model: ChatModel | "whisper"): string {
  const map: Record<string, string | undefined> = {
    "gpt-4o":      Deno.env.get("AZURE_OPENAI_DEPLOYMENT_GPT4O"),
    "gpt-4o-mini": Deno.env.get("AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI"),
    "whisper":     Deno.env.get("AZURE_OPENAI_DEPLOYMENT_WHISPER"),
  };
  const dep = map[model];
  if (!dep) throw new Error(`[azureOpenAI] No deployment configured for model: ${model}`);
  return dep;
}

async function azureChat(opts: ChatOptions): Promise<ChatResult> {
  const { endpoint, apiKey, apiVer } = azureEnv("chat");
  const deployment = azureDeployment(opts.model);
  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVer}`;

  const body: Record<string, unknown> = {
    messages: opts.messages,
    temperature: opts.temperature,
    max_tokens: opts.max_tokens,
  };
  if (opts.response_format) body.response_format = opts.response_format;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`[azureOpenAI] Azure chat ${res.status}: ${errText}`);
  }
  const json = await res.json();
  return {
    content: json.choices?.[0]?.message?.content ?? "",
    usage: {
      prompt_tokens: json.usage?.prompt_tokens ?? 0,
      completion_tokens: json.usage?.completion_tokens ?? 0,
      total_tokens: json.usage?.total_tokens ?? 0,
    },
    vendor: "azure",
    model: opts.model,
  };
}

async function azureTranscribe(opts: TranscribeOptions): Promise<TranscribeResult> {
  const { endpoint, apiKey, apiVer } = azureEnv("whisper");
  const deployment = azureDeployment("whisper");
  const url = `${endpoint}/openai/deployments/${deployment}/audio/transcriptions?api-version=${apiVer}`;

  const form = new FormData();
  form.append("file", opts.audio, opts.filename ?? "audio.webm");
  if (opts.language) form.append("language", opts.language);
  if (opts.prompt) form.append("prompt", opts.prompt);
  form.append("response_format", opts.response_format ?? "verbose_json");

  const res = await fetch(url, {
    method: "POST",
    headers: { "api-key": apiKey },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`[azureOpenAI] Azure whisper ${res.status}: ${errText}`);
  }
  const fmt = opts.response_format ?? "verbose_json";
  if (fmt === "text") {
    const text = await res.text();
    return { text, vendor: "azure", model: "whisper" };
  }
  const json = await res.json();
  return {
    text: json.text ?? "",
    segments: json.segments,
    vendor: "azure",
    model: "whisper",
  };
}

// =============================================================================
// OpenAI direct (legacy escape hatch)
// =============================================================================

async function openaiDirectChat(opts: ChatOptions): Promise<ChatResult> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("[azureOpenAI] OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
      response_format: opts.response_format,
    }),
  });
  if (!res.ok) throw new Error(`[azureOpenAI] OpenAI direct chat ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return {
    content: json.choices?.[0]?.message?.content ?? "",
    usage: {
      prompt_tokens: json.usage?.prompt_tokens ?? 0,
      completion_tokens: json.usage?.completion_tokens ?? 0,
      total_tokens: json.usage?.total_tokens ?? 0,
    },
    vendor: "openai_direct",
    model: opts.model,
  };
}

async function openaiDirectTranscribe(opts: TranscribeOptions): Promise<TranscribeResult> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("[azureOpenAI] OPENAI_API_KEY not set");
  const form = new FormData();
  form.append("file", opts.audio, opts.filename ?? "audio.webm");
  form.append("model", "whisper-1");
  if (opts.language) form.append("language", opts.language);
  if (opts.prompt) form.append("prompt", opts.prompt);
  form.append("response_format", opts.response_format ?? "verbose_json");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`[azureOpenAI] OpenAI direct whisper ${res.status}: ${await res.text()}`);
  const fmt = opts.response_format ?? "verbose_json";
  if (fmt === "text") {
    return { text: await res.text(), vendor: "openai_direct", model: "whisper-1" };
  }
  const json = await res.json();
  return { text: json.text ?? "", segments: json.segments, vendor: "openai_direct", model: "whisper-1" };
}

// =============================================================================
// Perplexity Sonar (NON-PHI ONLY — guardrail above blocks phi:true)
// =============================================================================

async function sonarChat(opts: ChatOptions): Promise<ChatResult> {
  const apiKey = Deno.env.get("PERPLEXITY_API_KEY");
  if (!apiKey) throw new Error("[azureOpenAI] PERPLEXITY_API_KEY not set");
  // Sonar uses its own model names; map gpt-* to sonar-pro for non-PHI surfaces.
  const sonarModel = "sonar-pro";
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: sonarModel,
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
    }),
  });
  if (!res.ok) throw new Error(`[azureOpenAI] Sonar chat ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return {
    content: json.choices?.[0]?.message?.content ?? "",
    usage: {
      prompt_tokens: json.usage?.prompt_tokens ?? 0,
      completion_tokens: json.usage?.completion_tokens ?? 0,
      total_tokens: json.usage?.total_tokens ?? 0,
    },
    vendor: "sonar",
    model: sonarModel,
  };
}

// =============================================================================
// Convenience: structured JSON output helper
// =============================================================================

export async function aiChatJSON<T = unknown>(opts: Omit<ChatOptions, "response_format">): Promise<{
  data: T;
  raw: string;
  usage: ChatResult["usage"];
  vendor: string;
  model: string;
}> {
  const res = await aiChat({ ...opts, response_format: { type: "json_object" } });
  let data: T;
  try {
    data = JSON.parse(res.content) as T;
  } catch (e) {
    throw new Error(`[azureOpenAI] aiChatJSON: failed to parse JSON output: ${(e as Error).message}\nRaw: ${res.content}`);
  }
  return { data, raw: res.content, usage: res.usage, vendor: res.vendor, model: res.model };
}
