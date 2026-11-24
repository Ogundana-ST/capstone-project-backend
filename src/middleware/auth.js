const jwt = require('jsonwebtoken');
const db = require('../db');
const { HttpError, ah } = require('../utils');

// Checks the "Authorization: Bearer <token>" header and attaches req.user
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Missing token. Send Authorization: Bearer <JWT>'));
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET); // { id, role }
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired token'));
  }
}

// Role guard: requireRole('ADMIN') or requireRole('HOUSEHOLD','ESTATE')
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role)
    ? next()
    : next(new HttpError(403, `Access denied. Allowed roles: ${roles.join(', ')}`));

// Collector must be admin-approved before using map/weigh features
const requireApprovedCollector = ah(async (req, res, next) => {
  const { rows } = await db.query('SELECT kyc_status, badge_id FROM collector_profiles WHERE user_id=$1', [req.user.id]);
  if (!rows[0] || rows[0].kyc_status !== 'APPROVED')
    throw new HttpError(403, 'Collector KYC not approved yet');
  req.collector = rows[0];
  next();
});

module.exports = { authenticate, requireRole, requireApprovedCollector };
