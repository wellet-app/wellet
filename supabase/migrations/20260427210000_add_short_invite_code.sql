-- Add short alphanumeric invite codes to care_circle_members.
-- Short codes are an alias for the existing invite_token (UUID), used by the
-- Wellet Connect Flutter app where typing a 6-char code is friendlier than
-- pasting a deep link. Both the long invite_token and the short_code resolve
-- to the same member row via the care-circle-invite edge function.

ALTER TABLE care_circle_members
  ADD COLUMN IF NOT EXISTS invite_short_code text UNIQUE;

CREATE INDEX IF NOT EXISTS idx_care_circle_invite_short_code
  ON care_circle_members(invite_short_code)
  WHERE invite_short_code IS NOT NULL;

-- Generate a 6-char A-Z/2-9 code, excluding ambiguous chars (0,O,1,I,L).
-- Retries on collision up to 5 times. Uses gen_random_bytes for entropy.
CREATE OR REPLACE FUNCTION generate_short_invite_code() RETURNS text AS $$
DECLARE
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  alphabet_len int := length(alphabet);
  code text;
  attempt int := 0;
  exists_already boolean;
BEGIN
  LOOP
    code := '';
    FOR i IN 1..6 LOOP
      code := code || substr(
        alphabet,
        (get_byte(gen_random_bytes(1), 0) % alphabet_len) + 1,
        1
      );
    END LOOP;

    SELECT EXISTS (
      SELECT 1 FROM care_circle_members WHERE invite_short_code = code
    ) INTO exists_already;

    IF NOT exists_already THEN
      RETURN code;
    END IF;

    attempt := attempt + 1;
    IF attempt > 5 THEN
      RAISE EXCEPTION 'Could not generate unique short invite code after 5 attempts';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql VOLATILE;
