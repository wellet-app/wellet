CREATE OR REPLACE FUNCTION get_waitlist_count()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT COUNT(*)::integer FROM waitlist;
$$;
GRANT EXECUTE ON FUNCTION get_waitlist_count() TO anon;
