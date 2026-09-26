/**
 * Default Routing Rules
 *
 * This file defines the business rules for parcel routing.
 * When business needs change, THIS is the file that gets modified.
 *
 * The routing engine (routingEngine.js) is generic and stable.
 * The rules here are specific and expected to evolve.
 *
 * RULE TYPES:
 *
 * 1. Department Rules (type: 'department')
 *    - Determine which department handles the parcel
 *    - Exactly ONE must match (first match by priority wins)
 *    - Priority: lower number = higher priority = evaluated first
 *
 * 2. Approval Rules (type: 'approval')
 *    - Determine what approvals are needed
 *    - ZERO or MORE can match (they accumulate)
 *    - Example: insurance, manual review, hazmat clearance
 *
 * HOW TO ADD A NEW RULE:
 *    1. Add a new object to the appropriate array below
 *    2. Give it a unique name (for logging/debugging)
 *    3. Define the condition function (takes a validated parcel)
 *    4. Define the reason function (takes a parcel, returns human-readable explanation)
 *    5. Add tests in tests/domain/routingEngine.test.js
 *    6. Run the full test suite to check for conflicts
 */

/**
 * Department routing rules.
 * Evaluated in priority order (lowest first). First match wins.
 *
 * IMPORTANT: These must cover the entire weight range without gaps.
 * The routing engine will throw an error if no department rule matches.
 */
const departmentRules = [
  {
    name: 'mail-department',
    department: 'Mail',
    priority: 1,
    condition: (parcel) => parcel.weight <= 1,
    reason: (parcel) =>
      `Parcel weight (${parcel.weight}kg) is 1kg or less.`,
  },
  {
    name: 'regular-department',
    department: 'Regular',
    priority: 2,
    condition: (parcel) => parcel.weight <= 10,
    reason: (parcel) =>
      `Parcel weight (${parcel.weight}kg) is between 1kg and 10kg.`,
  },
  {
    name: 'heavy-department',
    department: 'Heavy',
    priority: 3,
    condition: (parcel) => parcel.weight > 10,
    reason: (parcel) =>
      `Parcel weight (${parcel.weight}kg) is greater than 10kg.`,
  },
];

/**
 * Approval rules.
 * All matching rules apply (they accumulate).
 * A parcel can require zero, one, or multiple approvals.
 */
const approvalRules = [
  {
    name: 'insurance-required',
    type: 'Insurance',
    condition: (parcel) => parcel.value > 1000,
    reason: (parcel) =>
      `Parcel value (€${parcel.value}) exceeds €1,000.`,
  },
];

module.exports = {
  departmentRules,
  approvalRules,
};
