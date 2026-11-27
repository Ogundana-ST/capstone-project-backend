-- Apply after the existing RecycleConnect users table has been created.
-- Supabase Storage keeps image bytes; this column stores only the private object path.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_path text;

-- Backend-only access uses the service-role key; clients never access this bucket directly.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'profile-avatars',
  'profile-avatars',
  false,
  2097152,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
