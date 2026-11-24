const router = require('express').Router();
const db = require('../db');
const { ah } = require('../utils');
const { authenticate } = require('../middleware/auth');

// GET /rates  (All roles) (FR-02)
router.get('/', authenticate, ah(async (req, res) => {
  const { rows } = await db.query('SELECT material, rate_per_kg FROM material_rates ORDER BY material');
  res.json({ rates: rows });
}));

module.exports = router;
