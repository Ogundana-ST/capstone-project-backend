const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const db = require('../db');
const { HttpError, ah } = require('../utils');
const { authenticate, requireRole } = require('../middleware/auth');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function verifyGoogle(idToken) {
  // Dev shortcut for Postman testing: id_token = "dev:someone@email.com"
  if (process.env.ALLOW_DEV_LOGIN === 'true' && idToken.startsWith('dev:')) {
    const email = idToken.slice(4).toLowerCase();
    return { sub: 'dev-' + email, email, name: email.split('@')[0] };
  }
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    return { sub: p.sub, email: p.email.toLowerCase(), name: p.name };
  } catch {
    throw new HttpError(401, 'Invalid Google token');
  }
}

// POST /auth/google  (Public)
router.post('/google', ah(async (req, res) => {
  const { id_token, role } = req.body;
  if (!id_token) throw new HttpError(400, 'id_token is required');
  const g = await verifyGoogle(id_token);

  let { rows } = await db.query('SELECT * FROM users WHERE google_id=$1 OR email=$2', [g.sub, g.email]);
  let user = rows[0];
  let isNew = false;

  if (!user) {
    if (!['HOUSEHOLD', 'ESTATE', 'COLLECTOR'].includes(role))
      throw new HttpError(400, 'role must be HOUSEHOLD, ESTATE or COLLECTOR');
    ({ rows } = await db.query(
      'INSERT INTO users (role, full_name, email, google_id) VALUES ($1,$2,$3,$4) RETURNING *',
      [role, g.name, g.email, g.sub]
    ));
    user = rows[0];
    isNew = true;
  } else if (!user.google_id) {
    await db.query('UPDATE users SET google_id=$1 WHERE id=$2', [g.sub, user.id]);
  }

  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user, is_new_user: isNew });
}));

// POST /auth/otp/verify  (Collector) - mock OTP is always 123456
router.post('/otp/verify', authenticate, requireRole('COLLECTOR'), ah(async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone) throw new HttpError(400, 'phone is required');
  if (otp !== '123456') throw new HttpError(400, 'Invalid OTP');
  await db.query('UPDATE users SET phone=$1, phone_verified=true WHERE id=$2', [phone, req.user.id]);
  res.json({ phone_verified: true });
}));

module.exports = router;
