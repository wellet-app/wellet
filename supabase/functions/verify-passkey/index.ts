// verify-passkey v1 — WebAuthn / Face ID for mywellet.com
// ---------------------------------------------------------
// Single edge function, action-routed. Six actions:
//
//   register-challenge  (user JWT) → { challenge, user_handle, rp, user, pubKeyCredParams }
//   register-verify     (user JWT) → { success, passkey_id }
//   auth-challenge      (anon)     → { challenge, timeout }
//   auth-verify         (anon)     → { access_token, refresh_token, expires_at }
//   list                (user JWT) → { passkeys: [...] }
//   remove              (user JWT) → { success }
//
// Relying Party: mywellet.com
// Origin allow-list: https://mywellet.com, https://www.mywellet.com
//
// Passkey storage: public.user_passkeys
// Challenge storage: public.passkey_challenges (5-min TTL, single-use)
//
// Session minting for auth-verify uses Supabase's admin generateLink +
// verifyOtp exchange so the returned access_token / refresh_token are
// signed by Supabase's own auth keys (RLS continues to work, refresh
// tokens rotate normally — no custom JWTs).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "https://esm.sh/@simplewebauthn/server@10.0.1";
import { getCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Relying Party config — passkeys are bound to this RP ID.
// Using "mywellet.com" covers the apex + any future subdomains on the same
// eTLD+1. NOT cross-origin to getwellet.com — sign-in only happens here.
const RP_ID = "mywellet.com";
const RP_NAME = "Wellet";
const EXPECTED_ORIGINS = [
  "https://mywellet.com",
  "https://www.mywellet.com",
  // Local dev convenience — harmless because passkeys created against these
  // origins won't validate on the production RP_ID anyway.
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

// =========================================================================
// Helpers
// =========================================================================

function json(body: unknown, status = 200, cors: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

// Encode a Uint8Array → base64url (no padding)
function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Decode base64url → Uint8Array
function b64uDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// User handle = a stable, opaque per-user identifier we hand to the
// authenticator. We use the auth.users.id bytes (UUID → 16 bytes).
function userIdToHandle(userId: string): Uint8Array {
  // UUID like "08c09e85-708e-48b2-9745-a4edb5aaf335"
  const hex = userId.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function handleToUserId(handle: Uint8Array): string | null {
  if (handle.length !== 16) return null;
  const hex = Array.from(handle).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return (
    hex.substr(0, 8) + "-" +
    hex.substr(8, 4) + "-" +
    hex.substr(12, 4) + "-" +
    hex.substr(16, 4) + "-" +
    hex.substr(20, 12)
  );
}

async function purgeExpiredChallenges(service: any) {
  try {
    await service.rpc("purge_expired_passkey_challenges");
  } catch (_) {
    // Non-fatal — challenges with expires_at < now() will simply be rejected
    // when consumed, which is the same outcome.
  }
}

// Resolve the authenticated user from the Authorization header. Returns
// null if missing/invalid.
async function getAuthUser(req: Request): Promise<{ id: string; email: string } | null> {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader) return null;
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await anon.auth.getUser();
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email || "" };
}

// =========================================================================
// Action handlers
// =========================================================================

async function handleRegisterChallenge(req: Request, service: any, cors: Record<string, string>) {
  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401, cors);

  // Fetch existing credential IDs so we can pass them to excludeCredentials
  // (prevents the user from registering the same authenticator twice).
  const { data: existing } = await service
    .from("user_passkeys")
    .select("credential_id, transports")
    .eq("user_id", user.id);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: userIdToHandle(user.id),
    userName: user.email || user.id,
    userDisplayName: user.email || "Wellet user",
    attestationType: "none",
    excludeCredentials: (existing || []).map((p: any) => ({
      id: b64uDecode(p.credential_id),
      type: "public-key" as const,
      transports: p.transports || [],
    })),
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      userVerification: "required",
      residentKey: "preferred",
      requireResidentKey: false,
    },
    supportedAlgorithmIDs: [-7, -257], // ES256, RS256
  });

  // Persist the challenge so register-verify can validate it.
  await service.from("passkey_challenges").insert({
    challenge: options.challenge,
    user_id: user.id,
    purpose: "register",
  });

  return json({
    challenge: options.challenge,
    user_handle: b64uEncode(userIdToHandle(user.id)),
    rp: options.rp,
    user: { id: options.user.id, name: options.user.name, displayName: options.user.displayName },
    pubKeyCredParams: options.pubKeyCredParams,
    timeout: options.timeout ?? 60000,
  }, 200, cors);
}

