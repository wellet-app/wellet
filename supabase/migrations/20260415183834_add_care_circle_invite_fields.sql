-- Add invite tracking columns to care_circle_members
ALTER TABLE care_circle_members
  ADD COLUMN IF NOT EXISTS invite_token text UNIQUE,
  ADD COLUMN IF NOT EXISTS invited_at timestamptz,
  ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES auth.users(id);

-- Create index on invite_token for fast lookups
CREATE INDEX IF NOT EXISTS idx_care_circle_invite_token ON care_circle_members(invite_token) WHERE invite_token IS NOT NULL;

-- Create a function to generate invite tokens
CREATE OR REPLACE FUNCTION generate_invite_token() RETURNS text AS $$
BEGIN
  RETURN encode(gen_random_bytes(24), 'base64');
END;
$$ LANGUAGE plpgsql;
