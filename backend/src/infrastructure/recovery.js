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
const { positiveIntOrDefault } = require('../config');

// Batches newer than this are left alone: their enqueue may still be in
// flight from a concurrent creator.
const DEFAULT_RECOVERY_GRACE_MS = 60 * 1000;

// How often the periodic reconciliation re-runs (see startPeriodicRecovery).
// Hourly grace-scale: orphaned batches become eligible 60s after creation,
// so a 60s interval guarantees eventual recovery within ~2 minutes.
const DEFAULT_RECOVERY_INTERVAL_MS = 60 * 1000;

function getRecoveryGraceMs() {
  return positiveIntOrDefault(process.env.RECOVERY_GRACE_MS, DEFAULT_RECOVERY_GRACE_MS);
}

function getRecoveryIntervalMs() {
  return positiveIntOrDefault(process.env.RECOVERY_INTERVAL_MS, DEFAULT_RECOVERY_INTERVAL_MS);
}

async function recoverOrphanedBatches(options = {}) {
  const {
    graceMs = getRecoveryGraceMs(),
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
  startPeriodicRecovery,
  stopPeriodicRecovery,
  getRecoveryGraceMs,
  getRecoveryIntervalMs,
  DEFAULT_RECOVERY_GRACE_MS,
  DEFAULT_RECOVERY_INTERVAL_MS,
};

/**
 * Starts periodic orphan reconciliation: re-runs recoverOrphanedBatches on
 * an interval so batches that were still inside the grace period at startup
 * (e.g. crash 20s before restart with a 60s grace) are eventually recovered
 * once they age out — instead of lingering QUEUED until TTL expiry.
 *
 * Safety is identical to the startup pass: only old QUEUED batches with no
 * queue job are re-enqueued; terminal batches are never touched; duplicate
 * execution is absorbed by idempotent checkpoints/HSETNX results.
 *
 * @param {object} [options]
 * @param {number} [options.intervalMs] - Reconciliation period
 * @param {number} [options.graceMs] - Minimum batch age to recover
 * @param {object} [options.deps] - Injected { batchStore, queueModule, log }
 * @returns {{ stop: Function }} Handle to stop the interval
 */
function startPeriodicRecovery(options = {}) {
  const {
    intervalMs = getRecoveryIntervalMs(),
    graceMs = getRecoveryGraceMs(),
    deps = {},
  } = options;

  const timer = setInterval(() => {
    recoverOrphanedBatches({ graceMs, ...deps }).catch((err) => {
      logger.warn('Periodic orphan recovery failed', { error: err.message });
    });
  }, intervalMs);

  // Don't keep the process alive for reconciliation alone.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * Stops a periodic recovery handle created by startPeriodicRecovery.
 */
function stopPeriodicRecovery(handle) {
  if (handle && typeof handle.stop === 'function') handle.stop();
}