async function handleRegisterVerify(req: Request, service: any, cors: Record<string, string>) {
  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401, cors);

  const body = await req.json().catch(() => ({}));
  const attestation = body.attestation;
  if (!attestation || !attestation.response) {
    return json({ error: "Missing attestation" }, 400, cors);
  }

  // Pull the original challenge from clientDataJSON to look it up.
  let challengeFromClient: string;
  try {
    const clientDataBytes = b64uDecode(attestation.response.clientDataJSON);
    const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
    challengeFromClient = clientData.challenge;
  } catch (e) {
    return json({ error: "Malformed clientDataJSON" }, 400, cors);
  }

  // Verify the challenge belongs to this user and hasn't expired.
  const { data: chRow } = await service
    .from("passkey_challenges")
    .select("challenge, user_id, purpose, expires_at")
    .eq("challenge", challengeFromClient)
    .maybeSingle();

  if (!chRow) return json({ error: "Unknown challenge" }, 400, cors);
  if (chRow.purpose !== "register") return json({ error: "Wrong challenge purpose" }, 400, cors);
  if (chRow.user_id !== user.id) return json({ error: "Challenge user mismatch" }, 400, cors);
  if (new Date(chRow.expires_at).getTime() < Date.now()) {
    await service.from("passkey_challenges").delete().eq("challenge", challengeFromClient);
    return json({ error: "Challenge expired" }, 400, cors);
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: attestation,
      expectedChallenge: challengeFromClient,
      expectedOrigin: EXPECTED_ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });
  } catch (e) {
    console.error("verify-passkey: registration verify failed", e);
    await service.from("passkey_challenges").delete().eq("challenge", challengeFromClient);
    return json({ error: "Verification failed: " + (e?.message || "unknown") }, 400, cors);
  }

  if (!verification.verified || !verification.registrationInfo) {
    await service.from("passkey_challenges").delete().eq("challenge", challengeFromClient);
    return json({ error: "Verification failed" }, 400, cors);
  }

  const info = verification.registrationInfo;
  const credentialIdB64 = b64uEncode(info.credentialID);
  const publicKeyB64 = b64uEncode(info.credentialPublicKey);

  // Insert the new passkey. credential_id is unique, so a re-registration of
  // the same authenticator would conflict — we already prevent this via
  // excludeCredentials, but defend in depth.
  const { data: inserted, error: insErr } = await service
    .from("user_passkeys")
    .insert({
      user_id: user.id,
      credential_id: credentialIdB64,
      public_key: publicKeyB64,
      sign_count: info.counter ?? 0,
      transports: attestation.response.transports || [],
      aaguid: info.aaguid || null,
      device_label: body.device_label || null,
      user_agent: req.headers.get("User-Agent") || null,
    })
    .select("id")
    .single();

  // Single-use challenge — delete regardless of outcome below.
  await service.from("passkey_challenges").delete().eq("challenge", challengeFromClient);

  if (insErr) {
    console.error("verify-passkey: insert failed", insErr);
    return json({ error: "Could not save passkey" }, 500, cors);
  }

  return json({ success: true, passkey_id: inserted.id }, 200, cors);
}

async function handleAuthChallenge(_req: Request, service: any, cors: Record<string, string>) {
  // No user context — we issue a discoverable-credential challenge and let
  // the browser pick whichever passkey iCloud Keychain has for this RP.
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "required",
    // No allowCredentials → discoverable credentials → user-pick UI
    timeout: 60000,
  });

  await service.from("passkey_challenges").insert({
    challenge: options.challenge,
    user_id: null,
    purpose: "auth",
  });

  return json({
    challenge: options.challenge,
    timeout: options.timeout ?? 60000,
    rpId: RP_ID,
  }, 200, cors);
}

