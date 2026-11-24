// Runs schema.sql against your database:  npm run db:setup
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

(async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('Database tables created and seeded successfully.');
  } catch (err) {
    console.error('Database setup failed:', err.message);
  } finally {
    await pool.end();
  }
})();
