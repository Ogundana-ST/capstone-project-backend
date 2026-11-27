# RecycleConnect Backend

Express API backend for RecycleConnect. The service uses PostgreSQL through `pg`, JWT bearer tokens, and Google ID-token verification. Supabase hosts PostgreSQL through the `DATABASE_URL` connection string; the backend does not use Supabase Auth.

## AI assistance disclosure

The email/password signup and login additions in `src/routes/auth.js`, the profile update route in `src/routes/users.js`, and `migrations/20261125_password_auth.sql` were prepared with AI assistance. Google sign-in remains available. Review the changes against the project requirements before deployment.

## Run locally

1. Install dependencies with `npm install`.
2. Create or update a local `.env` with `PORT`, `JWT_SECRET`, `DATABASE_URL`, `DB_SSL`, and `GOOGLE_CLIENT_ID`. Set `DATABASE_URL` to the Session pooler URI from the Supabase Connect panel and `DB_SSL=true`. Keep `.env` out of Git. `ALLOW_DEV_LOGIN=true` enables the development-only `dev:` Google token shortcut.
3. Ensure the database schema and required tables exist. This repository archive does not include the base database schema/setup script.
4. Apply `migrations/20261125_password_auth.sql` after the existing `users` table has been created.
5. Start with `npm start`.

The local Session pooler connection was verified with a read-only query. Supabase Storage is used for private profile avatars only; this does not enable Supabase Auth. Set `SUPABASE_URL` and the Supabase Secret key (`SUPABASE_SECRET_KEY`, beginning `sb_secret_`) in the backend environment (Render and local `.env`). The older `SUPABASE_SERVICE_ROLE_KEY` JWT remains supported for compatibility. Never add either key to frontend config or Git. `SUPABASE_PROFILE_BUCKET` is optional and defaults to `profile-avatars`. Apply `migrations/20261126_profile_avatar.sql` after the existing `users` table is present; it adds the `avatar_path` column and creates/configures the private bucket for JPEG, PNG, and WebP files up to 2 MB.

## Authentication routes

- `POST /v1/auth/google` keeps Google sign-in.
- `POST /v1/auth/signup` creates a household, estate, or collector account with email and password.
- `POST /v1/auth/login` signs in with email or phone and password.

Protected routes use `Authorization: Bearer <JWT>`. Passwords are stored as scrypt hashes. API responses omit the password hash and Google ID.

Authenticated accounts can read their own profile with `GET /v1/users/profile` and upload a private avatar with `PUT /v1/users/profile/avatar`. Avatar URLs are signed and expire after one hour. The upload accepts raw JPEG, PNG, or WebP bytes up to 2 MB; only the owning user can change their image.

The collector OTP endpoint still uses the fixed demo code `123456`; it is not production phone verification.

The separate `RecycleConnect-API-Contract` repository documents the endpoint agreement. Contract files are intentionally not stored in this backend repository.
