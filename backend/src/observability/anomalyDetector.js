/**
 * Anomaly Detector
 *
 * Identifies unusual routing patterns by comparing current department
 * distribution against expected baselines.
 *
 * The spec example:
 *   Normal: Mail 30%, Regular 60%, Heavy 10%
 *   Unexpected: Mail 0%, Regular 2%, Heavy 98%
 *
 * Design Decision: Simple threshold-based detection vs ML
 * - The spec says: "visibility, not building a sophisticated ML anomaly-detection system"
 * - We define expected ranges and flag when distribution falls outside them
 * - This is practical, explainable, and deployable
 *
 * Alert Conditions (when engineering should be notified):
 * 1. Any department at 0% when expected > 5%  → possible rule misconfiguration
 * 2. Any department deviating >25pp from baseline → unusual traffic pattern
 * 3. Failure rate exceeds 20% → possible upstream data quality issue
 * 4. Error count spikes (>5 in metrics window) → possible system issue
 */

const { getMetrics } = require('./metrics');

/**
 * Expected department distribution baselines.
 * These can be adjusted based on observed traffic patterns.
 * In production, these would come from configuration.
 */
const BASELINES = {
  Mail:    { expectedPct: 30, minPct: 5,  maxPct: 60 },
  Regular: { expectedPct: 50, minPct: 20, maxPct: 80 },
  Heavy:   { expectedPct: 20, minPct: 2,  maxPct: 50 },
};

// Minimum parcels before anomaly detection kicks in (avoid false positives on small samples)
const MIN_SAMPLE_SIZE = 50;

// Failure rate threshold
const MAX_FAILURE_RATE_PCT = 20;

// Error count threshold
const MAX_ERROR_COUNT = 5;

/**
 * Checks current metrics for anomalies.
 *
 * @returns {object} { healthy: boolean, alerts: Array<{ level, type, message, data }> }
 */
function checkForAnomalies() {
  const metrics = getMetrics();
  const alerts = [];

  const total = metrics.parcelsProcessed;

  // --- Check department distribution (only with enough data) ---
  if (total >= MIN_SAMPLE_SIZE) {
    for (const [dept, baseline] of Object.entries(BASELINES)) {
      const count = (metrics.routingOutcomes[dept] || 0);
      const pct = (count / total) * 100;

      // Alert: department at 0% when expected to have traffic
      if (count === 0 && baseline.expectedPct > 5) {
        alerts.push({
          level: 'critical',
          type: 'missing_department',
          message: `${dept} department has received 0 parcels out of ${total}. Expected ~${baseline.expectedPct}%.`,
          data: { department: dept, count, total, expectedPct: baseline.expectedPct },
        });
      }
      // Alert: department outside expected range
      else if (pct < baseline.minPct || pct > baseline.maxPct) {
        alerts.push({
          level: 'warning',
          type: 'distribution_anomaly',
          message: `${dept} department is at ${pct.toFixed(1)}% (expected ${baseline.minPct}%-${baseline.maxPct}%). This may indicate a rule change or unusual traffic.`,
          data: { department: dept, actualPct: pct, minPct: baseline.minPct, maxPct: baseline.maxPct },
        });
      }
    }
  }

  // --- Check failure rate ---
  if (total >= MIN_SAMPLE_SIZE) {
    const failureRate = (metrics.failedParcels / total) * 100;
    if (failureRate > MAX_FAILURE_RATE_PCT) {
      alerts.push({
        level: 'warning',
        type: 'high_failure_rate',
        message: `Failure rate is ${failureRate.toFixed(1)}% (${metrics.failedParcels}/${total}). Threshold: ${MAX_FAILURE_RATE_PCT}%. Check upstream data quality.`,
        data: { failureRate, failed: metrics.failedParcels, total, threshold: MAX_FAILURE_RATE_PCT },
      });
    }
  }

  // --- Check error count ---
  if (metrics.errors > MAX_ERROR_COUNT) {
    alerts.push({
      level: 'critical',
      type: 'error_spike',
      message: `${metrics.errors} unexpected errors recorded. Threshold: ${MAX_ERROR_COUNT}. Investigate application logs.`,
      data: { errors: metrics.errors, threshold: MAX_ERROR_COUNT },
    });
  }

  return {
    healthy: alerts.length === 0,
    alerts,
    checkedAt: new Date().toISOString(),
    sampleSize: total,
    minSampleSize: MIN_SAMPLE_SIZE,
  };
}

module.exports = {
  checkForAnomalies,
  BASELINES,
  MIN_SAMPLE_SIZE,
};
