-- Run after the existing RecycleConnect users table has been created.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash text;

-- Keep email/password registration case-insensitive and race-safe.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique
  ON users (lower(email))
  WHERE email IS NOT NULL;
