/**
 * Batch Store — temporary batch state in Redis.
 *
 * There is NO relational database in this architecture. All batch state is
 * temporary Redis state with a TTL (the processing session ends, state expires):
 *
 *   batch:{id}:meta     hash   status/total/chunks/error/timestamps
 *   batch:{id}:input    string JSON parcel array (worker loads chunk slices)
 *   batch:{id}:chunks   hash   chunkIndex -> PENDING | PROCESSING:{worker}:{leaseMs} | DONE:{ok}:{fail}
 *   batch:{id}:lock:{i} string claim lock (SET NX PX lease) — the atomic arbiter
 *   batch:{id}:results  hash   parcelIndex -> JSON routing result
 *
 * Two layers:
 * - Chunk checkpoints = recovery optimization (skip DONE chunks on retry).
 * - Parcel-level idempotency = correctness safeguard: results are written
 *   with HSETNX inside the ownership-checked checkpoint, so a retried chunk
 *   can never create duplicate authoritative results.
 *
 * Progress is DERIVED from checkpoint state (DONE chunk fields + results
 * hash size), never incremented per encounter — a retried chunk therefore
 * cannot double-count progress.
 *
 * Atomicity via Lua: claiming, ownership-checked checkpointing, and
 * ownership-checked release each execute as a single atomic script, so a
 * stale worker can never commit work it no longer owns — even if its lease
 * expired and another worker reclaimed the chunk in between.
 */

const { getRedisClient } = require('./redis');
const { randomUUID } = require('crypto');
const { logger } = require('../observability/logger');

