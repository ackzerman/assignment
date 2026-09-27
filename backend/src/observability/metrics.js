/**
 * Application Metrics Collector
 *
 * Tracks operational metrics in-memory for this assessment.
 * In production, these would feed into Prometheus, Datadog, or CloudWatch.
 *
 * Metrics tracked:
 * - parcelsProcessed: total parcels validated and routed
 * - routingOutcomes: count per department (Mail, Regular, Heavy)
 * - failedParcels: count of validation failures
 * - batchesProcessed: total batch operations
 * - batchFailures: batches that had any failures
 * - totalProcessingTimeMs: cumulative processing time
 * - approvalCounts: count per approval type (Insurance, Manual Review)
 * - errors: count of unexpected errors (cumulative process total)
 * - errorTimestamps: when each unexpected error occurred (bounded rolling
 *   window source — see countRecentErrors)
 * - jobsProcessed / jobExecutionDurationMsTotal: BullMQ EXECUTION completions
 *   (one execution can finish while other workers still own chunks — this is
 *   NOT full batch duration)
 * - terminalBatchesCompleted / terminalBatchDurationMsTotal: batches that
 *   actually transitioned into a terminal COMPLETED state, and their full
 *   start→terminal wall time (recorded exactly once, by the transition
 *   winner only; retries never re-record)
 *
 * Design Decision: In-memory counters vs Prometheus client library
 * - In-memory is zero-dependency and sufficient for the assessment
 * - The metrics shape matches what Prometheus would expose
 * - A GET /api/metrics endpoint lets us inspect them
 */

const metrics = {
  parcelsProcessed: 0,
  routingOutcomes: {},     // { Mail: 150, Regular: 340, Heavy: 50 }
  failedParcels: 0,
  batchesProcessed: 0,
  batchFailures: 0,
  totalProcessingTimeMs: 0,
  approvalCounts: {},      // { Insurance: 45, 'Manual Review': 12 }
  errors: 0,
  errorTimestamps: [],     // epoch ms of each unexpected error (capped)
  // Master Phase 9/12 strict observability
  httpRequests: 0,
  httpErrors: 0,           // responses with status >= 400
  httpLatencyMsTotal: 0,
  httpLatencyCount: 0,
  jobsProcessed: 0,        // worker job executions completed
  jobsFailed: 0,           // worker jobs failed (after all retries)
  jobsRetried: 0,          // worker job attempts that will be retried
  queueDepth: 0,           // last observed waiting+active+delayed
  workerActiveJobs: 0,     // currently executing jobs
  jobExecutionDurationMsTotal: 0, // cumulative BullMQ execution wall time
  terminalBatchesCompleted: 0,    // batches reaching terminal COMPLETED state
  terminalBatchDurationMsTotal: 0, // cumulative start→terminal wall time
  batchProcessingDurationMsTotal: 0, // legacy alias of terminal total (compat)
  startedAt: new Date().toISOString(),
};

/**
 * Records a successful routing outcome.
 */
function recordRouting(department, approvals = []) {
  metrics.parcelsProcessed++;
  metrics.routingOutcomes[department] = (metrics.routingOutcomes[department] || 0) + 1;

  for (const approval of approvals) {
    metrics.approvalCounts[approval.type] = (metrics.approvalCounts[approval.type] || 0) + 1;
  }
}

/**
 * Records a failed parcel (validation failure).
 */
function recordFailure() {
  metrics.parcelsProcessed++;
  metrics.failedParcels++;
}

/**
 * Records a batch processing operation.
 */
function recordBatch(summary) {
  metrics.batchesProcessed++;
  if (summary.failed > 0) {
    metrics.batchFailures++;
  }
}

/**
 * Records processing time for an operation.
 */
function recordProcessingTime(ms) {
  metrics.totalProcessingTimeMs += ms;
}

/**
 * Records an unexpected error (cumulative counter + rolling-window timestamp).
 */
function recordError() {
  metrics.errors++;
  metrics.errorTimestamps.push(Date.now());
  // Bound memory: only recent history matters for spike detection.
  if (metrics.errorTimestamps.length > 500) {
    metrics.errorTimestamps.splice(0, metrics.errorTimestamps.length - 500);
  }
}

/**
 * Counts unexpected errors within the trailing window (rolling, not cumulative).
 */
function countRecentErrors(windowMs) {
  const cutoff = Date.now() - windowMs;
  return metrics.errorTimestamps.filter((t) => t >= cutoff).length;
}

/**
 * Records an HTTP request completion (Master: request count, error count, latency).
 *
 * @param {number} statusCode - Response status code
 * @param {number} durationMs - Request duration in milliseconds
 */
function recordHttpRequest(statusCode, durationMs) {
  metrics.httpRequests++;
  metrics.httpLatencyMsTotal += durationMs;
  metrics.httpLatencyCount++;
  if (statusCode >= 400) {
    metrics.httpErrors++;
  }
}

/**
 * Records a worker job EXECUTION completion (one BullMQ execution finished).
 * This is execution wall time — NOT full batch duration (other workers may
 * still own chunks). Full batch duration uses recordTerminalBatch.
 *
 * @param {number} durationMs - Job execution duration
 */
function recordJobCompleted(durationMs) {
  metrics.jobsProcessed++;
  if (typeof durationMs === 'number') {
    metrics.jobExecutionDurationMsTotal += durationMs;
  }
}

