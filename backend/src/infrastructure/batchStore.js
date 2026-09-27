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
 * Two layers, same as before but Redis-backed:
 * - Chunk checkpoints = recovery optimization (skip DONE chunks on retry).
 * - Parcel-level idempotency = correctness safeguard: results are written
 *   with HSETNX inside the checkpoint transaction, so a retried chunk can
 *   never create duplicate authoritative results.
 *
 * Progress is DERIVED from checkpoint state (DONE chunk fields + results
 * hash size), never incremented per encounter — a retried chunk therefore
 * cannot double-count progress.
 *
 * Atomicity without Lua: chunk claiming uses SET key NX PX (single atomic
 * command — only one worker can hold a chunk's lock). Checkpointing uses
 * MULTI/EXEC so results + DONE + TTL refresh commit as one logical unit.
 */

const { getRedisClient } = require('./redis');
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
 * Atomically claims a chunk: SET lock NX PX is a single atomic command, so
 * exactly one worker wins. A DONE chunk is never claimed (lock released if
 * taken). A stale lock (holder crashed, key expired via PX) is reclaimable
 * by any worker retrying SET NX.
 *
 * @returns the claimed chunk { chunkIndex, status: 'PROCESSING', ... } or null
 */
async function claimChunk(batchId, chunkIndex, workerId, leaseMs = getDefaultChunkLeaseMs()) {
  const redis = await getRedisClient();
  const k = keys(batchId);

  const current = await redis.hget(k.chunks, chunkIndex);
  if (current === undefined || current === null) return null;
  if (current.startsWith('DONE')) return null;

  const acquired = await redis.set(k.lock(chunkIndex), workerId, 'PX', leaseMs, 'NX');
  if (acquired !== 'OK') return null;

  // Re-check after winning the lock: the chunk may have completed concurrently.
  const rechecked = await redis.hget(k.chunks, chunkIndex);
  if (rechecked !== undefined && rechecked !== null && rechecked.startsWith('DONE')) {
    await redis.del(k.lock(chunkIndex));
    return null;
  }

  const leaseExpiresAt = Date.now() + leaseMs;
  const multi = redis.multi();
  multi.hset(k.chunks, chunkIndex, `PROCESSING:${workerId}:${leaseExpiresAt}`);
  multi.expire(k.meta, getBatchTTLSeconds());
  multi.expire(k.chunks, getBatchTTLSeconds());
  multi.expire(k.results, getBatchTTLSeconds());
  await multi.exec();

  return getChunk(batchId, chunkIndex);
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
 * Releases our own PROCESSING claim back to PENDING so a retry reclaims it
 * immediately instead of waiting for lock expiry. Never touches DONE chunks
 * or claims owned by another live worker (a live holder always owns the lock
 * key; an expired/missing lock with our field means nobody holds it).
 */
async function releaseChunk(batchId, chunkIndex, workerId) {
  const redis = await getRedisClient();
  const k = keys(batchId);
  const [field, lockOwner] = await Promise.all([
    redis.hget(k.chunks, chunkIndex),
    redis.get(k.lock(chunkIndex)),
  ]);
  if (!field || !field.startsWith(`PROCESSING:${workerId}:`)) {
    return false;
  }
  if (lockOwner !== null && lockOwner !== undefined && lockOwner !== workerId) {
    return false;
  }
  const multi = redis.multi();
  multi.hset(k.chunks, chunkIndex, 'PENDING');
  multi.del(k.lock(chunkIndex));
  const res = await multi.exec();
  return !!res;
}

/**
 * Checkpoint: stores the chunk's results (HSETNX per parcel = parcel-level
 * idempotency: retries can never duplicate authoritative results), marks the
 * chunk DONE with its outcome, and refreshes TTLs — as ONE MULTI/EXEC unit.
 * A chunk is therefore never reported DONE before its results are stored.
 */
async function checkpointChunk(batchId, chunkIndex, results, successful, failed) {
  const redis = await getRedisClient();
  const k = keys(batchId);
  const ttl = getBatchTTLSeconds();

  const args = [];
  for (const r of results) {
    args.push(r.index, JSON.stringify(serializeResult(r)));
  }

  const multi = redis.multi();
  if (args.length > 0) {
    // HSETNX each parcel result: 1 = newly stored, 0 = already present.
    for (let i = 0; i < args.length; i += 2) {
      multi.hsetnx(k.results, args[i], args[i + 1]);
    }
  }
  multi.hset(k.chunks, chunkIndex, `DONE:${successful}:${failed}`);
  multi.del(k.lock(chunkIndex));
  multi.expire(k.meta, ttl);
  multi.expire(k.chunks, ttl);
  multi.expire(k.results, ttl);
  multi.expire(k.input, ttl);
  const replies = await multi.exec();

  let inserted = 0;
  let duplicates = 0;
  const hsetnxReplies = replies.slice(0, args.length / 2);
  for (const [err, value] of hsetnxReplies) {
    if (!err && value === 1) inserted++;
    else duplicates++;
  }
  return { inserted, duplicates };
}

function serializeResult(r) {
  return {
    parcelId: r.parcelId,
    index: r.index,
    status: r.status,
    department: r.department || null,
    approvals: r.approvals || [],
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
  deleteBatch,
  getBatchResults,
  getBatchResultCount,
};
