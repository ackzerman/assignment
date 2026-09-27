/**
 * Database Layer — SQLite via better-sqlite3
 *
 * Provides durable persistence for batch state and parcel routing results.
 *
 * Design Decision: Why SQLite?
 * - Zero-configuration: no separate server process needed
 * - Perfect for an assessment: single-file database, trivial setup
 * - Synchronous API (better-sqlite3): simpler code, no callback hell
 * - ACID-compliant: supports transactions, unique constraints
 * - Sufficient for the throughput of this system
 *
 * Responsibility separation:
 * - Queue → "What work needs to happen?"
 * - Database → "What happened / what is the current state?"
 *
 * The database stores:
 * - Batch metadata (status, progress counters, timestamps)
 * - Chunk checkpoints (PENDING → PROCESSING → DONE with worker leases)
 * - Individual parcel routing results (department, approvals, reasons)
 *
 * Recovery model (two layers):
 * - Chunk checkpointing = recovery optimization. A retry skips DONE chunks and
 *   reprocesses at most the unfinished chunk.
 * - Parcel-level idempotency = final correctness safeguard:
 *   UNIQUE(batch_id, parcel_id) via INSERT OR IGNORE.
 */

const Database = require('better-sqlite3');
const path = require('path');
const { logger } = require('../observability/logger');

let db = null;

// Chunk checkpointing configuration. Configurable via environment so the
// architecture is not hard-coded around one chunk size.
function getDefaultChunkSize() {
  const parsed = parseInt(process.env.BATCH_CHUNK_SIZE || '500', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
}

// How long a PROCESSING claim is valid before another worker may recover it.
function getDefaultChunkLeaseMs() {
  const parsed = parseInt(process.env.CHUNK_LEASE_MS || '300000', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300000;
}

/**
 * Initializes the database connection and creates tables if they don't exist.
 *
 * @param {string} [dbPath] - Path to the SQLite database file. Defaults to ./data/parcels.db
 * @returns {object} The database instance
 */
function initDatabase(dbPath) {
  if (db) return db;

  const resolvedPath = dbPath || path.join(__dirname, '..', '..', 'data', 'parcels.db');

  // Ensure the data directory exists
  const fs = require('fs');
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  // Foreign keys enforcement
  db.pragma('foreign_keys = ON');

  createTables();
  migrateOwnerColumn();

  logger.info('Database initialized', { path: resolvedPath });

  return db;
}

/**
 * Adds the owner column for batch authorization (Master: object-level ownership).
 * Idempotent migration for databases created before auth was introduced.
 */
function migrateOwnerColumn() {
  const cols = db.prepare('PRAGMA table_info(batches)').all();
  const hasOwner = cols.some((c) => c.name === 'owner');
  if (!hasOwner) {
    db.exec(`ALTER TABLE batches ADD COLUMN owner TEXT NOT NULL DEFAULT 'anonymous'`);
  }
}

/**
 * Creates database tables if they don't exist.
 *
 * Schema design:
 * - batches: One row per batch submission. Tracks status and progress.
 * - parcel_results: One row per parcel in a batch. Stores routing outcomes.
 *   UNIQUE(batch_id, parcel_id) enforces idempotency at the DB level.
 */
function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      total INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      successful INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      owner TEXT NOT NULL DEFAULT 'anonymous',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS parcel_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      parcel_id TEXT NOT NULL,
      parcel_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      department TEXT,
      approvals TEXT,
      matched_rules TEXT,
      reasons TEXT,
      errors TEXT,
      input_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(batch_id, parcel_id),
      FOREIGN KEY (batch_id) REFERENCES batches(id)
    );

    CREATE INDEX IF NOT EXISTS idx_parcel_results_batch_id
      ON parcel_results(batch_id);

    -- Chunk checkpoints for crash recovery (PENDING → PROCESSING → DONE).
    -- A chunk is marked DONE only after its results are bulk-persisted.
    CREATE TABLE IF NOT EXISTS batch_chunks (
      batch_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_index INTEGER NOT NULL,
      end_index INTEGER NOT NULL,
      parcel_count INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      worker_id TEXT,
      claimed_at INTEGER,
      lease_expires_at INTEGER,
      successful INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      PRIMARY KEY (batch_id, chunk_index),
      FOREIGN KEY (batch_id) REFERENCES batches(id)
    );

    CREATE INDEX IF NOT EXISTS idx_batch_chunks_lookup
      ON batch_chunks(batch_id, status, chunk_index);
  `);
}

// --- Batch Operations ---

/**
 * Creates a new batch record in the database.
 *
 * @param {string} batchId - Unique batch identifier
 * @param {number} total - Total number of parcels in the batch
 * @param {Array} parcelsData - Raw parcel data to store for worker retrieval
 * @param {string} [owner] - Owner identity for authorization
 * @param {number} [chunkSize] - Parcels per recovery checkpoint chunk
 * @returns {object} The created batch record
 */
function createBatch(batchId, total, parcelsData, owner = 'anonymous', chunkSize = getDefaultChunkSize()) {
  const stmt = db.prepare(`
    INSERT INTO batches (id, status, total, owner, created_at)
    VALUES (?, 'QUEUED', ?, ?, datetime('now'))
  `);
  stmt.run(batchId, total, owner);

  // Store the raw parcels data as a separate table or inline
  // For simplicity, we store in a batch_data table
  ensureBatchDataTable();
  const dataStmt = db.prepare(`
    INSERT INTO batch_data (batch_id, parcels_json)
    VALUES (?, ?)
  `);
  dataStmt.run(batchId, JSON.stringify(parcelsData));

  // Pre-create chunk checkpoints so retries can skip completed work.
  createChunks(batchId, total, chunkSize);

  return getBatch(batchId);
}

function ensureBatchDataTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS batch_data (
      batch_id TEXT PRIMARY KEY,
      parcels_json TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES batches(id)
    );
  `);
}

