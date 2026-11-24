const router = require('express').Router();
const db = require('../db');
const { MATERIALS, HttpError, ah } = require('../utils');
const { authenticate, requireRole, requireApprovedCollector } = require('../middleware/auth');
const { scheduleNext } = require('../services/scheduling');

router.use(authenticate, requireRole('COLLECTOR'));

// POST /collectors/kyc  (FR-01)
router.post('/collectors/kyc', ah(async (req, res) => {
  const b = req.body;
  const required = ['nin_number', 'id_doc_type', 'id_doc_url', 'live_selfie_url', 'guarantor_name', 'guarantor_phone', 'guarantor_relationship'];
  const missing = required.filter((k) => !b[k]);
  if (missing.length) throw new HttpError(400, `Missing fields: ${missing.join(', ')}`);

  const { rows: u } = await db.query('SELECT phone_verified FROM users WHERE id=$1', [req.user.id]);
  if (!u[0].phone_verified) throw new HttpError(400, 'Verify your phone with OTP first (POST /auth/otp/verify)');

  await db.query(
    `INSERT INTO collector_profiles (user_id, kyc_status, nin_number, id_doc_type, id_doc_url, live_selfie_url,
        guarantor_name, guarantor_phone, guarantor_relationship)
     VALUES ($1,'PENDING',$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id) DO UPDATE SET kyc_status='PENDING', nin_number=$2, id_doc_type=$3, id_doc_url=$4,
        live_selfie_url=$5, guarantor_name=$6, guarantor_phone=$7, guarantor_relationship=$8`,
    [req.user.id, b.nin_number, b.id_doc_type, b.id_doc_url, b.live_selfie_url, b.guarantor_name, b.guarantor_phone, b.guarantor_relationship]
  );
  res.status(201).json({ kyc_status: 'PENDING' });
}));

// GET /collector/map-pins?date=YYYY-MM-DD  (FR-04)
router.get('/collector/map-pins', requireApprovedCollector, ah(async (req, res) => {
  const date = req.query.date || null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must look like 2026-11-28');
  const { rows } = await db.query(
    `SELECT p.id AS pickup_id, u.lat, u.lng, u.address, p.scheduled_date, p.status, p.materials
     FROM pickups p JOIN users u ON u.id = p.user_id
     WHERE p.status IN ('SCHEDULED','EN_ROUTE','ARRIVED')
       AND (p.collector_id IS NULL OR p.collector_id=$1)
       AND ($2::date IS NULL OR (p.scheduled_date AT TIME ZONE 'UTC')::date = $2::date)
     ORDER BY p.scheduled_date`,
    [req.user.id, date]
  );
  res.json({ pins: rows });
}));

// PATCH /collector/pickups/:id/status  (FR-04) EN_ROUTE then ARRIVED
router.patch('/collector/pickups/:id/status', requireApprovedCollector, ah(async (req, res) => {
  const { status } = req.body;
  if (!['EN_ROUTE', 'ARRIVED'].includes(status)) throw new HttpError(400, 'status must be EN_ROUTE or ARRIVED');

  const { rows } = await db.query('SELECT * FROM pickups WHERE id=$1', [req.params.id]);
  const pickup = rows[0];
  if (!pickup) throw new HttpError(404, 'Pickup not found');

  if (status === 'EN_ROUTE') {
    if (pickup.status !== 'SCHEDULED') throw new HttpError(409, 'Only SCHEDULED pickups can start a route');
    await db.query(`UPDATE pickups SET status='EN_ROUTE', collector_id=$1 WHERE id=$2`, [req.user.id, pickup.id]);
    const { rows: c } = await db.query('SELECT full_name FROM users WHERE id=$1', [req.user.id]);
    await db.query('INSERT INTO notifications (user_id, message) VALUES ($1,$2)',
      [pickup.user_id, `Your collector today is ${c[0].full_name || 'a collector'} - ${req.collector.badge_id} - Verified`]);
  } else {
    if (pickup.status !== 'EN_ROUTE' || pickup.collector_id !== req.user.id)
      throw new HttpError(409, 'Pickup must be EN_ROUTE and assigned to you');
    await db.query(`UPDATE pickups SET status='ARRIVED' WHERE id=$1`, [pickup.id]);
    await db.query('INSERT INTO notifications (user_id, message) VALUES ($1,$2)',
      [pickup.user_id, 'Your collector has arrived.']);
  }
  res.json({ status, notification_sent: true });
}));

// POST /collector/pickups/:id/weigh  (FR-05 + FR-06) - weigh and instantly credit wallet
router.post('/collector/pickups/:id/weigh', requireApprovedCollector, ah(async (req, res) => {
  const { householder_present, scale_photo_url, weights } = req.body;
  if (typeof householder_present !== 'boolean') throw new HttpError(400, 'householder_present must be true or false');
  if (!householder_present && !scale_photo_url)
    throw new HttpError(400, 'scale_photo_url is required when the householder is absent');
  if (!weights || typeof weights !== 'object' || !Object.keys(weights).length)
    throw new HttpError(400, 'weights is required, e.g. {"PET":5.2,"CANS":1.5}');
  for (const [m, kg] of Object.entries(weights)) {
    if (!MATERIALS.includes(m)) throw new HttpError(400, `Unknown material: ${m}`);
    if (typeof kg !== 'number' || !(kg > 0)) throw new HttpError(400, `Weight for ${m} must be a number greater than 0`);
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM pickups WHERE id=$1 FOR UPDATE', [req.params.id]);
    const pickup = rows[0];
    if (!pickup) throw new HttpError(404, 'Pickup not found');
    if (pickup.status !== 'ARRIVED' || pickup.collector_id !== req.user.id)
      throw new HttpError(409, 'Pickup must be ARRIVED and assigned to you before weighing');

    const { rows: rateRows } = await client.query('SELECT material, rate_per_kg FROM material_rates');
    const rateOf = Object.fromEntries(rateRows.map((r) => [r.material, r.rate_per_kg]));

    let totalKg = 0, totalPayout = 0;
    for (const [m, kg] of Object.entries(weights)) {
      totalKg += kg;
      totalPayout += Math.round(kg * rateOf[m]); // whole Naira only
    }
    totalKg = Math.round(totalKg * 100) / 100;

    await client.query(
      `UPDATE pickups SET status='COMPLETED', householder_present=$1, scale_photo_url=$2, weights_json=$3,
         total_kg=$4, total_payout=$5 WHERE id=$6`,
      [householder_present, scale_photo_url || null, JSON.stringify(weights), totalKg, totalPayout, pickup.id]
    );
    await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id=$2', [totalPayout, pickup.user_id]);
    await client.query(`INSERT INTO wallet_transactions (user_id, pickup_id, amount, type) VALUES ($1,$2,$3,'PICKUP_CREDIT')`,
      [pickup.user_id, pickup.id, totalPayout]);
    await client.query('INSERT INTO notifications (user_id, message) VALUES ($1,$2)',
      [pickup.user_id, `${totalKg}kg collected. ₦${totalPayout} credited to your wallet. Please confirm.`]);

    if (pickup.pickup_type === 'RECURRING') await scheduleNext(client, pickup.user_id, pickup.scheduled_date);
    await client.query('COMMIT');
    res.json({ total_kg: totalKg, total_payout: totalPayout, wallet_credited: true });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

module.exports = router;
