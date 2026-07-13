-- Billing-error detection PR 1 — claims + EOB ingestion (manual-entry only).
--
-- This migration creates the four ingestion tables that PR 2 (the manual-entry
-- form) writes into and that the billing-rules engine (PR 3) reads from.
-- OCR is explicitly deferred to v1.1: every row in v1 has source = 'manual'.
--
-- Mirrors the reimbursement_assessments pattern:
--   - person_id + user_id FK, RLS on auth.uid() = user_id
--   - per-field provenance via JSONB
--   - freshness via updated_at trigger
--
-- Caregiver-facing language note: in UI copy we will say "bill" (claims_documents)
-- and "Explanation of Benefits" (eob_documents). Internal column names use the
-- standard insurance terms so the engine maps cleanly to CMS-source language.
--
-- See: wellet_billing_error_detection_build_plan_v2.md (v2.1 sequence: PR 1).
--      wellet_accuracy_audit_followup_2026-06-12.md (governing accuracy rule).

-- ─────────────────────────────────────────────────────────────────────
-- 1. claims_documents
--   One row per uploaded/entered provider bill.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.claims_documents (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id             UUID        NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  user_id               UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Provider / facility identification. All optional at insert; engine rules
  -- that depend on a missing field will not fire (see accuracy rule #6).
  provider_name         TEXT,
  provider_npi          TEXT,                         -- 10-digit NPI if known
  facility_name         TEXT,
  service_date_start    DATE,                         -- earliest date of service on the bill
  service_date_end      DATE,                         -- latest date of service on the bill
  statement_date        DATE,
  total_billed_amount   NUMERIC(12,2),                -- cents-precision dollars
  amount_due            NUMERIC(12,2),
  payer_name            TEXT,                         -- Medicare / commercial insurer / Medicaid / self-pay
  payer_type            TEXT CHECK (
                          payer_type IS NULL OR
                          payer_type IN (
                            'medicare', 'medicare_advantage', 'medicaid',
                            'commercial', 'self_pay', 'tricare', 'va', 'other'
                          )
                        ),
  account_number        TEXT,

  -- Source provenance. v1: 'manual' only. v1.1 may add 'ocr'.
  source                TEXT NOT NULL CHECK (source IN ('manual', 'ocr', 'imported')),

  -- Per-field provenance map, e.g. { "provider_npi": "manual", "service_date_start": "manual" }.
  -- Mirrors reimbursement_assessments.input_provenance.
  field_provenance      JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Free-text notes the caregiver added on entry (no engine logic depends on this).
  notes                 TEXT,

  -- Storage hook for the original document if ever uploaded. Nullable in v1
  -- since manual entry has no attachment. v1.1 will populate this when OCR ships.
  original_storage_path TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS claims_documents_user_idx
  ON public.claims_documents(user_id);
CREATE INDEX IF NOT EXISTS claims_documents_person_idx
  ON public.claims_documents(person_id);
CREATE INDEX IF NOT EXISTS claims_documents_service_date_idx
  ON public.claims_documents(service_date_start);

ALTER TABLE public.claims_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own claims_documents" ON public.claims_documents
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.claims_documents IS
  'One row per provider bill the caregiver has entered for a loved one. v1 manual-entry only; OCR deferred to v1.1.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. claims_line_items
--   One row per line on a bill. Engine rules fire at the line level.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.claims_line_items (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_document_id     UUID        NOT NULL REFERENCES public.claims_documents(id) ON DELETE CASCADE,
  user_id               UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Service identification.
  service_date          DATE,                         -- specific line date (may differ from doc-level range)
  cpt_code              TEXT,                         -- HCPCS Level I (CPT) code, 5 chars
  hcpcs_code            TEXT,                         -- HCPCS Level II code (when not CPT)
  modifier_1            TEXT,                         -- e.g. '76', '77', '25', 'LT', 'RT'
  modifier_2            TEXT,
  modifier_3            TEXT,
  modifier_4            TEXT,
  description           TEXT,                         -- caregiver's transcription of the line description
  units                 INTEGER     NOT NULL DEFAULT 1,
  billed_amount         NUMERIC(12,2),                -- what the provider charged for this line

  -- Provider identification at the line level. Most bills only carry this at
  -- the document level, but Rule 1 (duplicate_same_day_same_code) cares about
  -- (npi, service_date, cpt_code) so we cache it here.
  provider_npi          TEXT,

  -- Source provenance.
  source                TEXT NOT NULL CHECK (source IN ('manual', 'ocr', 'imported')),
  field_provenance      JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Caregiver-verified flag. In v1 (manual), this defaults to true on insert.
  -- In v1.1 (OCR), it defaults to false until the caregiver reviews and confirms.
  verified_by_user      BOOLEAN     NOT NULL DEFAULT TRUE,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS claims_line_items_doc_idx
  ON public.claims_line_items(claim_document_id);
CREATE INDEX IF NOT EXISTS claims_line_items_user_idx
  ON public.claims_line_items(user_id);

-- Engine rule lookup index: Rule 1 queries (provider_npi, service_date, cpt_code).
CREATE INDEX IF NOT EXISTS claims_line_items_npi_date_cpt_idx
  ON public.claims_line_items(provider_npi, service_date, cpt_code);

ALTER TABLE public.claims_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own claims_line_items" ON public.claims_line_items
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.claims_line_items IS
  'One row per line on a provider bill. Engine rules fire at the line level. user_id is denormalized from the parent claims_document for RLS performance.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. eob_documents
--   One row per Explanation of Benefits.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.eob_documents (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id                   UUID        NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  user_id                     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  payer_name                  TEXT,
  payer_type                  TEXT CHECK (
                                payer_type IS NULL OR
                                payer_type IN (
                                  'medicare', 'medicare_advantage', 'medicaid',
                                  'commercial', 'self_pay', 'tricare', 'va', 'other'
                                )
                              ),
  provider_name               TEXT,
  provider_npi                TEXT,
  service_date_start          DATE,
  service_date_end            DATE,
  eob_date                    DATE,                   -- date the EOB was issued
  claim_number                TEXT,                   -- payer-side claim ID

  -- Document-level totals. These are CMS standard EOB fields per
  -- https://www.cms.gov/medical-bill-rights/help/guides/explanation-of-benefits
  total_provider_charges      NUMERIC(12,2),          -- "Provider Charges"
  total_allowed_amount        NUMERIC(12,2),          -- "Allowed Charges"
  total_paid_by_insurer       NUMERIC(12,2),          -- "Paid by Insurer"
  patient_responsibility      NUMERIC(12,2),          -- "What You Owe" / "Patient Balance"

  -- Provider participation status with this payer. Critical for Rule 3
  -- (medicare_balance_billing_participating_provider). Nullable: if unknown,
  -- the rule will not fire (accuracy rule #6).
  provider_participation_status  TEXT CHECK (
                                provider_participation_status IS NULL OR
                                provider_participation_status IN (
                                  'participating', 'non_participating', 'opt_out', 'unknown'
                                )
                              ),

  source                      TEXT NOT NULL CHECK (source IN ('manual', 'ocr', 'imported')),
  field_provenance            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  notes                       TEXT,
  original_storage_path       TEXT,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS eob_documents_user_idx
  ON public.eob_documents(user_id);
CREATE INDEX IF NOT EXISTS eob_documents_person_idx
  ON public.eob_documents(person_id);
CREATE INDEX IF NOT EXISTS eob_documents_service_date_idx
  ON public.eob_documents(service_date_start);

ALTER TABLE public.eob_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own eob_documents" ON public.eob_documents
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.eob_documents IS
  'One row per Explanation of Benefits the caregiver has entered. Column language follows CMS Medical Bill Rights EOB guide.';

-- ─────────────────────────────────────────────────────────────────────
-- 4. eob_line_items
--   One row per service line on an EOB.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.eob_line_items (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  eob_document_id             UUID        NOT NULL REFERENCES public.eob_documents(id) ON DELETE CASCADE,
  user_id                     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  service_date                DATE,
  cpt_code                    TEXT,
  hcpcs_code                  TEXT,
  modifier_1                  TEXT,
  modifier_2                  TEXT,
  modifier_3                  TEXT,
  modifier_4                  TEXT,
  description                 TEXT,
  units                       INTEGER     NOT NULL DEFAULT 1,

  -- The CMS EOB four-number breakdown.
  provider_charge             NUMERIC(12,2),          -- billed by provider
  allowed_amount              NUMERIC(12,2),          -- payer's allowed amount
  paid_by_insurer             NUMERIC(12,2),          -- insurer's payment
  patient_responsibility      NUMERIC(12,2),          -- the line-level "what you owe"

  source                      TEXT NOT NULL CHECK (source IN ('manual', 'ocr', 'imported')),
  field_provenance            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  verified_by_user            BOOLEAN     NOT NULL DEFAULT TRUE,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS eob_line_items_doc_idx
  ON public.eob_line_items(eob_document_id);
CREATE INDEX IF NOT EXISTS eob_line_items_user_idx
  ON public.eob_line_items(user_id);

ALTER TABLE public.eob_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own eob_line_items" ON public.eob_line_items
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.eob_line_items IS
  'One row per service line on an EOB. Engine matches these to claims_line_items by (cpt_code, service_date, provider_npi) for Rule 2 comparisons.';

-- ─────────────────────────────────────────────────────────────────────
-- 5. updated_at trigger (one function, reused for all 4 tables)
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_billing_ingestion_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claims_documents_set_updated_at
  BEFORE UPDATE ON public.claims_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_billing_ingestion_updated_at();

CREATE TRIGGER claims_line_items_set_updated_at
  BEFORE UPDATE ON public.claims_line_items
  FOR EACH ROW EXECUTE FUNCTION public.set_billing_ingestion_updated_at();

CREATE TRIGGER eob_documents_set_updated_at
  BEFORE UPDATE ON public.eob_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_billing_ingestion_updated_at();

CREATE TRIGGER eob_line_items_set_updated_at
  BEFORE UPDATE ON public.eob_line_items
  FOR EACH ROW EXECUTE FUNCTION public.set_billing_ingestion_updated_at();
