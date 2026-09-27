/**
 * Startup orphan recovery.
 *
 * Failure model: batch creation is (1) create Redis state, then (2) enqueue
 * the BullMQ job. If the process crashes between those two steps, the batch
 * stays QUEUED forever with no job to process it (it would only disappear
 * silently at TTL expiry).
 *
 * Recovery: at startup, find QUEUED batches with no corresponding queue job
 * and re-enqueue them. This is safe because:
 * - Job IDs are deterministic (`batch-{batchId}`), so "no job" is checkable.
 * - Only QUEUED batches qualify — a batch already PROCESSING/COMPLETED/
 *   FAILED is owned by (or finished in) another execution and is untouched.
 * - A grace period skips freshly-created batches whose enqueue may still be
 *   in flight (single-instance deployments aside, never touch new work).
 * - Reprocessing is idempotent anyway (chunk checkpoints + HSETNX results).
 *
 * At-least-once reminder: recovery may re-enqueue work that eventually
 * executes twice (e.g. crash after enqueue but before the job runs is NOT
 * the case here — but a concurrent creator could still race). Duplicate
 * execution is always safe; duplicate RESULTS are impossible (HSETNX).
 */

const { logger } = require('../observability/logger');

// Batches newer than this are left alone: their enqueue may still be in
// flight from a concurrent creator.
const DEFAULT_RECOVERY_GRACE_MS = 60 * 1000;

async function recoverOrphanedBatches(options = {}) {
  const {
    graceMs = DEFAULT_RECOVERY_GRACE_MS,
    now = Date.now(),
    batchStore = require('./batchStore'),
    queueModule = require('./queue'),
    log = logger,
  } = options;

  const summary = { checked: 0, recovered: 0, skipped: 0 };

  let batchIds;
  try {
    batchIds = await batchStore.listBatchIds();
  } catch (err) {
    log.warn('Orphan recovery skipped: batch listing unavailable', { error: err.message });
    return summary;
  }

  for (const batchId of batchIds) {
    summary.checked++;
    try {
      const state = await batchStore.getBatchState(batchId);
      if (!state || state.status !== 'QUEUED') {
        summary.skipped++;
        continue;
      }

      const createdAt = state.createdAt ? Date.parse(state.createdAt) : NaN;
      if (!Number.isFinite(createdAt) || now - createdAt < graceMs) {
        // Too new (enqueue may be in flight) or undatable: leave alone.
        summary.skipped++;
        continue;
      }

      const existingJob = await queueModule.getBatchJob(batchId);
      if (existingJob) {
        summary.skipped++;
        continue;
      }

      await queueModule.addBatchJob(batchId);
      summary.recovered++;
      log.info('Recovered orphaned batch: re-enqueued with no prior job', { batchId });
    } catch (err) {
      // One bad batch must never abort the whole recovery pass.
      summary.skipped++;
      log.warn('Orphan recovery failed for batch', { batchId, error: err.message });
    }
  }

  if (summary.recovered > 0 || summary.checked > 0) {
    log.info('Orphan batch recovery complete', summary);
  }
  return summary;
}

module.exports = {
  recoverOrphanedBatches,
  DEFAULT_RECOVERY_GRACE_MS,
};
