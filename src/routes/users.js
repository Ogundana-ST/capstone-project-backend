const express = require('express');
const router = express.Router();
const db = require('../db');
const { MATERIALS, HttpError, ah } = require('../utils');
const { authenticate, requireRole } = require('../middleware/auth');
const { createFirstRecurring, scheduleNext } = require('../services/scheduling');
const profileStorage = require('../services/profile-storage');

const PROFILE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const profileImageBody = express.raw({
  type: (req) => PROFILE_IMAGE_TYPES.has(String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()),
  limit: '2mb'
});
const safeUser = (user) => {
  const { avatar_path, password_hash, google_id, ...publicFields } = user;
  return publicFields;
};

// Read the signed image URL for the currently authenticated account.
router.get('/profile', authenticate, ah(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, role, full_name, email, phone, address, avatar_path FROM users WHERE id=$1',
    [req.user.id]
  );
  const user = rows[0];
  if (!user) throw new HttpError(404, 'User not found');
  const profileImageUrl = user.avatar_path ? await profileStorage.createSignedUrl(user.avatar_path) : null;
  res.json({ user: safeUser(user), profile_image_url: profileImageUrl });
}));

// Store profile images privately in Supabase Storage; never accept a client-supplied object path.
router.put('/profile/avatar', authenticate, (req, res, next) => {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!PROFILE_IMAGE_TYPES.has(contentType)) return next(new HttpError(415, 'Upload a JPEG, PNG, or WebP image'));
  next();
}, profileImageBody, ah(async (req, res) => {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const image = req.body;
  if (!Buffer.isBuffer(image) || image.length === 0) throw new HttpError(400, 'An image file is required');
  if (!profileStorage.matchesImageType(image, contentType)) throw new HttpError(415, 'The image contents do not match the file type');

  const { rows: currentRows } = await db.query('SELECT avatar_path FROM users WHERE id=$1', [req.user.id]);
  if (!currentRows[0]) throw new HttpError(404, 'User not found');
  const previousPath = currentRows[0].avatar_path;
  const objectPath = await profileStorage.upload(req.user.id, contentType, image);
  let profileImageUrl;
  try {
    profileImageUrl = await profileStorage.createSignedUrl(objectPath);
    await db.query('UPDATE users SET avatar_path=$1 WHERE id=$2', [objectPath, req.user.id]);
  } catch (error) {
    await profileStorage.remove(objectPath).catch(() => {});
    throw error;
  }
  if (previousPath && previousPath.startsWith(`${req.user.id}/`) && previousPath !== objectPath) {
    await profileStorage.remove(previousPath).catch((error) => {
      console.warn('[profile/avatar] Could not remove previous image', { status: error.status || 'unknown' });
    });
  }
  res.json({ profile_image_url: profileImageUrl });
}));

router.use(authenticate, requireRole('HOUSEHOLD', 'ESTATE'));

// PATCH /users/profile - update account details without resetting recurring pickups
router.patch('/profile', ah(async (req, res) => {
  const { full_name, address, phone } = req.body;
  if (!full_name || !address) throw new HttpError(400, 'full_name and address are required');
  const { rows } = await db.query(
    'UPDATE users SET full_name=$1, address=$2, phone=$3 WHERE id=$4 RETURNING *',
    [full_name, address, phone || null, req.user.id]
  );
  res.json({ user: safeUser(rows[0]) });
}));

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
  res.json({ user: safeUser(user), next_pickup: next.toISOString() });
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

