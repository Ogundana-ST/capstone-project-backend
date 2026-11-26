# RecycleConnect Backend

Express API backend for RecycleConnect. The service uses PostgreSQL through `pg`, JWT bearer tokens, and Google ID-token verification. Supabase is the planned PostgreSQL host; project credentials have not been provided yet.

## AI assistance disclosure

The email/password signup and login additions in `src/routes/auth.js`, the profile update route in `src/routes/users.js`, and `migrations/20261125_password_auth.sql` were prepared with AI assistance. They are proposed changes for maintainer review. Google sign-in remains available. Review the changes against the project requirements and run the team's checks before merging.

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and fill in the values the project owner authorizes. The backend's `pg` pool reads `DATABASE_URL`; add the Supabase Postgres connection string there when available. Set `DB_SSL=true` when the database requires SSL. `JWT_SECRET` and `GOOGLE_CLIENT_ID` are needed for the current backend-issued JWT and Google sign-in. `ALLOW_DEV_LOGIN=true` enables the development-only `dev:` Google token shortcut.
3. Ensure the database schema and required tables exist. This repository archive does not include the base database schema/setup script.
4. Apply `migrations/20261125_password_auth.sql` after the existing `users` table has been created.
5. Start with `npm start`.

The backend uses Supabase as a PostgreSQL host through `DATABASE_URL`; this does not require Supabase Auth. `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are reserved placeholders in `.env.example` only. No current backend code reads them or validates Supabase Auth sessions. Keep the existing Google/email-password sign-in until the team chooses and implements Supabase Auth.

## Authentication routes

- `POST /v1/auth/google` keeps Google sign-in.
- `POST /v1/auth/signup` creates a household, estate, or collector account with email and password.
- `POST /v1/auth/login` signs in with email or phone and password.

Protected routes use `Authorization: Bearer <JWT>`. Passwords are stored as scrypt hashes. API responses omit the password hash and Google ID.

The collector OTP endpoint still uses the fixed demo code `123456`; it is not production phone verification.

The separate `RecycleConnect-API-Contract` repository documents the endpoint agreement. Contract files are intentionally not stored in this backend repository.
