const router = require('express').Router();
const db = require('../db');
const { MATERIALS, HttpError, ah } = require('../utils');
const { authenticate, requireRole } = require('../middleware/auth');
const { createFirstRecurring, scheduleNext } = require('../services/scheduling');

router.use(authenticate, requireRole('HOUSEHOLD', 'ESTATE'));

// PATCH /users/onboarding  (FR-01)
router.patch('/onboarding', ah(async (req, res) => {
  const { full_name, address, phone, pickup_interval, usual_materials, lat, lng } = req.body;
  if (!full_name || !address) throw new HttpError(400, 'full_name and address are required');
  const interval = pickup_interval || 'WEEKLY';
  if (!['WEEKLY', 'BIWEEKLY'].includes(interval)) throw new HttpError(400, 'pickup_interval must be WEEKLY or BIWEEKLY');
  const mats = usual_materials || [];
  if (!Array.isArray(mats) || mats.some((m) => !MATERIALS.includes(m)))
    throw new HttpError(400, `usual_materials must be a list from: ${MATERIALS.join(', ')}`);

  // Estates are always weekly (Saturday 9am)
  const finalInterval = req.user.role === 'ESTATE' ? 'WEEKLY' : interval;

  const { rows } = await db.query(
    `UPDATE users SET full_name=$1, address=$2, phone=$3, pickup_interval=$4, usual_materials=$5, lat=$6, lng=$7
     WHERE id=$8 RETURNING *`,
    [full_name, address, phone || null, finalInterval, mats, lat ?? null, lng ?? null, req.user.id]
  );
  const user = rows[0];

  // Replace any old scheduled recurring pickup with a fresh one
  await db.query(`DELETE FROM pickups WHERE user_id=$1 AND pickup_type='RECURRING' AND status='SCHEDULED'`, [user.id]);
  const next = await createFirstRecurring(db, user);
  res.json({ user, next_pickup: next.toISOString() });
}));

// PATCH /users/pause-toggle  (FR-03)
router.patch('/pause-toggle', ah(async (req, res) => {
  const { is_paused } = req.body;
  if (typeof is_paused !== 'boolean') throw new HttpError(400, 'is_paused must be true or false');
  const { rows } = await db.query('UPDATE users SET is_paused=$1 WHERE id=$2 RETURNING *', [is_paused, req.user.id]);
  const user = rows[0];

  if (is_paused) {
    await db.query(`UPDATE pickups SET status='SKIPPED' WHERE user_id=$1 AND pickup_type='RECURRING' AND status='SCHEDULED'`, [user.id]);
  } else if (user.pickup_interval !== 'NONE') {
    const { rows: open } = await db.query(`SELECT 1 FROM pickups WHERE user_id=$1 AND pickup_type='RECURRING' AND status='SCHEDULED'`, [user.id]);
    if (!open.length) await createFirstRecurring(db, user);
  }
  res.json({ is_paused });
}));

module.exports = router;
