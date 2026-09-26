/**
 * Express Application Setup
 *
 * Configures middleware and routes.
 * Separated from index.js so the app can be imported by tests
 * without starting the server.
 */

const express = require('express');
const cors = require('cors');
const parcelRoutes = require('./api/routes/parcelRoutes');
const { errorHandler } = require('./api/middleware/errorHandler');

const app = express();

// --- Middleware ---
app.use(cors());                          // Allow frontend to call backend
app.use(express.json({ limit: '10mb' })); // Parse JSON bodies, with a reasonable size limit

// --- Routes ---
app.use('/api/parcels', parcelRoutes);

// --- Health check ---
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Error handling (must be last) ---
app.use(errorHandler);

module.exports = app;
