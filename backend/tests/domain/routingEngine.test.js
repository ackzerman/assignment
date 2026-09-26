/**
 * Routing Engine Tests
 *
 * Tests the core routing logic directly — no HTTP, no Express.
 *
 * Organized by:
 * 1. Normal cases (clearly within each range)
 * 2. Boundary cases (exactly at the threshold — Rule 6)
 * 3. Combined cases (weight + value interactions)
 * 4. Approval rules
 * 5. Result structure (explainability)
 * 6. Edge cases / error handling
 */

const { routeParcel } = require('../../src/domain/routingEngine');

// Helper: create a valid parcel object
function makeParcel(overrides = {}) {
  return {
    weight: 5,
    value: 100,
    destinationCountry: 'DE',
    additionalAttributes: {},
    ...overrides,
  };
}

describe('Routing Engine', () => {
  // ===========================================================
  // DEPARTMENT ROUTING — NORMAL CASES
  // ===========================================================
  describe('Department Routing — Normal Cases', () => {
    it('should route 0.5kg parcel to Mail', () => {
      const result = routeParcel(makeParcel({ weight: 0.5 }));
      expect(result.department).toBe('Mail');
    });

    it('should route 5kg parcel to Regular', () => {
      const result = routeParcel(makeParcel({ weight: 5 }));
      expect(result.department).toBe('Regular');
    });

    it('should route 15kg parcel to Heavy', () => {
      const result = routeParcel(makeParcel({ weight: 15 }));
      expect(result.department).toBe('Heavy');
    });

    it('should route 100kg parcel to Heavy', () => {
      const result = routeParcel(makeParcel({ weight: 100 }));
      expect(result.department).toBe('Heavy');
    });

    it('should route very light parcel (0.01kg) to Mail', () => {
      const result = routeParcel(makeParcel({ weight: 0.01 }));
      expect(result.department).toBe('Mail');
    });
  });

  // ===========================================================
  // DEPARTMENT ROUTING — BOUNDARY CASES (Rule 6)
  // ===========================================================
  describe('Department Routing — Boundary Cases', () => {
    // Mail/Regular boundary: weight <= 1kg → Mail, weight > 1kg → Regular
    it('should route exactly 1kg to Mail (boundary: <=1)', () => {
      const result = routeParcel(makeParcel({ weight: 1 }));
      expect(result.department).toBe('Mail');
    });

    it('should route 1.001kg to Regular (just above Mail boundary)', () => {
      const result = routeParcel(makeParcel({ weight: 1.001 }));
      expect(result.department).toBe('Regular');
    });

    it('should route 0.999kg to Mail (just below Mail boundary)', () => {
      const result = routeParcel(makeParcel({ weight: 0.999 }));
      expect(result.department).toBe('Mail');
    });

    // Regular/Heavy boundary: weight <= 10kg → Regular, weight > 10kg → Heavy
    it('should route exactly 10kg to Regular (boundary: <=10)', () => {
      const result = routeParcel(makeParcel({ weight: 10 }));
      expect(result.department).toBe('Regular');
    });

    it('should route 10.001kg to Heavy (just above Regular boundary)', () => {
      const result = routeParcel(makeParcel({ weight: 10.001 }));
      expect(result.department).toBe('Heavy');
    });

    it('should route 9.999kg to Regular (just below Regular boundary)', () => {
      const result = routeParcel(makeParcel({ weight: 9.999 }));
      expect(result.department).toBe('Regular');
    });
  });

  // ===========================================================
  // INSURANCE APPROVAL — NORMAL CASES
  // ===========================================================
  describe('Insurance Approval — Normal Cases', () => {
    it('should NOT require insurance for €100 parcel', () => {
      const result = routeParcel(makeParcel({ value: 100 }));
      expect(result.requiresApproval).toBe(false);
      expect(result.approvals).toHaveLength(0);
    });

    it('should require insurance for €2000 parcel', () => {
      const result = routeParcel(makeParcel({ value: 2000 }));
      expect(result.requiresApproval).toBe(true);
      expect(result.approvals).toHaveLength(1);
      expect(result.approvals[0].type).toBe('Insurance');
    });

    it('should NOT require insurance for €0 parcel', () => {
      const result = routeParcel(makeParcel({ value: 0 }));
      expect(result.requiresApproval).toBe(false);
    });
  });

  // ===========================================================
  // INSURANCE APPROVAL — BOUNDARY CASES (Rule 6)
  // ===========================================================
  describe('Insurance Approval — Boundary Cases', () => {
    it('should NOT require insurance for exactly €1000 (boundary: >1000)', () => {
      const result = routeParcel(makeParcel({ value: 1000 }));
      expect(result.requiresApproval).toBe(false);
    });

    it('should require insurance for €1000.01 (just above boundary)', () => {
      const result = routeParcel(makeParcel({ value: 1000.01 }));
      expect(result.requiresApproval).toBe(true);
      expect(result.approvals[0].type).toBe('Insurance');
    });

    it('should NOT require insurance for €999.99 (just below boundary)', () => {
      const result = routeParcel(makeParcel({ value: 999.99 }));
      expect(result.requiresApproval).toBe(false);
    });
  });

  // ===========================================================
  // COMBINED CASES (weight + value)
  // ===========================================================
  describe('Combined Cases', () => {
    it('should route 15kg + €2000 parcel to Heavy with Insurance', () => {
      const result = routeParcel(makeParcel({ weight: 15, value: 2000 }));
      expect(result.department).toBe('Heavy');
      expect(result.requiresApproval).toBe(true);
      expect(result.approvals[0].type).toBe('Insurance');
    });

    it('should route 0.5kg + €5000 parcel to Mail with Insurance', () => {
      const result = routeParcel(makeParcel({ weight: 0.5, value: 5000 }));
      expect(result.department).toBe('Mail');
      expect(result.requiresApproval).toBe(true);
    });

    it('should route 5kg + €500 parcel to Regular without Insurance', () => {
      const result = routeParcel(makeParcel({ weight: 5, value: 500 }));
      expect(result.department).toBe('Regular');
      expect(result.requiresApproval).toBe(false);
    });

    it('should route 10kg + €1000 parcel to Regular without Insurance (double boundary)', () => {
      const result = routeParcel(makeParcel({ weight: 10, value: 1000 }));
      expect(result.department).toBe('Regular');
      expect(result.requiresApproval).toBe(false);
    });
  });

  // ===========================================================
  // RESULT STRUCTURE (explainability — Rule 8)
  // ===========================================================
  describe('Result Structure — Explainability', () => {
    it('should include department name in result', () => {
      const result = routeParcel(makeParcel({ weight: 5 }));
      expect(result.department).toBeDefined();
      expect(typeof result.department).toBe('string');
    });

    it('should include human-readable reason for department', () => {
      const result = routeParcel(makeParcel({ weight: 5 }));
      expect(result.departmentReason).toBeDefined();
      expect(result.departmentReason).toContain('5kg');
    });

    it('should include the rule name that matched', () => {
      const result = routeParcel(makeParcel({ weight: 5 }));
      expect(result.departmentRule).toBe('regular-department');
    });

    it('should include the original parcel in result', () => {
      const parcel = makeParcel({ weight: 5 });
      const result = routeParcel(parcel);
      expect(result.parcel).toEqual(parcel);
    });

    it('should include timestamp in result', () => {
      const result = routeParcel(makeParcel());
      expect(result.routedAt).toBeDefined();
    });

    it('should include human-readable reason for insurance approval', () => {
      const result = routeParcel(makeParcel({ value: 2000 }));
      expect(result.approvals[0].reason).toContain('2000');
      expect(result.approvals[0].reason).toContain('1,000');
    });

    it('should include the approval rule name', () => {
      const result = routeParcel(makeParcel({ value: 2000 }));
      expect(result.approvals[0].rule).toBe('insurance-required');
    });
  });

  // ===========================================================
  // CUSTOM RULES (extensibility)
  // ===========================================================
  describe('Custom Rules — Extensibility', () => {
    it('should allow injecting custom department rules', () => {
      const customDeptRules = [
        {
          name: 'express-department',
          department: 'Express',
          priority: 1,
          condition: (p) => p.weight <= 0.5,
          reason: (p) => `Weight (${p.weight}kg) qualifies for express.`,
        },
        {
          name: 'standard-department',
          department: 'Standard',
          priority: 2,
          condition: () => true, // catch-all
          reason: () => 'Default routing.',
        },
      ];

      const result = routeParcel(makeParcel({ weight: 0.3 }), {
        departmentRules: customDeptRules,
      });
      expect(result.department).toBe('Express');
    });

    it('should allow injecting custom approval rules', () => {
      const customApprovalRules = [
        {
          name: 'manual-review',
          type: 'Manual Review',
          condition: (p) => p.value > 5000,
          reason: (p) => `Value (€${p.value}) requires manual review.`,
        },
      ];

      const result = routeParcel(makeParcel({ value: 6000 }), {
        approvalRules: customApprovalRules,
      });
      expect(result.requiresApproval).toBe(true);
      expect(result.approvals[0].type).toBe('Manual Review');
    });

    it('should support multiple approvals for the same parcel', () => {
      const customApprovalRules = [
        {
          name: 'insurance-check',
          type: 'Insurance',
          condition: (p) => p.value > 1000,
          reason: () => 'Needs insurance.',
        },
        {
          name: 'manual-review',
          type: 'Manual Review',
          condition: (p) => p.value > 5000,
          reason: () => 'Needs manual review.',
        },
      ];

      const result = routeParcel(makeParcel({ value: 6000 }), {
        approvalRules: customApprovalRules,
      });
      expect(result.approvals).toHaveLength(2);
      expect(result.approvals.map((a) => a.type)).toEqual(['Insurance', 'Manual Review']);
    });
  });

  // ===========================================================
  // ERROR HANDLING
  // ===========================================================
  describe('Error Handling', () => {
    it('should throw if no department rule matches', () => {
      const noMatchRules = [
        {
          name: 'too-specific',
          department: 'Niche',
          priority: 1,
          condition: () => false, // Never matches
          reason: () => 'Never.',
        },
      ];

      expect(() => {
        routeParcel(makeParcel(), { departmentRules: noMatchRules });
      }).toThrow(/No department rule matched/);
    });
  });

  // ===========================================================
  // MANUAL REVIEW RULE (Phase 5 — New Rule Demonstration)
  // ===========================================================
  describe('Manual Review Approval', () => {
    // Normal cases
    it('should NOT require manual review for €100 parcel', () => {
      const result = routeParcel(makeParcel({ value: 100 }));
      const manualReview = result.approvals.find(a => a.type === 'Manual Review');
      expect(manualReview).toBeUndefined();
    });

    it('should require manual review for €6000 parcel', () => {
      const result = routeParcel(makeParcel({ value: 6000 }));
      const manualReview = result.approvals.find(a => a.type === 'Manual Review');
      expect(manualReview).toBeDefined();
      expect(manualReview.reason).toContain('5,000');
    });

    // Boundary cases — per spec: €5000 → no review, €5001 → review
    it('should NOT require manual review for exactly €5000 (boundary: >5000)', () => {
      const result = routeParcel(makeParcel({ value: 5000 }));
      const manualReview = result.approvals.find(a => a.type === 'Manual Review');
      expect(manualReview).toBeUndefined();
    });

    it('should require manual review for €5000.01 (just above boundary)', () => {
      const result = routeParcel(makeParcel({ value: 5000.01 }));
      const manualReview = result.approvals.find(a => a.type === 'Manual Review');
      expect(manualReview).toBeDefined();
    });

    it('should NOT require manual review for €4999.99 (just below boundary)', () => {
      const result = routeParcel(makeParcel({ value: 4999.99 }));
      const manualReview = result.approvals.find(a => a.type === 'Manual Review');
      expect(manualReview).toBeUndefined();
    });

    // Combined: high-value parcels get BOTH insurance AND manual review
    it('should require BOTH insurance and manual review for €6000 parcel', () => {
      const result = routeParcel(makeParcel({ value: 6000 }));
      expect(result.approvals).toHaveLength(2);
      expect(result.approvals.map(a => a.type)).toEqual(['Insurance', 'Manual Review']);
    });

    // Between insurance and manual review thresholds
    it('should require ONLY insurance (no manual review) for €3000 parcel', () => {
      const result = routeParcel(makeParcel({ value: 3000 }));
      expect(result.approvals).toHaveLength(1);
      expect(result.approvals[0].type).toBe('Insurance');
    });

    // Full combination: heavy + high-value
    it('should route 20kg + €8000 parcel to Heavy with Insurance + Manual Review', () => {
      const result = routeParcel(makeParcel({ weight: 20, value: 8000 }));
      expect(result.department).toBe('Heavy');
      expect(result.approvals).toHaveLength(2);
      expect(result.approvals.map(a => a.type)).toContain('Insurance');
      expect(result.approvals.map(a => a.type)).toContain('Manual Review');
    });

    // Explainability
    it('should include the manual review rule name', () => {
      const result = routeParcel(makeParcel({ value: 6000 }));
      const manualReview = result.approvals.find(a => a.type === 'Manual Review');
      expect(manualReview.rule).toBe('manual-review-required');
    });
  });

  // ===========================================================
  // REGRESSION PROTECTION (Phase 5)
  //
  // These tests form a "regression snapshot" — they lock down
  // the expected behavior of ALL current rules at key data points.
  // If someone changes a rule threshold accidentally, at least one
  // of these tests will fail immediately.
  // ===========================================================
  describe('Regression Snapshot — All Rules', () => {
    const regressionCases = [
      // format: [weight, value, expectedDept, expectedApprovals]
      [0.1,  0,      'Mail',    []],
      [0.5,  50,     'Mail',    []],
      [1,    100,    'Mail',    []],
      [1.001, 100,   'Regular', []],
      [5,    500,    'Regular', []],
      [10,   1000,   'Regular', []],
      [10.001, 100,  'Heavy',   []],
      [15,   100,    'Heavy',   []],
      [100,  0,      'Heavy',   []],
      // Insurance boundary
      [5,    1000,   'Regular', []],
      [5,    1000.01,'Regular', ['Insurance']],
      [5,    2000,   'Regular', ['Insurance']],
      // Manual Review boundary
      [5,    5000,   'Regular', ['Insurance']],
      [5,    5000.01,'Regular', ['Insurance', 'Manual Review']],
      [5,    6000,   'Regular', ['Insurance', 'Manual Review']],
      // Combined Heavy + approvals
      [15,   5000.01, 'Heavy',  ['Insurance', 'Manual Review']],
      [15,   100,     'Heavy',  []],
      // Mail + high value
      [0.5,  6000,   'Mail',    ['Insurance', 'Manual Review']],
    ];

    test.each(regressionCases)(
      '%skg + €%s → %s, approvals: %j',
      (weight, value, expectedDept, expectedApprovals) => {
        const result = routeParcel(makeParcel({ weight, value }));
        expect(result.department).toBe(expectedDept);
        expect(result.approvals.map(a => a.type)).toEqual(expectedApprovals);
      }
    );
  });
});

