/**
 * Observability metrics tests (Master: metrics answer health questions).
 */

const {
  recordRouting,
  recordFailure,
  recordBatch,
  recordTerminalBatch,
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
    // Job-execution duration is tracked separately from terminal batch time.
    expect(m.avgJobExecutionMs).toBe(2000);
    expect(m.terminalBatchesCompleted).toBe(0);
    expect(m.avgTerminalBatchDurationMs).toBe(0);
    expect(m.avgBatchDurationMs).toBe(0);
  });

  it('terminal batch completions are counted exactly once with wall time', () => {
    recordTerminalBatch(500);
    recordTerminalBatch(1500);
    const m = getMetrics();
    expect(m.terminalBatchesCompleted).toBe(2);
    expect(m.avgTerminalBatchDurationMs).toBe(1000);
    // avgBatchDurationMs stays the terminal-batch average (compat alias).
    expect(m.avgBatchDurationMs).toBe(1000);
  });

  it('retries do not fake terminal measurements (job vs batch separated)', () => {
    recordJobCompleted(100);
    recordJobCompleted(200);
    const m = getMetrics();
    expect(m.jobsProcessed).toBe(2);
    expect(m.avgJobExecutionMs).toBe(150);
    expect(m.terminalBatchesCompleted).toBe(0);
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
