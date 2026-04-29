-- Migration: epic_clients
-- Purpose: Per-hospital Epic client_id routing for Wellet's two-app strategy.
--
-- Background (2026-04-28):
--   Wellet runs two Epic apps simultaneously:
--     1. Wellet Confidential (USCDI v3, auto-distribute)
--          - Production:    e550b8b1-8a3f-4f56-99e9-4870a616d5ab
--          - Non-Production: 6307e012-4778-40ed-bd24-c042b932312e
--        Used for the long tail of Epic hospitals on auto-distribute.
--        Auto-distribute means we get a global app+scope set; no Connection Hub
--        request per hospital. The trade-off: Appointment is NOT in the picker.
--
--     2. Wellet Premium (manual-distribute, full superset incl. Appointment)
--          - Production:    54c20c77-e246-494c-b717-32e7da364f0a
--          - Non-Production: 925934b0-d34e-43f5-a6d0-e378ca9094ed
--        Used for hospitals where Wellet has gone through Connection Hub to
--        unlock Appointment + the chronic-care superset (DeviceUseStatement,
--        EpisodeOfCare, MedicationDispense, etc.).
--        First hospital: Duke Health (request pending as of this migration).
--
--   Both apps share the same JWKS at mywellet.com/.well-known/jwks-{prod,nonprod}.json,
--   so kid + signing key are identical across apps. ONLY the client_id differs.
--
-- Routing rules:
--   epic-auth's `start` action picks an app by ILIKE-matching the
--   hospital's fhir_base_url against rows in this table, ordered by priority
--   (lower number = checked first). The row with pattern '%' is the default
--   fallback (Wellet Confidential).
--
--   `refresh` and `callback` continue to read `client_id_used` from the
--   ehr_connections row, so existing connections keep working unchanged.
--   Only NEW connections start using Premium where this table says so.
--
-- Read-only consumers: epic-auth edge function.

CREATE TABLE IF NOT EXISTS public.epic_clients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fhir_base_pattern   text NOT NULL,                -- ILIKE pattern, e.g. '%health-apis.duke.edu%' or '%' for default
  app_name            text NOT NULL,                -- 'wellet_premium' | 'wellet_confidential'
  prod_client_id      text NOT NULL,
  nonprod_client_id   text NOT NULL,
  priority            integer NOT NULL DEFAULT 100, -- lower priority is checked first
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT epic_clients_priority_nonneg CHECK (priority >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS epic_clients_pattern_key
  ON public.epic_clients (fhir_base_pattern);

CREATE INDEX IF NOT EXISTS epic_clients_priority_idx
  ON public.epic_clients (priority);

-- RLS: read-only access via service role only. No user-facing reads or writes.
ALTER TABLE public.epic_clients ENABLE ROW LEVEL SECURITY;
-- (Intentionally no policies = no access for anon/authenticated; only service role bypasses RLS.)

-- ── Seed rows ──────────────────────────────────────────────────────────────

-- Duke Health → Wellet Premium
-- fhir_base_url today: https://health-apis.duke.edu/FHIR/api/FHIR/R4/
INSERT INTO public.epic_clients (
  fhir_base_pattern, app_name, prod_client_id, nonprod_client_id, priority, notes
) VALUES (
  '%health-apis.duke.edu%',
  'wellet_premium',
  '54c20c77-e246-494c-b717-32e7da364f0a',
  '925934b0-d34e-43f5-a6d0-e378ca9094ed',
  10,
  'Duke Health. Manual-distribute. Full Premium superset incl. Appointment. Connection Hub request pending as of 2026-04-28.'
)
ON CONFLICT (fhir_base_pattern) DO NOTHING;

-- Default fallback → Wellet Confidential
INSERT INTO public.epic_clients (
  fhir_base_pattern, app_name, prod_client_id, nonprod_client_id, priority, notes
) VALUES (
  '%',
  'wellet_confidential',
  'e550b8b1-8a3f-4f56-99e9-4870a616d5ab',
  '6307e012-4778-40ed-bd24-c042b932312e',
  100,
  'Default. USCDI v3, auto-distribute. Used for any hospital not explicitly mapped above. Does NOT include Appointment.'
)
ON CONFLICT (fhir_base_pattern) DO NOTHING;
