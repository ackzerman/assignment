/**
 * Server Entry Point
 *
 * Starts the Express server.
 * Separated from app.ts so tests can import the app without starting the server.
 */

import app from './app';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`[Server] Parcel Routing System running on port ${PORT}`);
  console.log(`[Server] Health check: http://localhost:${PORT}/api/health`);
});