function getBatchTTLSeconds() {
  const parsed = parseInt(process.env.BATCH_TTL_SECONDS || '86400', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 86400;
}

function getDefaultChunkSize() {
  const parsed = parseInt(process.env.BATCH_CHUNK_SIZE || '500', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
}

function getDefaultChunkLeaseMs() {
  const parsed = parseInt(process.env.CHUNK_LEASE_MS || '300000', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300000;
}

function getResultsMaxLimit() {
  const parsed = parseInt(process.env.RESULTS_MAX_LIMIT || '1000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

function keys(batchId) {
  const p = `batch:${batchId}`;
  return {
    meta: `${p}:meta`,
    input: `${p}:input`,
    chunks: `${p}:chunks`,
    results: `${p}:results`,
    lock: (idx) => `${p}:lock:${idx}`,
    lockPattern: `${p}:lock:*`,
  };
}

/**
 * Ownership tokens: every successful claim mints a UNIQUE token
 * (`{workerId}:{uuid}`). The lock key holds the token; checkpoint and
 * release scripts only act when the lock still holds OUR token. A stale
 * worker (lease expired, chunk reclaimed by someone else) can therefore
 * never mark DONE, never delete another worker's lock, and never corrupt
 * progress — its commit is rejected atomically.
 */
function mintToken(workerId) {
  return `${workerId}:${randomUUID()}`;
}

// Atomic claim: skip DONE, win SET NX PX, re-check DONE, record PROCESSING.
// The lock holds a UNIQUE per-claim token; the field keeps the human
// workerId for observability. Returns the token on success, nil otherwise.
const CLAIM_SCRIPT = [
  "local field = redis.call('hget', KEYS[2], ARGV[3])",
  'if not field then return nil end',
  "if string.sub(field, 1, 4) == 'DONE' then return nil end",
  "local ok = redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[4], 'NX')",
  'if ok == false then return nil end',
  "field = redis.call('hget', KEYS[2], ARGV[3])",
  "if field and string.sub(field, 1, 4) == 'DONE' then",
  "  redis.call('del', KEYS[1])",
  '  return nil',
  'end',
  "redis.call('hset', KEYS[2], ARGV[3], 'PROCESSING:' .. ARGV[2] .. ':' .. ARGV[6])",
  "redis.call('expire', KEYS[2], ARGV[5])",
  "redis.call('expire', KEYS[3], ARGV[5])",
  "redis.call('expire', KEYS[4], ARGV[5])",
  'return ARGV[1]',
].join('\n');

// Atomic ownership-checked checkpoint: ONLY the current lock holder commits.
// Returns {committed, inserted, duplicates}; stale holders get {0,0,0}.
const CHECKPOINT_SCRIPT = [
  "if redis.call('get', KEYS[1]) ~= ARGV[1] then",
  '  return {0, 0, 0}',
  'end',
  'local inserted = 0',
  'local dups = 0',
  'local i = 6',
  'while i <= #ARGV do',
  "  if redis.call('hsetnx', KEYS[3], ARGV[i], ARGV[i + 1]) == 1 then",
  '    inserted = inserted + 1',
  '  else',
  '    dups = dups + 1',
  '  end',
  '  i = i + 2',
  'end',
  "redis.call('hset', KEYS[2], ARGV[2], 'DONE:' .. ARGV[3] .. ':' .. ARGV[4])",
  "redis.call('del', KEYS[1])",
  "redis.call('expire', KEYS[2], ARGV[5])",
  "redis.call('expire', KEYS[3], ARGV[5])",
  "redis.call('expire', KEYS[4], ARGV[5])",
  "redis.call('expire', KEYS[5], ARGV[5])",
  'return {1, inserted, dups}',
].join('\n');

// Atomic ownership-checked release: only the lock holder resets to PENDING
// (and only from PROCESSING — never from DONE) and deletes its own lock.
const RELEASE_SCRIPT = [
  "if redis.call('get', KEYS[1]) ~= ARGV[1] then",
  '  return 0',
  'end',
  "local field = redis.call('hget', KEYS[2], ARGV[2])",
  "if field and string.sub(field, 1, 10) == 'PROCESSING' then",
  "  redis.call('hset', KEYS[2], ARGV[2], 'PENDING')",
  'end',
  "redis.call('del', KEYS[1])",
  'return 1',
].join('\n');

// Atomic terminal FAILED transition: ONLY from QUEUED/PROCESSING.
// A COMPLETED / COMPLETED_WITH_ERRORS / FAILED batch is never overwritten,
// so a stale or duplicate job failure cannot corrupt a finished batch.
// Returns 1 if transitioned, 0 otherwise.
const TRY_FAIL_SCRIPT = [
  "local status = redis.call('hget', KEYS[1], 'status')",
  "if status ~= 'QUEUED' and status ~= 'PROCESSING' then",
  '  return 0',
  'end',
  "redis.call('hset', KEYS[1], 'status', 'FAILED', 'completedAt', ARGV[1], 'error', ARGV[2])",
  "redis.call('expire', KEYS[1], ARGV[3])",
  'return 1',
].join('\n');

// Atomic terminal COMPLETED transition: ONLY from QUEUED/PROCESSING and
// ONLY when every chunk is DONE. Returns 1 if this call performed the
// transition (the caller owns completion accounting), 0 otherwise — so
// duplicate executions observing all-DONE cannot double-record completion.
const TRY_COMPLETE_SCRIPT = [
  "local status = redis.call('hget', KEYS[1], 'status')",
  "if status ~= 'QUEUED' and status ~= 'PROCESSING' then",
  '  return 0',
  'end',
  "local total = tonumber(redis.call('hlen', KEYS[2]))",
  'if total == 0 then return 0 end',
  "local fields = redis.call('hgetall', KEYS[2])",
  'local completed = 0',
  'for i = 1, #fields, 2 do',
  "  if string.sub(fields[i + 1], 1, 4) == 'DONE' then",
  '    completed = completed + 1',
  '  end',
  'end',
  'if completed ~= total then return 0 end',
  "redis.call('hset', KEYS[1], 'status', ARGV[1], 'completedAt', ARGV[2])",
  "redis.call('expire', KEYS[1], ARGV[3])",
  'return 1',
].join('\n');

function parseChunkField(raw, chunkIndex) {
  if (raw === undefined || raw === null) return null;
  if (raw === 'PENDING') {
    return { chunkIndex, status: 'PENDING', workerId: null };
  }
  let m = /^PROCESSING:(.+):(\d+)$/.exec(raw);
  if (m) {
    return { chunkIndex, status: 'PROCESSING', workerId: m[1], leaseExpiresAt: parseInt(m[2], 10) };
  }
  m = /^DONE:(\d+):(\d+)$/.exec(raw);
  if (m) {
    return {
      chunkIndex,
      status: 'DONE',
      successful: parseInt(m[1], 10),
      failed: parseInt(m[2], 10),
    };
  }
  return { chunkIndex, status: 'UNKNOWN', workerId: null };
}

/**
 * Creates temporary batch state: meta + input + PENDING chunk checkpoints.
 * Overwrites nothing: batch IDs are full UUIDs, collisions are not expected.
 */
async function createBatchState(batchId, parcels, chunkSize = getDefaultChunkSize()) {
  const redis = await getRedisClient();
  const k = keys(batchId);
  const ttl = getBatchTTLSeconds();
  const size = chunkSize > 0 ? chunkSize : parcels.length;
  const totalChunks = Math.max(1, Math.ceil(parcels.length / size));
  const now = new Date().toISOString();

  const chunkFields = [];
  for (let i = 0; i < totalChunks; i++) {
    chunkFields.push(i, 'PENDING');
  }

  const multi = redis.multi();
  multi.hset(k.meta, {
    status: 'QUEUED',
    total: parcels.length,
    totalChunks,
    chunkSize: size,
    error: '',
    createdAt: now,
    startedAt: '',
    completedAt: '',
  });
  multi.set(k.input, JSON.stringify(parcels));
  if (chunkFields.length > 0) {
    multi.hset(k.chunks, ...chunkFields);
  }
  multi.expire(k.meta, ttl);
  multi.expire(k.input, ttl);
  multi.expire(k.chunks, ttl);
  multi.expire(k.results, ttl);
  await multi.exec();

  logger.info('Batch state created', { batchId, total: parcels.length, totalChunks });
  return getBatchState(batchId);
}

/**
 * Reads batch state. Progress is derived from checkpoint state:
 * processed = stored results count, successful/failed = sums over DONE chunks.
 * Returns null when the batch is unknown (never created or TTL-expired).
 */
async function getBatchState(batchId) {
  const redis = await getRedisClient();
  const k = keys(batchId);
  const [meta, chunks, processed] = await Promise.all([
    redis.hgetall(k.meta),
    redis.hgetall(k.chunks),
    redis.hlen(k.results),
  ]);
  if (!meta || Object.keys(meta).length === 0) return null;

  const total = parseInt(meta.total || '0', 10);
  const chunkSize = parseInt(meta.chunkSize || '0', 10) || total;
  let completedChunks = 0;
  let successful = 0;
  let failed = 0;
  for (const raw of Object.values(chunks)) {
    const m = /^DONE:(\d+):(\d+)$/.exec(raw || '');
    if (m) {
      completedChunks++;
      successful += parseInt(m[1], 10);
      failed += parseInt(m[2], 10);
    }
  }

  return {
    batchId,
    status: meta.status || 'QUEUED',
    total,
    processed,
    successful,
    failed,
    error: meta.error || null,
    progress: total > 0 ? Math.round((processed / total) * 100) : 0,
    totalChunks: parseInt(meta.totalChunks || '0', 10),
    completedChunks,
    chunkSize,
    createdAt: meta.createdAt || null,
    startedAt: meta.startedAt || null,
    completedAt: meta.completedAt || null,
  };
}

/**
 * Loads the raw parcel array for a batch (worker slices chunk ranges).
 * Returns null when unknown/expired.
 */
async function getBatchInput(batchId) {
  const redis = await getRedisClient();
  const raw = await redis.get(keys(batchId).input);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function boundsFor(chunkIndex, chunkSize, total) {
  const startIndex = chunkIndex * chunkSize;
  const endIndex = Math.min(startIndex + chunkSize, total);
  return { startIndex, endIndex, parcelCount: Math.max(0, endIndex - startIndex) };
}

async function getChunks(batchId) {
  const redis = await getRedisClient();
  const k = keys(batchId);
  const [meta, all] = await Promise.all([
    redis.hgetall(k.meta),
    redis.hgetall(k.chunks),
  ]);
  const total = parseInt(meta.total || '0', 10);
  const chunkSize = parseInt(meta.chunkSize || '0', 10) || total;
  return Object.entries(all)
    .map(([idx, raw]) => ({
      ...parseChunkField(raw, parseInt(idx, 10)),
      ...boundsFor(parseInt(idx, 10), chunkSize, total),
    }))
    .filter((c) => c.status)
    .sort((a, b) => a.chunkIndex - b.chunkIndex);
}

async function getChunk(batchId, chunkIndex) {
  const redis = await getRedisClient();
  const k = keys(batchId);
  const [meta, raw] = await Promise.all([
    redis.hgetall(k.meta),
    redis.hget(k.chunks, chunkIndex),
  ]);
  const parsed = parseChunkField(raw, chunkIndex);
  if (!parsed) return null;
  const total = parseInt(meta.total || '0', 10);
  const chunkSize = parseInt(meta.chunkSize || '0', 10) || total;
  return { ...parsed, ...boundsFor(chunkIndex, chunkSize, total) };
}

async function getChunkProgress(batchId) {
  const state = await getBatchState(batchId);
  if (!state) return { totalChunks: 0, completedChunks: 0 };
  return { totalChunks: state.totalChunks, completedChunks: state.completedChunks };
}

/**
 * Atomically claims a specific chunk for a worker (single Lua script).
 *
 * Only one worker can win a given chunk: the script skips DONE chunks and
 * requires winning SET NX PX. A stale lock (holder crashed, key expired via
 * PX) is reclaimable by any worker. The returned unique token is the ONLY
 * credential accepted by checkpoint/release for this claim.
 *
 * @param {string} batchId
 * @param {number} chunkIndex
 * @param {string} workerId - Human identity recorded on the chunk
 * @param {number} [leaseMs] - Lease duration from now
 * @returns {object|null} Claimed chunk (with `token`) or null
 */
async function claimChunk(batchId, chunkIndex, workerId, leaseMs = getDefaultChunkLeaseMs()) {
  const redis = await getRedisClient();
  const k = keys(batchId);
  const token = mintToken(workerId);
  // Metadata must record the ACTUAL expiration (now + lease), matching the
  // PX lease on the lock key — not the claim time.
  const leaseExpiresAt = Date.now() + leaseMs;

  const won = await redis.eval(
    CLAIM_SCRIPT,
    4,
    k.lock(chunkIndex),
    k.chunks,
    k.meta,
    k.results,
    token,
    workerId,
    chunkIndex,
    leaseMs,
    getBatchTTLSeconds(),
    leaseExpiresAt,
  );
  if (!won) return null;

  const chunk = await getChunk(batchId, chunkIndex);
  if (!chunk) return null;
  return { ...chunk, token };
}

/**
 * Claims the next available chunk (lowest index first), or null when every
 * chunk is DONE or held by a live lock.
 */
async function claimNextChunk(batchId, workerId, leaseMs = getDefaultChunkLeaseMs()) {
  const chunks = await getChunks(batchId);
  for (const chunk of chunks) {
    if (chunk.status === 'DONE') continue;
    const claimed = await claimChunk(batchId, chunk.chunkIndex, workerId, leaseMs);
    if (claimed) return claimed;
  }
  return null;
}

/**
 * Releases a claim back to PENDING — but ONLY if the caller still holds the
 * exact ownership token (single Lua script). A stale worker whose chunk was
 * reclaimed gets 0 and changes nothing: never touches DONE chunks, never
 * deletes another worker's lock.
 *
 * @param {string} batchId
 * @param {number} chunkIndex
 * @param {string} token - Ownership token returned by claimChunk
 * @returns {boolean} true if our claim was released
 */
async function releaseChunk(batchId, chunkIndex, token) {
  const redis = await getRedisClient();
  const k = keys(batchId);
  const released = await redis.eval(
    RELEASE_SCRIPT,
    2,
    k.lock(chunkIndex),
    k.chunks,
    token,
    chunkIndex,
  );
  return released === 1;
}

/**
 * Ownership-checked checkpoint (single Lua script): ONLY the current lock
 * holder commits. Stores the chunk's results (HSETNX per parcel =
 * parcel-level idempotency: retries can never duplicate authoritative
 * results), marks the chunk DONE with its outcome, deletes its own lock,
 * and refreshes TTLs — atomically. A chunk is therefore never reported DONE
 * before its results are stored, and a stale worker can never overwrite the
 * state of the worker that reclaimed the chunk.
 *
 * @param {string} batchId
 * @param {number} chunkIndex
 * @param {string} token - Ownership token returned by claimChunk
 * @param {Array} results - Parcel result objects for this chunk
 * @param {number} successful - Routed count in this chunk
 * @param {number} failed - Invalid/error count in this chunk
 * @returns {{ committed: boolean, inserted: number, duplicates: number }}
 */
async function checkpointChunk(batchId, chunkIndex, token, results, successful, failed) {
  const redis = await getRedisClient();
  const k = keys(batchId);
  const ttl = getBatchTTLSeconds();

  const argv = [token, chunkIndex, successful, failed, ttl];
  for (const r of results) {
    argv.push(r.index, JSON.stringify(serializeResult(r)));
  }

  const [committed, inserted, duplicates] = await redis.eval(
    CHECKPOINT_SCRIPT,
    5,
    k.lock(chunkIndex),
    k.chunks,
    k.results,
    k.meta,
    k.input,
    ...argv,
  );
  return { committed: committed === 1, inserted, duplicates };
}

/**
 * THE canonical batch result contract (single representation used by the
 * results API and the frontend). Every field the UI needs is present:
 * parcelId, index, status, department, requiresApproval, approvals
 * ({type, reason}), matchedRules, reasons, errors, inputSummary.
 */
function serializeResult(r) {
  const approvals = r.approvals || [];
  return {
    parcelId: r.parcelId,
    index: r.index,
    status: r.status,
    department: r.department || null,
    requiresApproval: approvals.length > 0,
    approvals,
    matchedRules: r.matchedRules || [],
    reasons: r.reasons || [],
    errors: r.errors || null,
    inputSummary: r.inputSummary || null,
  };
}

/**
 * Updates batch status fields (QUEUED→PROCESSING→terminal). Terminal states
 * also stamp completedAt. Refreshes the meta TTL.
 */
async function setBatchStatus(batchId, status, extra = {}) {
  const redis = await getRedisClient();
  const k = keys(batchId);
  const fields = { status };
  if (extra.startedAt) fields.startedAt = extra.startedAt;
  if (extra.completedAt) fields.completedAt = extra.completedAt;
  if (extra.error !== undefined) fields.error = extra.error || '';
  const multi = redis.multi();
  multi.hset(k.meta, fields);
  multi.expire(k.meta, getBatchTTLSeconds());
  await multi.exec();
}

async function markBatchFailed(batchId, error) {
  await setBatchStatus(batchId, 'FAILED', {
    completedAt: new Date().toISOString(),
    error,
  });
}

/**
 * Guarded FAILED transition for exhausted job failures (single Lua script).
 * Transitions QUEUED/PROCESSING → FAILED only; already-terminal batches
 * (COMPLETED, COMPLETED_WITH_ERRORS, FAILED) are left untouched.
 *
 * @returns {boolean} true if this call performed the transition
 */
async function tryMarkBatchFailed(batchId, error) {
  const redis = await getRedisClient();
  const k = keys(batchId);
  const transitioned = await redis.eval(
    TRY_FAIL_SCRIPT,
    1,
    k.meta,
    new Date().toISOString(),
    error || '',
    getBatchTTLSeconds(),
  );
  return transitioned === 1;
}

/**
 * Guarded terminal completion transition for batch finalization (single Lua
 * script). Transitions QUEUED/PROCESSING → given COMPLETED status only when
 * every chunk is DONE. Returns true only to the execution that actually
 * performed the transition, so completion metrics are recorded exactly once.
 *
 * @param {string} batchId
 * @param {string} status - 'COMPLETED' or 'COMPLETED_WITH_ERRORS'
 * @returns {boolean} true if this call performed the transition
 */
async function tryFinalizeBatch(batchId, status) {
  const redis = await getRedisClient();
  const k = keys(batchId);
  const transitioned = await redis.eval(
    TRY_COMPLETE_SCRIPT,
    2,
    k.meta,
    k.chunks,
    status,
    new Date().toISOString(),
    getBatchTTLSeconds(),
  );
  return transitioned === 1;
}

/**
 * Deletes all temporary keys for a batch (cleanup when queue submission
 * fails, so no falsely-QUEUED state lingers).
 */
async function deleteBatch(batchId) {
  const redis = await getRedisClient();
  const k = keys(batchId);
  const lockKeys = await redis.keys(k.lockPattern);
  const all = [k.meta, k.input, k.chunks, k.results, ...lockKeys];
  if (all.length > 0) {
    await redis.del(...all);
  }
}

/**
 * Reads stored results ordered by parcel index, paginated.
 * Limit is capped so one request cannot dump an unbounded result set.
 */
async function getBatchResults(batchId, options = {}) {
  const redis = await getRedisClient();
  const maxLimit = getResultsMaxLimit();
  let limit = options.limit !== undefined ? parseInt(options.limit, 10) : maxLimit;
  if (!Number.isFinite(limit) || limit <= 0) limit = maxLimit;
  limit = Math.min(limit, maxLimit);
  let offset = options.offset !== undefined ? parseInt(options.offset, 10) : 0;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const all = await redis.hgetall(keys(batchId).results);
  const rows = Object.entries(all)
    .map(([idx, raw]) => {
      try {
        return { idx: parseInt(idx, 10), result: JSON.parse(raw) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.idx - b.idx)
    .slice(offset, offset + limit)
    .map(({ result }) => ({
      ...result,
      approvals: result.approvals || [],
      matchedRules: result.matchedRules || [],
      reasons: result.reasons || [],
      errors: result.errors || null,
      inputSummary: result.inputSummary || null,
    }));
  return rows;
}

async function getBatchResultCount(batchId) {
  const redis = await getRedisClient();
  return redis.hlen(keys(batchId).results);
}

module.exports = {
  getBatchTTLSeconds,
  getDefaultChunkSize,
  getDefaultChunkLeaseMs,
  getResultsMaxLimit,
  createBatchState,
  getBatchState,
  getBatchInput,
  getChunks,
  getChunk,
  getChunkProgress,
  claimChunk,
  claimNextChunk,
  releaseChunk,
  checkpointChunk,
  setBatchStatus,
  markBatchFailed,
  tryMarkBatchFailed,
  tryFinalizeBatch,
  deleteBatch,
  getBatchResults,
  getBatchResultCount,
};
