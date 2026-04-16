-- Add reward tier tracking to waitlist
ALTER TABLE public.waitlist
  ADD COLUMN IF NOT EXISTS reward_tier text DEFAULT NULL
  CHECK (reward_tier IS NULL OR reward_tier IN ('founding', 'early', 'beta'));

-- Create a view for live tier counts (used by the website)
CREATE OR REPLACE VIEW public.tier_counts AS
SELECT
  COALESCE(SUM(CASE WHEN reward_tier = 'founding' THEN 1 ELSE 0 END), 0) AS founding_claimed,
  50 AS founding_total,
  COALESCE(SUM(CASE WHEN reward_tier = 'early' THEN 1 ELSE 0 END), 0) AS early_claimed,
  100 AS early_total,
  COALESCE(SUM(CASE WHEN reward_tier = 'beta' THEN 1 ELSE 0 END), 0) AS beta_claimed,
  250 AS beta_total,
  COUNT(*) AS total_signups
FROM public.waitlist
WHERE status != 'removed';

-- Allow anonymous read on tier_counts for the website counter
GRANT SELECT ON public.tier_counts TO anon;
GRANT SELECT ON public.tier_counts TO authenticated;