async function handleAuthVerify(req: Request, service: any, cors: Record<string, string>) {
  const body = await req.json().catch(() => ({}));
  const assertion = body.assertion;
  if (!assertion || !assertion.response) {
    return json({ error: "Missing assertion" }, 400, cors);
  }

  // Look up the challenge.
  let challengeFromClient: string;
  try {
    const clientDataBytes = b64uDecode(assertion.response.clientDataJSON);
    const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
    challengeFromClient = clientData.challenge;
  } catch (e) {
    return json({ error: "Malformed clientDataJSON" }, 400, cors);
  }

  const { data: chRow } = await service
    .from("passkey_challenges")
    .select("challenge, purpose, expires_at")
    .eq("challenge", challengeFromClient)
    .maybeSingle();

  if (!chRow) return json({ error: "Unknown challenge" }, 400, cors);
  if (chRow.purpose !== "auth") return json({ error: "Wrong challenge purpose" }, 400, cors);
  if (new Date(chRow.expires_at).getTime() < Date.now()) {
    await service.from("passkey_challenges").delete().eq("challenge", challengeFromClient);
    return json({ error: "Challenge expired" }, 400, cors);
  }

  // The assertion tells us which credential was used. Look it up.
  const credentialIdB64 = assertion.id; // already base64url
  const { data: passkey } = await service
    .from("user_passkeys")
    .select("id, user_id, credential_id, public_key, sign_count, transports")
    .eq("credential_id", credentialIdB64)
    .maybeSingle();

  if (!passkey) {
    await service.from("passkey_challenges").delete().eq("challenge", challengeFromClient);
    return json({ error: "Unknown credential" }, 400, cors);
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: challengeFromClient,
      expectedOrigin: EXPECTED_ORIGINS,
      expectedRPID: RP_ID,
      authenticator: {
        credentialID: b64uDecode(passkey.credential_id),
        credentialPublicKey: b64uDecode(passkey.public_key),
        counter: Number(passkey.sign_count) || 0,
        transports: passkey.transports || [],
      },
      requireUserVerification: true,
    });
  } catch (e) {
    console.error("verify-passkey: auth verify failed", e);
    await service.from("passkey_challenges").delete().eq("challenge", challengeFromClient);
    return json({ error: "Verification failed: " + (e?.message || "unknown") }, 400, cors);
  }

  if (!verification.verified || !verification.authenticationInfo) {
    await service.from("passkey_challenges").delete().eq("challenge", challengeFromClient);
    return json({ error: "Verification failed" }, 400, cors);
  }

  const newCounter = verification.authenticationInfo.newCounter;

  // Update sign_count + last_used_at. If the authenticator returned a
  // counter of 0 (some platform authenticators don't track), accept it.
  await service
    .from("user_passkeys")
    .update({
      sign_count: newCounter,
      last_used_at: new Date().toISOString(),
    })
    .eq("id", passkey.id);

  // Burn the challenge.
  await service.from("passkey_challenges").delete().eq("challenge", challengeFromClient);

  // Mint a Supabase session for the user.
  // Strategy: generate a magic link, then immediately consume it with
  // verifyOtp() server-side. The resulting tokens are signed by Supabase
  // — RLS keeps working, refresh tokens rotate normally.
  const { data: userRow, error: userErr } = await service.auth.admin.getUserById(passkey.user_id);
  if (userErr || !userRow?.user?.email) {
    return json({ error: "User lookup failed" }, 500, cors);
  }
  const email = userRow.user.email;

  const { data: linkData, error: linkErr } = await service.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr || !linkData?.properties?.hashed_token) {
    console.error("verify-passkey: generateLink failed", linkErr);
    return json({ error: "Could not mint session" }, 500, cors);
  }

  // Consume the hashed_token via the anon client.
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: sessionData, error: verifyErr } = await anon.auth.verifyOtp({
    type: "magiclink",
    token_hash: linkData.properties.hashed_token,
  });
  if (verifyErr || !sessionData?.session) {
    console.error("verify-passkey: verifyOtp failed", verifyErr);
    return json({ error: "Could not mint session" }, 500, cors);
  }

  return json({
    access_token: sessionData.session.access_token,
    refresh_token: sessionData.session.refresh_token,
    expires_at: sessionData.session.expires_at,
    user_id: passkey.user_id,
  }, 200, cors);
}

async function handleList(req: Request, service: any, cors: Record<string, string>) {
  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401, cors);

  const { data, error } = await service
    .from("user_passkeys")
    .select("id, device_label, transports, created_at, last_used_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) return json({ error: error.message }, 500, cors);
  return json({ passkeys: data || [] }, 200, cors);
}

async function handleRemove(req: Request, service: any, cors: Record<string, string>) {
  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401, cors);

  const body = await req.json().catch(() => ({}));
  const passkeyId = body.passkey_id;
  if (!passkeyId) return json({ error: "Missing passkey_id" }, 400, cors);

  const { error } = await service
    .from("user_passkeys")
    .delete()
    .eq("id", passkeyId)
    .eq("user_id", user.id); // belt + RLS — only own passkeys

  if (error) return json({ error: error.message }, 500, cors);
  return json({ success: true }, 200, cors);
}

// =========================================================================
// Router
// =========================================================================

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, cors);
  }

  const service = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Lazy janitor.
  await purgeExpiredChallenges(service);

  // We need to read the body twice for actions that look at sub-fields.
  // Clone before parsing.
  const reqClone = req.clone();
  const body = await req.json().catch(() => ({}));
  const action = body.action;

  try {
    switch (action) {
      case "register-challenge":
        return await handleRegisterChallenge(reqClone, service, cors);
      case "register-verify":
        return await handleRegisterVerify(reqClone, service, cors);
      case "auth-challenge":
        return await handleAuthChallenge(reqClone, service, cors);
      case "auth-verify":
        return await handleAuthVerify(reqClone, service, cors);
      case "list":
        return await handleList(reqClone, service, cors);
      case "remove":
        return await handleRemove(reqClone, service, cors);
      default:
        return json({ error: "Unknown action: " + String(action) }, 400, cors);
    }
  } catch (e: any) {
    console.error("verify-passkey: uncaught", e);
    return json({ error: "Internal error: " + (e?.message || "unknown") }, 500, cors);
  }
});
