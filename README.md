# RecycleConnect Backend (MVP)

Node.js + Express + PostgreSQL REST API for the RecycleConnect PRD v3.0 (FR-01 to FR-07, 17 endpoints).

## Run locally
1. Install Node.js (LTS) and PostgreSQL. Create a database named `recycleconnect`.
2. `npm install`
3. Copy `.env.example` to `.env` and fill in `DATABASE_URL` and `JWT_SECRET`.
4. `npm run db:setup`  (creates tables + sample rates + admin user)
5. `npm run dev`  -> http://localhost:3000

## Test
Import `RecycleConnect.postman_collection.json` into Postman and run folders 0 to 6 in order.
Dev login: send `"id_token": "dev:anyone@email.com"` to `POST /v1/auth/google` (works when `ALLOW_DEV_LOGIN=true`).
Admin account: `dev:admin@recycleconnect.ng`. Mock collector OTP: `123456`.

## Endpoints (base: /v1)
| Method | Path | Role |
|---|---|---|
| POST | /auth/google | Public |
| POST | /auth/otp/verify | Collector |
| PATCH | /users/onboarding | Household/Estate |
| POST | /collectors/kyc | Collector |
| GET | /rates | All |
| PATCH | /admin/rates | Admin |
| GET | /pickups/dashboard | Household/Estate |
| POST | /pickups/one-off | Household/Estate |
| PATCH | /pickups/:id/skip | Household/Estate |
| PATCH | /users/pause-toggle | Household/Estate |
| GET | /collector/map-pins?date= | Collector |
| PATCH | /collector/pickups/:id/status | Collector |
| POST | /collector/pickups/:id/weigh | Collector |
| POST | /pickups/:id/confirm | Household/Estate |
| GET | /admin/collectors/pending | Admin |
| PATCH | /admin/collectors/:id/verify | Admin |
| GET | /admin/overview | Admin |
| GET | /admin/disputes | Admin (extra) |
| PATCH | /admin/disputes/:id/resolve | Admin (extra, completes FR-07) |

## Business rules implemented
- JWT role guards (HOUSEHOLD, ESTATE, COLLECTOR, ADMIN)
- Payout = sum(kg x rate), whole Naira, credited inside one database transaction (1 Point = N1)
- Scale photo mandatory when `householder_present` is false
- Admin approval generates badge IDs RC-001, RC-002, ...
- Thumbs down creates a dispute for the Admin queue