/**
 * Records a TERMINAL batch completion (the batch actually transitioned into
 * COMPLETED / COMPLETED_WITH_ERRORS). Call ONLY from the atomic transition
 * winner: retries and concurrent workers must never call this, so each
 * batch is counted exactly once. Duration is optional — the completion is
 * always counted; wall time accumulates only when measurable.
 *
 * @param {number} [durationMs] - Start→terminal wall time
 */
function recordTerminalBatch(durationMs) {
  metrics.terminalBatchesCompleted++;
  if (typeof durationMs === 'number') {
    metrics.terminalBatchDurationMsTotal += durationMs;
    metrics.batchProcessingDurationMsTotal += durationMs;
  }
}

/**
 * Records a worker job failure (terminal, after retries exhausted).
 */
function recordJobFailed() {
  metrics.jobsFailed++;
}

/**
 * Records a worker job attempt that will be retried.
 */
function recordJobRetry() {
  metrics.jobsRetried++;
}

/**
 * Sets the last observed queue depth (waiting + active + delayed).
 *
 * @param {number} depth
 */
function setQueueDepth(depth) {
  metrics.queueDepth = depth;
}

/**
 * Increments the active worker job count (concurrency-safe: Node.js runs
 * job processors on a single thread, so += 1 is atomic here).
 */
function workerJobStarted() {
  metrics.workerActiveJobs++;
}

/**
 * Decrements the active worker job count (floored at 0).
 */
function workerJobFinished() {
  metrics.workerActiveJobs = Math.max(0, metrics.workerActiveJobs - 1);
}

/**
 * Sets the current number of active worker jobs (worker utilization).
 *
 * @param {number} count
 */
function setWorkerActiveJobs(count) {
  metrics.workerActiveJobs = count;
}

/**
 * Returns a snapshot of all metrics including computed values.
 */
function getMetrics() {
  const total = metrics.parcelsProcessed;
  const outcomes = metrics.routingOutcomes;
  // Department distribution is over SUCCESSFULLY ROUTED parcels only —
  // validation failures have no department and must not dilute the mix.
  const routedTotal = Object.values(outcomes).reduce((sum, n) => sum + n, 0);

  // Compute department distribution percentages
  const distribution = {};
  for (const [dept, count] of Object.entries(outcomes)) {
    distribution[dept] = {
      count,
      percentage: routedTotal > 0 ? ((count / routedTotal) * 100).toFixed(1) + '%' : '0%',
    };
  }

  return {
    ...metrics,
    routedTotal,
    distribution,
    uptime: getUptime(),
    avgProcessingTimeMs: total > 0
      ? (metrics.totalProcessingTimeMs / total).toFixed(2)
      : 0,
    avgHttpLatencyMs: metrics.httpLatencyCount > 0
      ? Number((metrics.httpLatencyMsTotal / metrics.httpLatencyCount).toFixed(2))
      : 0,
    httpErrorRate: metrics.httpRequests > 0
      ? Number(((metrics.httpErrors / metrics.httpRequests) * 100).toFixed(2))
      : 0,
    avgBatchDurationMs: metrics.terminalBatchesCompleted > 0
      ? Number((metrics.terminalBatchDurationMsTotal / metrics.terminalBatchesCompleted).toFixed(2))
      : 0,
    avgJobExecutionMs: metrics.jobsProcessed > 0
      ? Number((metrics.jobExecutionDurationMsTotal / metrics.jobsProcessed).toFixed(2))
      : 0,
    avgTerminalBatchDurationMs: metrics.terminalBatchesCompleted > 0
      ? Number((metrics.terminalBatchDurationMsTotal / metrics.terminalBatchesCompleted).toFixed(2))
      : 0,
  };
}

/**
 * Returns formatted uptime string.
 */
function getUptime() {
  const startMs = new Date(metrics.startedAt).getTime();
  const elapsedMs = Date.now() - startMs;
  const seconds = Math.floor(elapsedMs / 1000) % 60;
  const minutes = Math.floor(elapsedMs / 60000) % 60;
  const hours = Math.floor(elapsedMs / 3600000);
  return `${hours}h ${minutes}m ${seconds}s`;
}

/**
 * Resets all metrics (useful for testing).
 */
function resetMetrics() {
  metrics.parcelsProcessed = 0;
  metrics.routingOutcomes = {};
  metrics.failedParcels = 0;
  metrics.batchesProcessed = 0;
  metrics.batchFailures = 0;
  metrics.totalProcessingTimeMs = 0;
  metrics.approvalCounts = {};
  metrics.errors = 0;
  metrics.httpRequests = 0;
  metrics.httpErrors = 0;
  metrics.httpLatencyMsTotal = 0;
  metrics.httpLatencyCount = 0;
  metrics.jobsProcessed = 0;
  metrics.jobsFailed = 0;
  metrics.jobsRetried = 0;
  metrics.queueDepth = 0;
  metrics.workerActiveJobs = 0;
  metrics.jobExecutionDurationMsTotal = 0;
  metrics.terminalBatchesCompleted = 0;
  metrics.terminalBatchDurationMsTotal = 0;
  metrics.batchProcessingDurationMsTotal = 0;
  metrics.errorTimestamps = [];
  metrics.startedAt = new Date().toISOString();
}

module.exports = {
  recordRouting,
  recordFailure,
  recordBatch,
  recordTerminalBatch,
  recordProcessingTime,
  recordError,
  countRecentErrors,
  recordHttpRequest,
  recordJobCompleted,
  recordJobFailed,
  recordJobRetry,
  workerJobStarted,
  workerJobFinished,
  setQueueDepth,
  setWorkerActiveJobs,
  getMetrics,
  resetMetrics,
};
