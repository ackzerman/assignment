/**
 * Observability metrics tests (Master: metrics answer health questions).
 */

const {
  recordRouting,
  recordFailure,
  recordBatch,
  recordHttpRequest,
  recordJobCompleted,
  recordJobFailed,
  recordJobRetry,
  setQueueDepth,
  setWorkerActiveJobs,
  getMetrics,
  resetMetrics,
} = require('../../src/observability/metrics');

describe('Strict observability metrics', () => {
  beforeEach(() => resetMetrics());

  it('tracks HTTP count, errors, and latency', () => {
    recordHttpRequest(200, 50);
    recordHttpRequest(500, 150);
    const m = getMetrics();
    expect(m.httpRequests).toBe(2);
    expect(m.httpErrors).toBe(1);
    expect(m.avgHttpLatencyMs).toBe(100);
    expect(m.httpErrorRate).toBe(50);
  });

  it('tracks routing, batches, and worker jobs', () => {
    recordRouting('Regular', [{ type: 'Insurance' }]);
    recordFailure();
    recordBatch({ failed: 1 });
    recordJobCompleted(2000);
    recordJobFailed();
    recordJobRetry();
    setQueueDepth(7);
    setWorkerActiveJobs(1);

    const m = getMetrics();
    expect(m.parcelsProcessed).toBe(2);
    expect(m.batchesProcessed).toBe(1);
    expect(m.jobsProcessed).toBe(1);
    expect(m.jobsFailed).toBe(1);
    expect(m.jobsRetried).toBe(1);
    expect(m.queueDepth).toBe(7);
    expect(m.workerActiveJobs).toBe(1);
    expect(m.avgBatchDurationMs).toBe(2000);
  });

  it('exposes retry/backpressure-relevant defaults', () => {
    const m = getMetrics();
    expect(m).toHaveProperty('queueDepth');
    expect(m).toHaveProperty('jobsProcessed');
    expect(m).toHaveProperty('jobsFailed');
    expect(m).toHaveProperty('jobsRetried');
    expect(m).toHaveProperty('httpRequests');
  });
});
