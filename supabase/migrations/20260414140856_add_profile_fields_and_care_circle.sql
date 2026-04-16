-- Add profile fields to people table
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS allergies text,
  ADD COLUMN IF NOT EXISTS blood_type text,
  ADD COLUMN IF NOT EXISTS insurance_info text,
  ADD COLUMN IF NOT EXISTS emergency_contact_name text,
  ADD COLUMN IF NOT EXISTS emergency_contact_phone text,
  ADD COLUMN IF NOT EXISTS primary_doctor text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS conditions text;

-- Create care circle members table
CREATE TABLE IF NOT EXISTS public.care_circle_members (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  person_id uuid REFERENCES public.people(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id),
  member_name text NOT NULL,
  email text,
  phone text,
  role text NOT NULL DEFAULT 'secondary' CHECK (role IN ('primary', 'secondary', 'emergency')),
  invite_status text DEFAULT 'pending' CHECK (invite_status IN ('pending', 'accepted', 'declined')),
  created_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.care_circle_members ENABLE ROW LEVEL SECURITY;

-- RLS policies: users can manage care circle for their own people
CREATE POLICY "Users can read own care circle" ON public.care_circle_members
  FOR SELECT USING (person_id IN (SELECT id FROM people WHERE user_id = auth.uid()));

CREATE POLICY "Users can insert own care circle" ON public.care_circle_members
  FOR INSERT WITH CHECK (person_id IN (SELECT id FROM people WHERE user_id = auth.uid()));

CREATE POLICY "Users can update own care circle" ON public.care_circle_members
  FOR UPDATE USING (person_id IN (SELECT id FROM people WHERE user_id = auth.uid()));

CREATE POLICY "Users can delete own care circle" ON public.care_circle_members
  FOR DELETE USING (person_id IN (SELECT id FROM people WHERE user_id = auth.uid()));
