-- End-of-Care Journey: schema additions for bereavement flow, archive, Community Fund
-- Issue: #23

-- ── People: care status columns ─────────────────────────────────────────────
ALTER TABLE people ADD COLUMN IF NOT EXISTS care_status text NOT NULL DEFAULT 'active';
ALTER TABLE people ADD COLUMN IF NOT EXISTS care_status_changed_at timestamptz;
ALTER TABLE people ADD COLUMN IF NOT EXISTS care_status_note text;

-- ── Community Fund Pool ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_fund_pool (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_id uuid NOT NULL REFERENCES auth.users(id),
  care_recipient_name text NOT NULL,
  days_donated integer NOT NULL DEFAULT 0,
  donor_note text,
  is_anonymous boolean NOT NULL DEFAULT false,
  donated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE community_fund_pool ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert their own donations"
  ON community_fund_pool FOR INSERT
  WITH CHECK (auth.uid() = donor_id);

CREATE POLICY "Users can view their own donations"
  ON community_fund_pool FOR SELECT
  USING (auth.uid() = donor_id);

-- ── Community Fund Grants ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_fund_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES auth.users(id),
  days_granted integer NOT NULL DEFAULT 0,
  source_donation_id uuid REFERENCES community_fund_pool(id),
  granted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE community_fund_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own grants"
  ON community_fund_grants FOR SELECT
  USING (auth.uid() = recipient_id);

-- ── Community Fund Stats RPC ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_community_fund_stats()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT json_build_object(
    'total_days_donated', COALESCE(SUM(days_donated), 0),
    'total_donors', COUNT(DISTINCT donor_id),
    'total_days_granted', (SELECT COALESCE(SUM(days_granted), 0) FROM community_fund_grants),
    'days_available', COALESCE(SUM(days_donated), 0) - (SELECT COALESCE(SUM(days_granted), 0) FROM community_fund_grants)
  )
  FROM community_fund_pool;
$$;
