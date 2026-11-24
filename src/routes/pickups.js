const router = require('express').Router();
const db = require('../db');
const { MATERIALS, HttpError, ah } = require('../utils');
const { authenticate, requireRole } = require('../middleware/auth');
const { scheduleNext } = require('../services/scheduling');

router.use(authenticate, requireRole('HOUSEHOLD', 'ESTATE'));

// GET /pickups/dashboard  (FR-02) - everything the Home screen needs
router.get('/dashboard', ah(async (req, res) => {
  const uid = req.user.id;
  const [user, rates, next, history, notes] = await Promise.all([
    db.query('SELECT wallet_balance, is_paused FROM users WHERE id=$1', [uid]),
    db.query('SELECT material, rate_per_kg FROM material_rates ORDER BY material'),
    db.query(
      `SELECT p.id, p.pickup_type, p.scheduled_date, p.status, u.full_name AS collector_name, c.badge_id AS collector_badge_id
       FROM pickups p
       LEFT JOIN users u ON u.id = p.collector_id
       LEFT JOIN collector_profiles c ON c.user_id = p.collector_id
       WHERE p.user_id=$1 AND p.status IN ('SCHEDULED','EN_ROUTE','ARRIVED')
       ORDER BY p.scheduled_date ASC LIMIT 1`, [uid]),
    db.query(
      `SELECT id, pickup_type, scheduled_date, status, total_kg, total_payout, confirmation_status
       FROM pickups WHERE user_id=$1 AND status IN ('COMPLETED','DISPUTED','SKIPPED')
       ORDER BY scheduled_date DESC LIMIT 20`, [uid]),
    db.query('SELECT message, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5', [uid]),
  ]);
  res.json({
    next_pickup: next.rows[0] || null,
    rates: rates.rows,
    wallet_balance: user.rows[0].wallet_balance,
    is_paused: user.rows[0].is_paused,
    history: history.rows,
    notifications: notes.rows,
  });
}));

// POST /pickups/one-off  (FR-03)
router.post('/one-off', ah(async (req, res) => {
  const { materials, scheduled_date, load_photo_url } = req.body;
  if (!Array.isArray(materials) || !materials.length || materials.some((m) => !MATERIALS.includes(m)))
    throw new HttpError(400, `materials must be a non-empty list from: ${MATERIALS.join(', ')}`);
  const date = new Date(scheduled_date);
  if (!scheduled_date || isNaN(date) || date <= new Date())
    throw new HttpError(400, 'scheduled_date must be a valid future date');
  if (!load_photo_url) throw new HttpError(400, 'load_photo_url is required');

  const { rows } = await db.query(
    `INSERT INTO pickups (user_id, pickup_type, scheduled_date, materials, load_photo_url)
     VALUES ($1,'ONE_OFF',$2,$3,$4) RETURNING id, status`,
    [req.user.id, date, materials, load_photo_url]
  );
  res.status(201).json({ pickup_id: rows[0].id, status: rows[0].status });
}));

// PATCH /pickups/:id/skip  (FR-03) - skips one slot
router.patch('/:id/skip', ah(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE pickups SET status='SKIPPED' WHERE id=$1 AND user_id=$2 AND status='SCHEDULED' RETURNING *`,
    [req.params.id, req.user.id]
  );
  if (!rows[0]) throw new HttpError(404, 'No scheduled pickup found with that id');
  if (rows[0].pickup_type === 'RECURRING') await scheduleNext(db, req.user.id, rows[0].scheduled_date);
  res.json({ pickup_id: rows[0].id, status: 'SKIPPED' });
}));

// POST /pickups/:id/confirm  (FR-06) - Thumbs up / down
router.post('/:id/confirm', ah(async (req, res) => {
  const { action, reason } = req.body;
  if (!['THUMBS_UP', 'THUMBS_DOWN'].includes(action)) throw new HttpError(400, 'action must be THUMBS_UP or THUMBS_DOWN');

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM pickups WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, req.user.id]);
    const pickup = rows[0];
    if (!pickup) throw new HttpError(404, 'Pickup not found');
    if (pickup.status !== 'COMPLETED' || pickup.confirmation_status !== 'PENDING')
      throw new HttpError(409, 'This pickup cannot be confirmed (not completed, or already confirmed)');

    await client.query('UPDATE pickups SET confirmation_status=$1, status=$2 WHERE id=$3',
      [action, action === 'THUMBS_DOWN' ? 'DISPUTED' : 'COMPLETED', pickup.id]);
    if (action === 'THUMBS_DOWN') {
      await client.query('INSERT INTO disputes (pickup_id, raised_by, reason) VALUES ($1,$2,$3)',
        [pickup.id, req.user.id, reason || null]);
    }
    await client.query('COMMIT');
    res.json({ confirmation_status: action });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

module.exports = router;
