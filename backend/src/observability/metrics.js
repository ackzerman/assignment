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
 * - errors: count of unexpected errors
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
  // Master Phase 9/12 strict observability
  httpRequests: 0,
  httpErrors: 0,           // responses with status >= 400
  httpLatencyMsTotal: 0,
  httpLatencyCount: 0,
  jobsProcessed: 0,        // worker jobs completed
  jobsFailed: 0,           // worker jobs failed (after all retries)
  jobsRetried: 0,          // worker job attempts that will be retried
  queueDepth: 0,           // last observed waiting+active+delayed
  workerActiveJobs: 0,     // currently executing jobs
  batchProcessingDurationMsTotal: 0,
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
 * Records an unexpected error.
 */
function recordError() {
  metrics.errors++;
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
 * Records a worker job completion.
 *
 * @param {number} durationMs - Job processing duration
 */
function recordJobCompleted(durationMs) {
  metrics.jobsProcessed++;
  if (typeof durationMs === 'number') {
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

  // Compute department distribution percentages
  const distribution = {};
  for (const [dept, count] of Object.entries(outcomes)) {
    distribution[dept] = {
      count,
      percentage: total > 0 ? ((count / total) * 100).toFixed(1) + '%' : '0%',
    };
  }

  return {
    ...metrics,
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
    avgBatchDurationMs: metrics.jobsProcessed > 0
      ? Number((metrics.batchProcessingDurationMsTotal / metrics.jobsProcessed).toFixed(2))
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
  metrics.batchProcessingDurationMsTotal = 0;
  metrics.startedAt = new Date().toISOString();
}

module.exports = {
  recordRouting,
  recordFailure,
  recordBatch,
  recordProcessingTime,
  recordError,
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
