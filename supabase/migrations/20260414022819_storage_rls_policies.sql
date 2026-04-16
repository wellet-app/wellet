-- Allow authenticated users to upload files to their own folder
CREATE POLICY "Users can upload documents" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Allow authenticated users to read their own files
CREATE POLICY "Users can read own documents" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Allow authenticated users to delete their own files
CREATE POLICY "Users can delete own documents" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Also add RLS policy on documents table so users can insert/read their own docs
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'documents' AND policyname = 'Users can insert own documents') THEN
    CREATE POLICY "Users can insert own documents" ON public.documents
      FOR INSERT TO authenticated
      WITH CHECK (
        person_id IN (SELECT id FROM public.people WHERE user_id = auth.uid())
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'documents' AND policyname = 'Users can read own documents') THEN
    CREATE POLICY "Users can read own documents" ON public.documents
      FOR SELECT TO authenticated
      USING (
        person_id IN (SELECT id FROM public.people WHERE user_id = auth.uid())
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'documents' AND policyname = 'Users can update own documents') THEN
    CREATE POLICY "Users can update own documents" ON public.documents
      FOR UPDATE TO authenticated
      USING (
        person_id IN (SELECT id FROM public.people WHERE user_id = auth.uid())
      );
  END IF;
END $$;
