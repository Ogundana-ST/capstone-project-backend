const { nextSaturday } = require('../utils');

// Estate = Saturday 9:00, Household = Saturday 10:00 (PRD flows 1 & 4)
const slotHour = (role) => (role === 'ESTATE' ? 9 : 10);

// Create the very first recurring pickup after onboarding
async function createFirstRecurring(db, user) {
  const date = nextSaturday(slotHour(user.role));
  await db.query(
    `INSERT INTO pickups (user_id, pickup_type, scheduled_date, materials)
     VALUES ($1,'RECURRING',$2,$3)`,
    [user.id, date, user.usual_materials || []]
  );
  return date;
}

// After a recurring pickup is completed/skipped, create the next one (+7 or +14 days)
async function scheduleNext(db, userId, fromDate) {
  const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [userId]);
  const user = rows[0];
  if (!user || user.is_paused || user.pickup_interval === 'NONE') return null;
  const next = new Date(fromDate);
  next.setUTCDate(next.getUTCDate() + (user.pickup_interval === 'BIWEEKLY' ? 14 : 7));
  await db.query(
    `INSERT INTO pickups (user_id, pickup_type, scheduled_date, materials)
     VALUES ($1,'RECURRING',$2,$3)`,
    [userId, next, user.usual_materials]
  );
  return next;
}

module.exports = { createFirstRecurring, scheduleNext };
