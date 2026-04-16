ALTER TABLE waitlist ADD COLUMN interest text NOT NULL DEFAULT 'both' CHECK (interest IN ('launch', 'follow', 'both'));
