/**
 * Server Entry Point
 *
 * Starts the Express server.
 * Separated from app.js so tests can import the app without starting the server.
 */

require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`[Server] Parcel Routing System running on port ${PORT}`);
  console.log(`[Server] Health check: http://localhost:${PORT}/api/health`);
});
