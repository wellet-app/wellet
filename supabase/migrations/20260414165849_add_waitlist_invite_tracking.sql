ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS status text DEFAULT 'signed_up';
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS invited_at timestamptz;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS activated_at timestamptz;

-- Create a feedback table for alpha testers
CREATE TABLE IF NOT EXISTS feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id),
  email text,
  message text NOT NULL,
  page text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can insert feedback
CREATE POLICY "Users can insert own feedback" ON feedback
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Users can read their own feedback
CREATE POLICY "Users can read own feedback" ON feedback
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Allow anon to insert feedback (for pre-auth feedback)
CREATE POLICY "Anon can insert feedback" ON feedback
  FOR INSERT TO anon
  WITH CHECK (true);
