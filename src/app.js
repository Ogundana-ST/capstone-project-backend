const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ app: 'RecycleConnect API', status: 'running', docs: 'See README.md' }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/v1/auth', require('./routes/auth'));
app.use('/v1/users', require('./routes/users'));
app.use('/v1/rates', require('./routes/rates'));
app.use('/v1/pickups', require('./routes/pickups'));
app.use('/v1/admin', require('./routes/admin'));
app.use('/v1', require('./routes/collectors')); // /collectors/kyc and /collector/...

app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` }));

// Central error handler: every error ends up here
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Profile image must be 2 MB or smaller' });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong on the server' });
});

module.exports = app;
