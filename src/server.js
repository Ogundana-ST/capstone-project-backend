require('dotenv').config(); // must be first: loads values from .env
const app = require('./app');

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`RecycleConnect API running on http://localhost:${port}`));
