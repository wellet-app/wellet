-- ── PEOPLE ──────────────────────────────────────────────────
CREATE TABLE people (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  date_of_birth DATE,
  relationship  TEXT,
  situation     TEXT,
  avatar_initials TEXT,
  sort_order    INTEGER     DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own people" ON people FOR ALL USING (auth.uid() = user_id);

-- ── HEALTH EVENTS ────────────────────────────────────────────
CREATE TABLE health_events (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  person_id     UUID        REFERENCES people(id) ON DELETE CASCADE,
  event_type    TEXT        NOT NULL,
  event_date    TIMESTAMPTZ NOT NULL,
  title         TEXT        NOT NULL,
  value         NUMERIC,
  value2        NUMERIC,
  unit          TEXT,
  notes         TEXT,
  source        TEXT        DEFAULT 'manual',
  ehr_system    TEXT,
  accepted      BOOLEAN     DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE health_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own events" ON health_events FOR ALL USING (
  person_id IN (SELECT id FROM people WHERE user_id = auth.uid())
);
CREATE INDEX idx_health_events_person_date ON health_events(person_id, event_date DESC);

-- ── MEDICATIONS ──────────────────────────────────────────────
CREATE TABLE medications (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  person_id     UUID        REFERENCES people(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  dose          TEXT,
  frequency     TEXT,
  prescriber    TEXT,
  start_date    DATE,
  end_date      DATE,
  active        BOOLEAN     DEFAULT TRUE,
  source        TEXT        DEFAULT 'manual',
  ehr_system    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE medications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own medications" ON medications FOR ALL USING (
  person_id IN (SELECT id FROM people WHERE user_id = auth.uid())
);

-- ── UPDATE ME SUMMARIES ──────────────────────────────────────
CREATE TABLE update_me_summaries (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  person_id     UUID        REFERENCES people(id) ON DELETE CASCADE,
  summary_text  TEXT        NOT NULL,
  data_hash     TEXT        NOT NULL,
  generated_at  TIMESTAMPTZ DEFAULT NOW(),
  model         TEXT        DEFAULT 'perplexity-computer',
  event_count   INTEGER     DEFAULT 0
);
ALTER TABLE update_me_summaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own summaries" ON update_me_summaries FOR ALL USING (
  person_id IN (SELECT id FROM people WHERE user_id = auth.uid())
);
CREATE UNIQUE INDEX idx_summary_person ON update_me_summaries(person_id);

-- ── DOCUMENTS ────────────────────────────────────────────────
CREATE TABLE documents (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  person_id           UUID        REFERENCES people(id) ON DELETE CASCADE,
  file_name           TEXT        NOT NULL,
  storage_path        TEXT        NOT NULL,
  document_type       TEXT,
  extracted_events    JSONB,
  extraction_status   TEXT        DEFAULT 'pending',
  uploaded_at         TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own documents" ON documents FOR ALL USING (
  person_id IN (SELECT id FROM people WHERE user_id = auth.uid())
);

-- ── WAITLIST ─────────────────────────────────────────────────
CREATE TABLE waitlist (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  email         TEXT        UNIQUE NOT NULL,
  caring_for    TEXT,
  signed_up_at  TIMESTAMPTZ DEFAULT NOW(),
  source        TEXT        DEFAULT 'getwellet_com'
);
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can join waitlist" ON waitlist FOR INSERT WITH CHECK (true);
CREATE POLICY "No one reads waitlist via client" ON waitlist FOR SELECT USING (false);

-- ── UPDATED_AT TRIGGER ───────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER people_updated_at BEFORE UPDATE ON people FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── STORAGE BUCKET ───────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public) VALUES ('documents', 'documents', false);
