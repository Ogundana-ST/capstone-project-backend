const router = require('express').Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { promisify } = require('util');
const { OAuth2Client } = require('google-auth-library');
const db = require('../db');
const { HttpError, ah } = require('../utils');
const { authenticate, requireRole } = require('../middleware/auth');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const scrypt = promisify(crypto.scrypt);

function publicUser(user) {
  const { password_hash, google_id, ...safeUser } = user;
  return safeUser;
}

function issueToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return 'scrypt$' + salt.toString('base64url') + '$' + derived.toString('base64url');
}

async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'base64url');
    const expected = Buffer.from(parts[2], 'base64url');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = await scrypt(password, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

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

  res.json({ token: issueToken(user), user: publicUser(user), is_new_user: isNew });
}));

// POST /auth/signup (Public) - email/password registration
router.post('/signup', ah(async (req, res) => {
  const fullName = String(req.body.full_name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim() || null;
  const password = String(req.body.password || '');
  const role = String(req.body.role || '').trim().toUpperCase();
  if (fullName.length < 2 || fullName.length > 120) throw new HttpError(400, 'full_name must be between 2 and 120 characters');
  if (email.length > 254 || !validEmail(email)) throw new HttpError(400, 'Enter a valid email address');
  if (password.length < 8 || password.length > 128) throw new HttpError(400, 'password must be between 8 and 128 characters');
  if (!['HOUSEHOLD', 'ESTATE', 'COLLECTOR'].includes(role))
    throw new HttpError(400, 'role must be HOUSEHOLD, ESTATE or COLLECTOR');

  const { rows: existing } = await db.query('SELECT id FROM users WHERE lower(email)=$1 LIMIT 1', [email]);
  if (existing.length) throw new HttpError(409, 'An account with this email already exists. Sign in or use Google.');

  const passwordHash = await hashPassword(password);
  let rows;
  try {
    ({ rows } = await db.query(
      'INSERT INTO users (role, full_name, email, phone, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [role, fullName, email, phone, passwordHash]
    ));
  } catch (error) {
    if (error.code === '23505') throw new HttpError(409, 'An account with this email already exists. Sign in or use Google.');
    throw error;
  }

  const user = rows[0];
  res.status(201).json({ token: issueToken(user), user: publicUser(user), is_new_user: true });
}));

// POST /auth/login (Public) - email or phone plus password
router.post('/login', ah(async (req, res) => {
  const identifier = String(req.body.email || req.body.identity || '').trim();
  const password = String(req.body.password || '');
  if (!identifier || !password) throw new HttpError(400, 'email and password are required');

  const email = identifier.toLowerCase();
  const { rows } = await db.query(
    'SELECT * FROM users WHERE lower(email)=$1 OR phone=$2 LIMIT 1',
    [email, identifier]
  );
  const user = rows[0];
  if (!user?.password_hash || !(await verifyPassword(password, user.password_hash)))
    throw new HttpError(401, 'Email/phone or password is incorrect');

  res.json({ token: issueToken(user), user: publicUser(user), is_new_user: false });
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