/**
 * Retrieves a batch record by ID.
 *
 * @param {string} batchId
 * @returns {object|null} The batch record or null
 */
function getBatch(batchId) {
  const stmt = db.prepare('SELECT * FROM batches WHERE id = ?');
  const row = stmt.get(batchId);
  if (!row) return null;

  return {
    batchId: row.id,
    status: row.status,
    total: row.total,
    processed: row.processed,
    successful: row.successful,
    failed: row.failed,
    error: row.error,
    owner: row.owner || 'anonymous',
    progress: row.total > 0 ? Math.round((row.processed / row.total) * 100) : 0,
    ...getChunkProgress(batchId),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/**
 * Retrieves the raw parcels data for a batch (used by the worker).
 *
 * @param {string} batchId
 * @returns {Array|null} Parsed parcels array or null
 */
function getBatchData(batchId) {
  ensureBatchDataTable();
  const stmt = db.prepare('SELECT parcels_json FROM batch_data WHERE batch_id = ?');
  const row = stmt.get(batchId);
  if (!row) return null;
  return JSON.parse(row.parcels_json);
}

/**
 * Updates a batch's status.
 *
 * @param {string} batchId
 * @param {string} status - New status
 * @param {object} [extra] - Additional fields to update
 */
function updateBatchStatus(batchId, status, extra = {}) {
  let sql = 'UPDATE batches SET status = ?';
  const params = [status];

  if (extra.startedAt) {
    sql += ', started_at = ?';
    params.push(extra.startedAt);
  }
  if (extra.completedAt) {
    sql += ', completed_at = ?';
    params.push(extra.completedAt);
  }
  if (extra.error) {
    sql += ', error = ?';
    params.push(extra.error);
  }

  sql += ' WHERE id = ?';
  params.push(batchId);

  db.prepare(sql).run(...params);
}

/**
 * Increments the progress counters for a batch.
 * Called by the worker after processing each parcel.
 *
 * @param {string} batchId
 * @param {number} processedDelta
 * @param {number} successfulDelta
 * @param {number} failedDelta
 */
function updateBatchProgress(batchId, processedDelta, successfulDelta, failedDelta) {
  const stmt = db.prepare(`
    UPDATE batches
    SET processed = processed + ?,
        successful = successful + ?,
        failed = failed + ?
    WHERE id = ?
  `);
  stmt.run(processedDelta, successfulDelta, failedDelta, batchId);
}

// --- Parcel Result Operations ---

/**
 * Saves a parcel routing result to the database.
 * Uses INSERT OR IGNORE to handle at-least-once delivery (idempotency).
 * This UNIQUE(batch_id, parcel_id) protection is the final correctness
 * safeguard and is preserved alongside chunk checkpointing.
 *
 * @param {object} result - The parcel result to persist
 * @param {string} result.batchId
 * @param {string} result.parcelId
 * @param {number} result.index
 * @param {string} result.status - 'routed' | 'invalid' | 'error'
 * @param {string} [result.department]
 * @param {Array} [result.approvals]
 * @param {Array} [result.matchedRules]
 * @param {Array} [result.reasons]
 * @param {Array} [result.errors]
 * @param {object} [result.inputSummary]
 * @returns {boolean} true if inserted, false if duplicate (already existed)
 */
function saveParcelResult(result) {
  return insertParcelResultRow(result);
}
function insertParcelResultRow(result) {
  const info = db.prepare(`
    INSERT OR IGNORE INTO parcel_results
    (batch_id, parcel_id, parcel_index, status, department, approvals, matched_rules, reasons, errors, input_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.batchId,
    result.parcelId,
    result.index,
    result.status,
    result.department || null,
    result.approvals ? JSON.stringify(result.approvals) : null,
    result.matchedRules ? JSON.stringify(result.matchedRules) : null,
    result.reasons ? JSON.stringify(result.reasons) : null,
    result.errors ? JSON.stringify(result.errors) : null,
    result.inputSummary ? JSON.stringify(result.inputSummary) : null,
  );

  return info.changes > 0;
}

/**
 * Saves multiple parcel results in a single transaction (batch insert).
 * Much faster than individual inserts for large batches.
 *
 * @param {Array} results - Array of parcel result objects
 * @returns {{ inserted: number, duplicates: number }}
 */
function saveParcelResultsBatch(results) {
  let inserted = 0;
  let duplicates = 0;

  const transaction = db.transaction((items) => {
    for (const result of items) {
      const wasInserted = saveParcelResult(result);
      if (wasInserted) {
        inserted++;
      } else {
        duplicates++;
      }
    }
  });

  transaction(results);
  return { inserted, duplicates };
}

// --- Chunk Checkpoint Operations ---

/**
 * Pre-creates PENDING chunk checkpoints for a batch.
 * Chunk boundaries are fixed at creation so retries resume the same chunks.
 *
 * @param {string} batchId
 * @param {number} total - Total parcels in the batch
 * @param {number} [chunkSize] - Parcels per chunk
 * @returns {number} Number of chunks created
 */
function createChunks(batchId, total, chunkSize = getDefaultChunkSize()) {
  if (total <= 0) return 0;
  const size = chunkSize > 0 ? chunkSize : total;
  const count = Math.ceil(total / size);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO batch_chunks
    (batch_id, chunk_index, start_index, end_index, parcel_count, status)
    VALUES (?, ?, ?, ?, ?, 'PENDING')
  `);

  const transaction = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const start = i * size;
      const end = Math.min(start + size, total);
      stmt.run(batchId, i, start, end, end - start);
    }
  });
  transaction();

  return count;
}

