const MATERIALS = ['PET', 'CANS', 'CARTONS', 'GLASS'];
const CURRENCY = 'NGN';
const formatNaira = (n) => '₦' + Number(n || 0).toLocaleString('en-US');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Wraps async route handlers so errors go to our error handler automatically
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Next Saturday at the given hour (UTC), always in the future
function nextSaturday(hourUTC, after = new Date()) {
  const d = new Date(after);
  d.setUTCHours(hourUTC, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7));
  if (d <= after) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

module.exports = { MATERIALS, CURRENCY, formatNaira, HttpError, ah, nextSaturday };
