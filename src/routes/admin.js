const router = require('express').Router();
const db = require('../db');
const { MATERIALS, CURRENCY, formatNaira, HttpError, ah } = require('../utils');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('ADMIN'));

// PATCH /admin/rates  (FR-07b)
router.patch('/rates', ah(async (req, res) => {
  const { rates } = req.body;
  if (!Array.isArray(rates) || !rates.length) throw new HttpError(400, 'rates must be a non-empty list');
  for (const r of rates) {
    if (!MATERIALS.includes(r.material)) throw new HttpError(400, `Unknown material: ${r.material}`);
    if (!Number.isInteger(r.rate_per_kg) || r.rate_per_kg < 0) throw new HttpError(400, 'rate_per_kg must be a whole number >= 0');
  }
  for (const r of rates) {
    await db.query(
      `INSERT INTO material_rates (material, rate_per_kg, updated_by) VALUES ($1,$2,$3)
       ON CONFLICT (material) DO UPDATE SET rate_per_kg=$2, updated_by=$3, updated_at=now()`,
      [r.material, r.rate_per_kg, req.user.id]
    );
  }
  const { rows } = await db.query('SELECT material, rate_per_kg FROM material_rates ORDER BY material');
  res.json({ updated: true, rates: rows });
}));

// GET /admin/collectors/pending  (FR-07a)
router.get('/collectors/pending', ah(async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.address, c.nin_number, c.id_doc_type, c.id_doc_url,
            c.live_selfie_url, c.guarantor_name, c.guarantor_phone, c.guarantor_relationship
     FROM collector_profiles c JOIN users u ON u.id = c.user_id
     WHERE c.kyc_status='PENDING' ORDER BY u.created_at`
  );
  res.json({ pending_collectors: rows });
}));

// PATCH /admin/collectors/:id/verify  (FR-07a) - :id is the collector's user id
router.patch('/collectors/:id/verify', ah(async (req, res) => {
  const { action } = req.body;
  if (!['APPROVE', 'REJECT'].includes(action)) throw new HttpError(400, 'action must be APPROVE or REJECT');

  if (action === 'REJECT') {
    const { rowCount } = await db.query(`UPDATE collector_profiles SET kyc_status='REJECTED' WHERE user_id=$1`, [req.params.id]);
    if (!rowCount) throw new HttpError(404, 'Collector KYC not found');
    return res.json({ kyc_status: 'REJECTED' });
  }
  const { rows } = await db.query(
    `UPDATE collector_profiles
     SET kyc_status='APPROVED', verified_at=now(),
         badge_id = COALESCE(badge_id, 'RC-' || lpad(nextval('badge_seq')::text, 3, '0'))
     WHERE user_id=$1 RETURNING kyc_status, badge_id`,
    [req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Collector KYC not found');
  res.json(rows[0]);
}));

// GET /admin/overview  (FR-07c) daily totals + disputes
router.get('/overview', ah(async (req, res) => {
  const [totals, disputes] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS today_pickups, COALESCE(SUM(total_kg),0)::float AS today_kg,
              COALESCE(SUM(total_payout),0)::int AS today_payouts
       FROM pickups
       WHERE status IN ('COMPLETED','DISPUTED') AND (scheduled_date AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date`),
    listDisputes(),
  ]);
 const t = totals.rows[0];
res.json({ ...t, currency: CURRENCY, today_payouts_formatted: formatNaira(t.today_payouts), disputes });
}));

function listDisputes() {
  return db.query(
    `SELECT d.id, d.pickup_id, d.reason, d.admin_resolution, d.adjusted_payout, d.created_at,
            p.weights_json, p.total_kg, p.total_payout, p.scale_photo_url, p.householder_present, p.collector_id
     FROM disputes d JOIN pickups p ON p.id = d.pickup_id
     ORDER BY (d.admin_resolution='PENDING') DESC, d.created_at DESC`
  ).then((r) => r.rows);
}

// GET /admin/disputes
router.get('/disputes', ah(async (req, res) => {
  res.json({ disputes: await listDisputes() });
}));

// PATCH /admin/disputes/:id/resolve  (FR-07c)
// body: {"action":"APPROVE"|"ADJUST"|"SUSPEND", "adjusted_payout": 900 (only for ADJUST)}
router.patch('/disputes/:id/resolve', ah(async (req, res) => {
  const { action, adjusted_payout } = req.body;
  if (!['APPROVE', 'ADJUST', 'SUSPEND'].includes(action)) throw new HttpError(400, 'action must be APPROVE, ADJUST or SUSPEND');
  if (action === 'ADJUST' && !(Number.isInteger(adjusted_payout) && adjusted_payout >= 0))
    throw new HttpError(400, 'adjusted_payout must be a whole number >= 0');

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT d.*, p.user_id AS owner_id, p.total_payout, p.collector_id
       FROM disputes d JOIN pickups p ON p.id = d.pickup_id WHERE d.id=$1 FOR UPDATE OF d`, [req.params.id]);
    const d = rows[0];
    if (!d) throw new HttpError(404, 'Dispute not found');
    if (d.admin_resolution !== 'PENDING') throw new HttpError(409, 'Dispute already resolved');

    let resolution = 'APPROVED';
    if (action === 'ADJUST') {
      resolution = 'ADJUSTED';
      const diff = adjusted_payout - d.total_payout; // money to add (or remove) from the user's wallet
      await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id=$2', [diff, d.owner_id]);
      await client.query(`UPDATE pickups SET total_payout=$1 WHERE id=$2`, [adjusted_payout, d.pickup_id]);
      await client.query(`INSERT INTO wallet_transactions (user_id, pickup_id, amount, type) VALUES ($1,$2,$3,'DISPUTE_ADJUSTMENT')`,
        [d.owner_id, d.pickup_id, diff]);
    }
    if (action === 'SUSPEND') {
      resolution = 'COLLECTOR_SUSPENDED';
      if (d.collector_id) await client.query(`UPDATE collector_profiles SET kyc_status='REJECTED' WHERE user_id=$1`, [d.collector_id]);
    }
    await client.query(`UPDATE disputes SET admin_resolution=$1, adjusted_payout=$2, resolved_at=now() WHERE id=$3`,
      [resolution, action === 'ADJUST' ? adjusted_payout : null, d.id]);
    await client.query('COMMIT');
    res.json({ dispute_id: d.id, admin_resolution: resolution });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

module.exports = router;