/**
 * Ensures chunks exist for a batch (covers batches created before
 * checkpointing was introduced).
 *
 * @returns {number} Number of chunks for the batch
 */
function ensureChunksForBatch(batchId, total, chunkSize = getDefaultChunkSize()) {
  const row = db.prepare('SELECT COUNT(*) as count FROM batch_chunks WHERE batch_id = ?').get(batchId);
  if (row.count === 0 && total > 0) {
    createChunks(batchId, total, chunkSize);
    return Math.ceil(total / (chunkSize > 0 ? chunkSize : total));
  }
  return row.count;
}

function mapChunkRow(row) {
  if (!row) return null;
  return {
    batchId: row.batch_id,
    chunkIndex: row.chunk_index,
    startIndex: row.start_index,
    endIndex: row.end_index,
    parcelCount: row.parcel_count,
    status: row.status,
    workerId: row.worker_id,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    successful: row.successful,
    failed: row.failed,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/**
 * Returns all chunk checkpoints for a batch, ordered by chunk index.
 */
function getChunks(batchId) {
  return db.prepare('SELECT * FROM batch_chunks WHERE batch_id = ? ORDER BY chunk_index ASC')
    .all(batchId)
    .map(mapChunkRow);
}

/**
 * Returns a single chunk checkpoint, or null.
 */
function getChunk(batchId, chunkIndex) {
  return mapChunkRow(
    db.prepare('SELECT * FROM batch_chunks WHERE batch_id = ? AND chunk_index = ?').get(batchId, chunkIndex),
  );
}

/**
 * Chunk progress derived from checkpoints (DB is the source of truth).
 */
function getChunkProgress(batchId) {
  let totalChunks = 0;
  let completedChunks = 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as completed
      FROM batch_chunks WHERE batch_id = ?
    `).get(batchId);
    totalChunks = row.total || 0;
    completedChunks = row.completed || 0;
  } catch {
    // Table may not exist yet for very old databases; callers treat as no chunks.
  }
  return { totalChunks, completedChunks };
}

/**
 * Atomically claims a specific chunk for a worker.
 *
 * Single UPDATE statement: only one worker can win, even if two workers
 * attempt to claim the same chunk concurrently. A stale PROCESSING chunk
 * (lease expired, owner crashed) becomes reclaimable.
 *
 * @param {string} batchId
 * @param {number} chunkIndex
 * @param {string} workerId
 * @param {number} [leaseMs] - Lease duration from now
 * @returns {object|null} The claimed chunk, or null if already claimed/held
 */
function claimChunk(batchId, chunkIndex, workerId, leaseMs = getDefaultChunkLeaseMs()) {
  const now = Date.now();
  const info = db.prepare(`
    UPDATE batch_chunks
    SET status = 'PROCESSING', worker_id = ?, claimed_at = ?, lease_expires_at = ?
    WHERE batch_id = ? AND chunk_index = ?
      AND (status = 'PENDING' OR (status = 'PROCESSING' AND lease_expires_at <= ?))
  `).run(workerId, now, now + leaseMs, batchId, chunkIndex, now);

  if (info.changes === 0) return null;
  return getChunk(batchId, chunkIndex);
}

/**
 * Atomically claims the next available chunk (PENDING first, then stale
 * PROCESSING with an expired lease), ordered by chunk index.
 *
 * @returns {object|null} The claimed chunk, or null when no chunk is claimable
 */
function claimNextChunk(batchId, workerId, leaseMs = getDefaultChunkLeaseMs()) {
  const now = Date.now();
  const candidates = db.prepare(`
    SELECT chunk_index FROM batch_chunks
    WHERE batch_id = ? AND (status = 'PENDING' OR (status = 'PROCESSING' AND lease_expires_at <= ?))
    ORDER BY chunk_index ASC
  `).all(batchId, now);

  for (const { chunk_index: chunkIndex } of candidates) {
    const claimed = claimChunk(batchId, chunkIndex, workerId, leaseMs);
    if (claimed) return claimed;
  }
  return null;
}

/**
 * Releases a worker's own PROCESSING claim back to PENDING so a retry can
 * reclaim it immediately (instead of waiting for lease expiry).
 *
 * Only releases when the chunk is still PROCESSING under this worker — never
 * touches DONE chunks or chunks owned by another live worker. Safe to call
 * after a crash window where nothing was durably persisted.
 *
 * @returns {boolean} true if the claim was released
 */
function releaseChunk(batchId, chunkIndex, workerId) {
  const info = db.prepare(`
    UPDATE batch_chunks
    SET status = 'PENDING', worker_id = NULL, claimed_at = NULL, lease_expires_at = NULL
    WHERE batch_id = ? AND chunk_index = ? AND status = 'PROCESSING' AND worker_id = ?
  `).run(batchId, chunkIndex, workerId);

  return info.changes > 0;
}

/**
 * Bulk-persists a chunk's results and marks the chunk DONE in ONE transaction.
 *
 * The chunk reaches DONE only after its results are durably stored, so a
 * crash before this transaction leaves the chunk reclaimable (recomputed),
 * while a crash after it leaves the chunk skipped on retry. Parcel-level
 * INSERT OR IGNORE remains the final guard against duplicates.
 *
 * @param {string} batchId
 * @param {number} chunkIndex
 * @param {Array} results - Parcel result objects for this chunk
 * @param {number} successful - Routed count in this chunk
 * @param {number} failed - Invalid/error count in this chunk
 * @returns {{ inserted: number, duplicates: number }}
 */
function persistChunkAndMarkDone(batchId, chunkIndex, results, successful, failed) {
  let inserted = 0;
  let duplicates = 0;

  const transaction = db.transaction(() => {
    for (const result of results) {
      if (insertParcelResultRow(result)) {
        inserted++;
      } else {
        duplicates++;
      }
    }

    db.prepare(`
      UPDATE batch_chunks
      SET status = 'DONE', successful = ?, failed = ?, completed_at = datetime('now')
      WHERE batch_id = ? AND chunk_index = ?
    `).run(successful, failed, batchId, chunkIndex);

    db.prepare(`
      UPDATE batches
      SET processed = processed + ?,
          successful = successful + ?,
          failed = failed + ?
      WHERE id = ?
    `).run(results.length, successful, failed, batchId);
  });

  transaction();
  return { inserted, duplicates };
}

/**
 * Retrieves all parcel results for a batch.
 *
 * @param {string} batchId
 * @param {object} [options]
 * @param {number} [options.limit] - Max results to return
 * @param {number} [options.offset] - Skip N results (for pagination)
 * @returns {Array} Array of parcel result objects
 */
function getBatchResults(batchId, options = {}) {
  let sql = 'SELECT * FROM parcel_results WHERE batch_id = ? ORDER BY parcel_index ASC';
  const params = [batchId];

  if (options.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options.offset) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }

  const rows = db.prepare(sql).all(...params);

  return rows.map(row => ({
    parcelId: row.parcel_id,
    index: row.parcel_index,
    status: row.status,
    department: row.department,
    approvals: row.approvals ? JSON.parse(row.approvals) : [],
    matchedRules: row.matched_rules ? JSON.parse(row.matched_rules) : [],
    reasons: row.reasons ? JSON.parse(row.reasons) : [],
    errors: row.errors ? JSON.parse(row.errors) : null,
    inputSummary: row.input_summary ? JSON.parse(row.input_summary) : null,
    createdAt: row.created_at,
  }));
}

/**
 * Returns the count of results for a batch.
 *
 * @param {string} batchId
 * @returns {number}
 */
function getBatchResultCount(batchId) {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM parcel_results WHERE batch_id = ?');
  return stmt.get(batchId).count;
}

/**
 * Returns all batches (optionally filtered by status).
 *
 * @param {object} [options]
 * @param {string} [options.status] - Filter by status
 * @param {number} [options.limit] - Max records
 * @returns {Array}
 */
function listBatches(options = {}) {
  let sql = 'SELECT * FROM batches';
  const params = [];
  const clauses = [];

  if (options.status) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  if (options.owner) {
    clauses.push('owner = ?');
    params.push(options.owner);
  }

  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }

  sql += ' ORDER BY created_at DESC';

  if (options.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params);
  return rows.map(row => ({
    batchId: row.id,
    status: row.status,
    total: row.total,
    processed: row.processed,
    successful: row.successful,
    failed: row.failed,
    owner: row.owner || 'anonymous',
    progress: row.total > 0 ? Math.round((row.processed / row.total) * 100) : 0,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

/**
 * Closes the database connection. Used for graceful shutdown.
 */
function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

/**
 * Returns the raw database instance (for testing/advanced usage).
 */
function getDb() {
  return db;
}

module.exports = {
  initDatabase,
  closeDatabase,
  getDb,
  getDefaultChunkSize,
  getDefaultChunkLeaseMs,
  createBatch,
  getBatch,
  getBatchData,
  updateBatchStatus,
  updateBatchProgress,
  saveParcelResult,
  saveParcelResultsBatch,
  createChunks,
  ensureChunksForBatch,
  getChunks,
  getChunk,
  getChunkProgress,
  claimChunk,
  claimNextChunk,
  releaseChunk,
  persistChunkAndMarkDone,
  getBatchResults,
  getBatchResultCount,
  listBatches,
};
