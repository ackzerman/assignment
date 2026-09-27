/**
 * Anomaly detector semantics:
 * - error "spike" uses a ROLLING window (ERROR_WINDOW_MS), not the cumulative
 *   process-lifetime count: old errors outside the window must not alert.
 * - department distribution uses SUCCESSFULLY ROUTED parcels as denominator,
 *   not all attempts (failures carry no department).
 * - failure rate still uses all attempts as denominator.
 */

const {
  recordRouting,
  recordFailure,
  recordError,
  resetMetrics,
} = require('../../src/observability/metrics');
const {
  checkForAnomalies,
  MIN_SAMPLE_SIZE,
  ERROR_WINDOW_MS,
} = require('../../src/observability/anomalyDetector');

const BASE = 1_700_000_000_000;

function routeMany(dept, n) {
  for (let i = 0; i < n; i++) recordRouting(dept, []);
}

function failMany(n) {
  for (let i = 0; i < n; i++) recordFailure();
}

function errorMany(n) {
  for (let i = 0; i < n; i++) recordError();
}

describe('Anomaly detector', () => {
  let nowSpy;

  beforeEach(() => {
    resetMetrics();
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(BASE);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('ignores old errors outside the rolling window (no spike alert)', () => {
    errorMany(6); // 6 errors, but "long ago"
    nowSpy.mockReturnValue(BASE + ERROR_WINDOW_MS + 60_000);
    const result = checkForAnomalies();
    expect(result.alerts.some((a) => a.type === 'error_spike')).toBe(false);
  });

  it('alerts on repeated errors clustered inside the window', () => {
    errorMany(6);
    const result = checkForAnomalies();
    const spike = result.alerts.find((a) => a.type === 'error_spike');
    expect(spike).toBeDefined();
    expect(spike.level).toBe('critical');
    expect(spike.message).toMatch(/last 15 minutes/);
  });

  it('uses routed parcels (not all attempts) as distribution denominator', () => {
    // Routed mix: Mail 6%, Regular 80%, Heavy 14% — all inside baselines.
    // Against an all-attempts denominator (100 attempts incl. 50 failures),
    // Mail would read 3% < 5% min and falsely alert; failures carry no
    // department and must not dilute the mix.
    routeMany('Mail', 3);
    routeMany('Regular', 40);
    routeMany('Heavy', 7);
    failMany(50);

    const result = checkForAnomalies();
    expect(
      result.alerts.some((a) => a.type === 'distribution_anomaly' || a.type === 'missing_department'),
    ).toBe(false);
  });

  it('still flags a genuinely skewed routed distribution', () => {
    routeMany('Heavy', MIN_SAMPLE_SIZE);
    const result = checkForAnomalies();
    expect(
      result.alerts.some((a) => a.type === 'distribution_anomaly' && a.data.department === 'Heavy'),
    ).toBe(true);
  });

  it('keeps failure rate on the all-attempts denominator', () => {
    routeMany('Regular', 40);
    failMany(60); // 60% failure rate over 100 attempts
    const result = checkForAnomalies();
    const fr = result.alerts.find((a) => a.type === 'high_failure_rate');
    expect(fr).toBeDefined();
    expect(fr.data.failed).toBe(60);
    expect(fr.data.total).toBe(100);
  });
});
