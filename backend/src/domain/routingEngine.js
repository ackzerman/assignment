/**
 * Parcel Routing Engine
 *
 * This is the CORE of the application. It evaluates routing rules against
 * a validated parcel and produces an explainable routing result.
 *
 * Design Decisions:
 *
 * 1. PURE FUNCTION — routeParcel takes a parcel and rules, returns a result.
 *    No side effects, no HTTP, no database. Easy to test and debug.
 *
 * 2. RULES ARE INJECTED — The engine doesn't import rules directly.
 *    This makes it easy to test with custom rules and swap rule sets.
 *    The default rules are applied via a convenience function.
 *
 * 3. EXPLAINABLE RESULTS — Every routing decision includes:
 *    - What department was assigned
 *    - Why (which rule matched and what the reason is)
 *    - What approvals are required
 *    - Why each approval was triggered
 *
 * 4. FAIL-SAFE — If no department rule matches, that's a bug in the rules.
 *    The engine throws an error rather than silently misrouting a parcel.
 */

const { departmentRules: defaultDepartmentRules, approvalRules: defaultApprovalRules } = require('./rules');

/**
 * Routes a validated parcel according to the given rules.
 *
 * @param {object} parcel - A validated parcel (from validateParcelInput)
 * @param {object} [options] - Optional overrides for rules
 * @param {Array} [options.departmentRules] - Custom department rules
 * @param {Array} [options.approvalRules] - Custom approval rules
 * @returns {object} Routing result with department, reason, approvals, etc.
 * @throws {Error} If no department rule matches (indicates a gap in rules)
 */
function routeParcel(parcel, options = {}) {
  const deptRules = options.departmentRules || defaultDepartmentRules;
  const apprRules = options.approvalRules || defaultApprovalRules;

  // --- Department routing (first match wins) ---
  const department = findDepartment(parcel, deptRules);

  // --- Approval checks (all matches accumulate) ---
  const approvals = findApprovals(parcel, apprRules);

  // --- Build the routing result ---
  // Master-prompt explainability contract: matchedRules (stable IDs) + reasons.
  // Legacy fields (departmentRule, departmentReason, approvals objects) are kept
  // for backward compatibility with existing tests/frontend.
  const matchedRules = [
    department.id || department.rule,
    ...approvals.map((a) => a.id || a.rule),
  ];
  const reasons = [department.reason, ...approvals.map((a) => a.reason)];
  return {
    department: department.department,
    departmentReason: department.reason,
    departmentRule: department.rule,
    requiresApproval: approvals.length > 0,
    approvals,
    matchedRules,
    reasons,
    parcel,
    routedAt: new Date().toISOString(),
  };
}

/**
 * Finds the matching department by evaluating rules in priority order.
 *
 * @param {object} parcel - Validated parcel
 * @param {Array} rules - Department rules sorted by priority
 * @returns {{ department: string, reason: string, rule: string }}
 * @throws {Error} If no rule matches
 */
function findDepartment(parcel, rules) {
  // Sort by priority (lowest number = highest priority = evaluated first)
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

  for (const rule of sorted) {
    if (rule.condition(parcel)) {
      return {
        department: rule.department,
        reason: rule.reason(parcel),
        rule: rule.name,
        id: rule.id || rule.name,
      };
    }
  }

  // This should never happen if rules are properly configured.
  // If it does, it's a bug in the rules — not in the parcel data.
  throw new Error(
    `No department rule matched for parcel: weight=${parcel.weight}kg, ` +
    `value=€${parcel.value}, country=${parcel.destinationCountry}. ` +
    `This indicates a gap in the routing rules configuration.`
  );
}

/**
 * Finds all matching approval requirements.
 *
 * @param {object} parcel - Validated parcel
 * @param {Array} rules - Approval rules
 * @returns {Array<{ type: string, reason: string, rule: string }>}
 */
function findApprovals(parcel, rules) {
  const approvals = [];

  for (const rule of rules) {
    if (rule.condition(parcel)) {
      approvals.push({
        type: rule.type,
        reason: rule.reason(parcel),
        rule: rule.name,
        id: rule.id || rule.name,
      });
    }
  }

  return approvals;
}

module.exports = {
  routeParcel,
  findDepartment,
  findApprovals,
};
