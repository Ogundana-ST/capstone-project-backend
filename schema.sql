-- RecycleConnect database schema (PRD v3.0 section 7.1)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role            VARCHAR(20) NOT NULL CHECK (role IN ('HOUSEHOLD','ESTATE','COLLECTOR','ADMIN')),
  full_name       VARCHAR(120),
  email           VARCHAR(160) UNIQUE NOT NULL,
  phone           VARCHAR(20),
  phone_verified  BOOLEAN NOT NULL DEFAULT false,
  address         TEXT,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  google_id       VARCHAR(120) UNIQUE,
  wallet_balance  INTEGER NOT NULL DEFAULT 0,               -- 1 Point = 1 Naira (whole numbers only)
  is_paused       BOOLEAN NOT NULL DEFAULT false,
  pickup_interval VARCHAR(10) NOT NULL DEFAULT 'NONE' CHECK (pickup_interval IN ('WEEKLY','BIWEEKLY','NONE')),
  usual_materials TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS badge_seq START 1;

CREATE TABLE IF NOT EXISTS collector_profiles (
  user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  badge_id               VARCHAR(20) UNIQUE,                 -- e.g. RC-001
  kyc_status             VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK (kyc_status IN ('PENDING','APPROVED','REJECTED')),
  nin_number             VARCHAR(20),
  id_doc_type            VARCHAR(30),
  id_doc_url             TEXT,
  live_selfie_url        TEXT,
  guarantor_name         VARCHAR(120),
  guarantor_phone        VARCHAR(20),
  guarantor_relationship VARCHAR(60),
  verified_at            TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS material_rates (
  material      VARCHAR(10) PRIMARY KEY CHECK (material IN ('PET','CANS','CARTONS','GLASS')),
  rate_per_kg   INTEGER NOT NULL CHECK (rate_per_kg >= 0),
  updated_by    UUID REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pickups (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  collector_id        UUID REFERENCES users(id),
  pickup_type         VARCHAR(10) NOT NULL CHECK (pickup_type IN ('RECURRING','ONE_OFF')),
  scheduled_date      TIMESTAMPTZ NOT NULL,
  status              VARCHAR(10) NOT NULL DEFAULT 'SCHEDULED'
                      CHECK (status IN ('SCHEDULED','SKIPPED','EN_ROUTE','ARRIVED','COMPLETED','DISPUTED')),
  materials           TEXT[] NOT NULL DEFAULT '{}',
  load_photo_url      TEXT,
  householder_present BOOLEAN,
  scale_photo_url     TEXT,
  weights_json        JSONB,
  total_kg            DECIMAL(10,2),
  total_payout        INTEGER,
  confirmation_status VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK (confirmation_status IN ('PENDING','THUMBS_UP','THUMBS_DOWN')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS disputes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pickup_id        UUID NOT NULL REFERENCES pickups(id),
  raised_by        UUID NOT NULL REFERENCES users(id),
  reason           TEXT,
  admin_resolution VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                   CHECK (admin_resolution IN ('PENDING','APPROVED','ADJUSTED','COLLECTOR_SUSPENDED')),
  adjusted_payout  INTEGER,
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Extra (good practice): every wallet change is recorded, so balances can be audited
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  pickup_id   UUID REFERENCES pickups(id),
  amount      INTEGER NOT NULL,                              -- can be negative for adjustments
  type        VARCHAR(20) NOT NULL,                          -- PICKUP_CREDIT, DISPUTE_ADJUSTMENT
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Extra: simple in-app notifications (e.g. "Your collector today is Musa - RC-001 - Verified")
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pickups_user ON pickups(user_id);
CREATE INDEX IF NOT EXISTS idx_pickups_status_date ON pickups(status, scheduled_date);

-- Seed data (sample rates in Naira per kg; Admin can change them)
INSERT INTO material_rates (material, rate_per_kg) VALUES
  ('PET',150), ('CANS',300), ('CARTONS',50), ('GLASS',30)
ON CONFLICT (material) DO NOTHING;

INSERT INTO users (role, full_name, email) VALUES
  ('ADMIN','RecycleConnect Admin','admin@recycleconnect.ng')
ON CONFLICT (email) DO NOTHING;
