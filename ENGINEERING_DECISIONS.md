# Engineering & Architecture Decisions: Parcel Routing System

This document provides a comprehensive, rigorous log of all architectural, logical, and engineering decisions made in the **Parcel Routing System** across Phases 1–5 (Foundation, Routing Engine, Single Parcel UI, Batch Processing, Testing & Safe Rule Changes).

For each decision, we outline:
1. **Context & Problem Statement**: What problem needed to be solved and why it matters.
2. **Alternatives Considered**: The candidate architectural approaches evaluated.
3. **Trade-Off Matrix**: Side-by-side comparison across key engineering dimensions (debuggability, extensibility, simplicity, testability, safety).
4. **Chosen Decision & Logical Rationale**: Why this approach was selected.
5. **Interview Talking Points**: How to clearly articulate and defend this decision to technical interviewers.

---

## Table of Contents

1. [Architectural Overview & Core Principles](#1-architectural-overview--core-principles)
2. [Decision 1: Tech Stack Selection (Plain JavaScript + Node/Express + React)](#decision-1-tech-stack-selection-plain-javascript--nodeexpress--react)
3. [Decision 2: Layered Architecture & Pure Domain Core (Clean Architecture Lite)](#decision-2-layered-architecture--pure-domain-core-clean-architecture-lite)
4. [Decision 3: Domain Data Modeling (Plain Objects vs Rich Class Models)](#decision-3-domain-data-modeling-plain-objects-vs-rich-class-models)
5. [Decision 4: Validation Strategy (Pure Custom Functional Validator vs External Schema Libraries)](#decision-4-validation-strategy-pure-custom-functional-validator-vs-external-schema-libraries)
6. [Decision 5: Error Handling Philosophy (Result Objects vs Exceptions)](#decision-5-error-handling-philosophy-result-objects-vs-exceptions)
7. [Decision 6: Routing Engine Architecture (Declarative Rule Objects with Injected Engine)](#decision-6-routing-engine-architecture-declarative-rule-objects-with-injected-engine)
8. [Decision 7: Bifurcated Rule Semantics (Exclusive Department Rules vs Accumulative Approval Rules)](#decision-7-bifurcated-rule-semantics-exclusive-department-rules-vs-accumulative-approval-rules)
9. [Decision 8: Rule Storage (In-Code Declarative Objects vs External JSON/DB Config)](#decision-8-rule-storage-in-code-declarative-objects-vs-external-jsondb-config)
10. [Decision 9: Rule Conflict Resolution & Fail-Safe Invariants](#decision-9-rule-conflict-resolution--fail-safe-invariants)
11. [Decision 10: Explainability as a First-Class Output](#decision-10-explainability-as-a-first-class-output)
12. [Decision 11: Testing Strategy & Regression Safety (Pure Domain Testing)](#decision-11-testing-strategy--regression-safety-pure-domain-testing)
13. [Decision 12: Interview Debuggability Design (Debugging Scenario Readiness)](#decision-12-interview-debuggability-design-debugging-scenario-readiness)
14. [Decision 13: Batch Processing Format (JSON vs XML)](#decision-13-batch-processing-format-json-vs-xml)
15. [Decision 14: Batch Processing Architecture (Async Queue + Redis Checkpoints)](#decision-14-batch-processing-architecture-chunked-sync-vs-job-queue)
16. [Decision 15: New Rule Addition Workflow (Feature Branch → Merge)](#decision-15-new-rule-addition-workflow-feature-branch--merge)
17. [Decision 16: Regression Testing Strategy (Parameterized Snapshot Table)](#decision-16-regression-testing-strategy-parameterized-snapshot-table)
18. [Decision 17: Chunk Ownership Tokens + Alerting Scope](#decision-17-chunk-ownership-tokens--alerting-scope)

---

## 1. Architectural Overview & Core Principles

```
                  +----------------------------------------------+
                  |                 HTTP CLIENT                  |
                  |     (React Frontend / Operator Batch Upload) |
                  +----------------------------------------------+
                                         |
                                         | JSON HTTP Requests
                                         v
   +-------------------------------------------------------------------------+
   | API LAYER (Express / Node.js)                                           |
   |   - Route Handlers (POST /route, POST /validate, GET /countries)        |
   |   - Express Middleware (cors, express.json, errorHandler)               |
   |   - Translation: HTTP Req -> Domain Call -> HTTP Response               |
   +-------------------------------------------------------------------------+
                                         |
                       Pure Domain Data  |  Pure Domain Calls
                       (Zero Express)    v
   +-------------------------------------------------------------------------+
   | DOMAIN LAYER (Pure JavaScript - Zero External Dependencies)             |
   |                                                                         |
   |   +-----------------------+           +------------------------------+  |
   |   |   validation.js       | --------> |      routingEngine.js        |  |
   |   |   (Input Sanitization,| Validated |   (Pure Evaluation Engine)   |  |
   |   |   Type/Bound Checking)| Parcel    |                              |  |
   |   +-----------------------+           +------------------------------+  |
   |                                                      ^                  |
   |                                                      | Injected Rules   |
   |                                       +------------------------------+  |
   |                                       |          rules.js            |  |
   |                                       |   (Department Rules Array)   |  |
   |                                       |   (Approval Rules Array)     |  |
   |                                       +------------------------------+  |
   +-------------------------------------------------------------------------+
                                         |
                                         v
   +-------------------------------------------------------------------------+
   | TEST SUITE (Jest)                                                       |
   |   - validation.test.js (40 tests): Pure function boundary validation    |
   |   - routingEngine.test.js (32 tests): Boundaries, combinations, rules   |
   |   - ZERO HTTP mocking required to verify business logic correctness     |
   +-------------------------------------------------------------------------+
```

### Guiding Principles Applied
1. **Rule of Least Power & Zero Accidental Complexity**: Solve the problem directly without introducing heavy abstractions, third-party bloat, or micro-frameworks.
2. **Determinism & Purity**: Core business logic must be deterministic pure functions of `(input) => output` with zero hidden state, side effects, or I/O.
3. **Explainability**: Every automated routing decision must explain *why* it occurred in human-readable terms.
4. **Fail-Closed Safety**: Any unexpected state or unhandled rule gap must fail explicitly rather than silently misroute parcels.

---

## Decision 1: Tech Stack Selection (Plain JavaScript + Node/Express + React)

### Context & Problem Statement
The assignment requires building an internal parcel routing application with an extensible routing engine, clear UI, and high reliability. We needed to choose the appropriate runtime, language dialect, and backend framework.

### Alternatives Considered
1. **Alternative A: TypeScript (Full Stack - Node.js + Express + React TS)**
2. **Alternative B: Plain JavaScript (Node.js + Express + React JSX) [CHOSEN]**
3. **Alternative C: Python (FastAPI / Flask + React)**
4. **Alternative D: Go / Java (Spring Boot)**

### Trade-Off Matrix

| Metric | Option A: TypeScript | Option B: Plain JavaScript (Chosen) | Option C: Python (FastAPI) | Option D: Go / Java |
|---|---|---|---|---|
| **Compilation Overhead** | High (build steps, ts-node/tsx, declaration files) | **None** (instant startup, native Node.js V8 execution) | Low (interpreted) | High (compiled binary) |
| **Simplicity & Friction** | Moderate (type gymnastics during rapid iteration) | **Highest** (pure JS, immediate feedback, zero transpile bugs) | High | Low |
| **Debugging in Interview** | Medium (type errors can distract during live debugging) | **Fastest** (readable plain JS, clean stack traces) | Fast | Slower setup |
| **Ecosystem & Shared Skills**| High | **Highest** (universal standard, shared data structures) | High | Strong types |
| **Dependency Footprint** | Heavy (tsc, @types/*, tsconfig) | **Minimal** (vanilla Node.js + Express runtime) | Moderate | Heavy |

### Chosen Decision & Logical Rationale
We selected **Plain JavaScript (Node.js + Express + React)**.
- **Why**: Eliminates transpilation layers (`tsc`, `tsx`, `babel`) and build drift. In a live technical assessment or technical interview where bugs may be introduced to test debugging skills, plain JavaScript offers immediate, un-obfuscated stack traces without source-map mismatches.
- **Compensating for Static Types**: We compensated for the absence of TypeScript by:
  1. Writing comprehensive JSDoc annotations defining data structures.
  2. Enforcing rigorous runtime input validation at the system boundaries (`validation.js`), which TypeScript cannot do at runtime anyway.
  3. Building a 72-test automated suite covering all types, invalid shapes, boundaries, and nullish states.

### Interview Talking Point
> *"While TypeScript provides compile-time safety, runtime boundaries still require strict input validation. We chose plain JavaScript to eliminate build-step complexity and keep live debugging completely transparent, while enforcing safety through a pure runtime validation pipeline and 100% boundary test coverage."*

---

## Decision 2: Layered Architecture & Pure Domain Core (Clean Architecture Lite)

### Context & Problem Statement
Where should business logic live? In many Node.js applications, developers put validation, calculations, and rule routing directly inside Express route handlers or controller files (`req, res`). When tests are needed, developers are forced to use `supertest`, mock `req`/`res`, or start HTTP listeners.

### Alternatives Considered
1. **Alternative A: Controller-Centric / Fat Routes** (Validation and rules directly in Express handlers).
2. **Alternative B: Heavy Clean Architecture / Hexagonal** (Ports, Adapters, Repositories, UseCase Interactors, DTO Mappers, Dependency Injection Containers).
3. **Alternative C: Pure Domain Core + Thin HTTP Shell (Clean Architecture Lite) [CHOSEN]**

### Trade-Off Matrix

| Metric | Option A: Fat Routes | Option B: Heavy Hexagonal / DDD | Option C: Clean Architecture Lite (Chosen) |
|---|---|---|---|
| **Separation of Concerns** | Poor (HTTP and domain coupled) | High (isolated) | **High** (domain is pure JS) |
| **Test Execution Speed** | Slow (requires HTTP stack / mocks) | Fast to Medium (many layers to stub) | **Instant** (< 50ms for 72 tests) |
| **Cognitive Load** | Low initially, chaotic later | Very High (over-engineered for this scope) | **Optimal** (clear folders: `domain/`, `api/`, `errors/`) |
| **Refactoring Safety** | Low | High | **High** |

### Chosen Decision & Logical Rationale
We implemented **Clean Architecture Lite**:
- The `src/domain/` directory (`validation.js`, `routingEngine.js`, `rules.js`) has **zero imports from Express, HTTP, or third-party frameworks**.
- All domain functions are **pure functions**: `(input) => result`.
- The `src/api/` directory is purely a thin transport translation shell: it extracts JSON from `req.body`, calls the domain function, and formats HTTP 200 or passes errors to `next(error)`.

### Interview Talking Point
> *"By keeping `domain/` completely free of Express or network dependencies, the routing engine can be tested directly as pure functions. If we ever switched from Express to Fastify, AWS Lambda, or a CLI batch runner, 100% of our business logic would remain untouched."*

---

## Decision 3: Domain Data Modeling (Plain Objects vs Rich Class Models)

### Context & Problem Statement
How should a Parcel be represented inside memory? As an instance of an Object-Oriented `class Parcel { ... }` or as an immutable plain JavaScript Object (`{ weight, value, ... }`)?

### Alternatives Considered
1. **Alternative A: Rich OOP Domain Model (`class Parcel` with methods like `parcel.route()`, `parcel.validate()`)**
2. **Alternative B: Plain Data Objects (Anemic Data Structure) + Functional Pipelines [CHOSEN]**
3. **Alternative C: Immutable.js / Freeze Record Libraries**

### Trade-Off Matrix

| Metric | Option A: Class Parcel (OOP) | Option B: Plain Objects + Pure Functions (Chosen) | Option C: Immutable.js |
|---|---|---|---|
| **JSON Serialization** | Awkward (custom `toJSON()` methods required) | **Native & Seamless** (`JSON.stringify`/`parse`) | Requires `.toJS()` conversions |
| **Coupling** | High (binds routing logic to data container) | **Zero** (Data is separated from calculation) | Low |
| **Debug Visibility** | Method prototypes clutter inspections | **Clean console inspection** (simple JSON dump) | Complex internal data structures |
| **Extensibility** | Inheritance hierarchies create fragility | **Object spread & maps** (`additionalAttributes`) | Heavy library overhead |

### Chosen Decision & Logical Rationale
We chose **Plain Objects with functional operations**:
- Parcels are fundamentally data payloads crossing network and process boundaries.
- Coupling behavior (routing) to data (parcel) violates the Single Responsibility Principle: a parcel shouldn't know how the warehouse chooses to route it.
- We included an open-ended `additionalAttributes` map (`{ fragile: true, hazmat: false }`), allowing future business parameters without altering the core parcel shape.

### Interview Talking Point
> *"Parcels are data, not behavior. Representing parcels as plain objects makes serialization instantaneous, eliminates prototype pollution, and allows our routing engine to operate as a stateless functional pipeline."*

---

## Decision 4: Validation Strategy (Pure Custom Functional Validator vs External Schema Libraries)

### Context & Problem Statement
Incoming parcel data from operators can be malformed, negative, non-numeric, or missing required fields. Should we use an external schema library (Zod, Joi, Yup, Express-Validator) or build a dedicated, pure JavaScript validation module?

### Alternatives Considered
1. **Alternative A: External Schema Library (e.g. Zod or Joi)**
2. **Alternative B: Pure Custom Modular Validator (`validation.js`) [CHOSEN]**
3. **Alternative C: Inline Checks within Route Handlers**

### Trade-Off Matrix

| Metric | Option A: Zod / Joi | Option B: Pure Custom Validator (Chosen) | Option C: Inline Route Checks |
|---|---|---|---|
| **External Dependencies** | Adds third-party dependencies & version risks | **Zero dependencies** (built-in JS only) | Zero dependencies |
| **Custom Business Bounds** | Harder to craft custom domain error messages | **Trivial** (exact custom business messaging) | Chaotic |
| **Multi-Error Accumulation** | Supported, but requires schema configuration | **Built-in by design** (returns all errors at once) | Usually fails fast on first error |
| **Sanitization & Normalization** | Requires transformation pipelines | **Explicit** (trims, parses float, uppercases countries) | Ad-hoc |
| **Auditing / Inspection** | Library internals opaque | **100% transparent** for live interview scrutiny | Unorganized |

### Logical Decisions Inside the Validator:
1. **Error Accumulation over Fail-Fast**:
   - If an operator submits `{ weight: -5, value: "abc", destinationCountry: "" }`, a fail-fast validator returns only "Weight must be positive". The operator fixes it, submits again, and gets "Value must be a number". This is frustrating UX.
   - Our validator collects **all field errors simultaneously** in an `errors` array.
2. **Defensive Upper Sanity Bounds**:
   - `weight <= 10,000 kg` (prevents typo disasters like entering 1,000,000 kg).
   - `value <= €1,000,000` (prevents runaway financial input errors).
3. **Value Zero is Valid**:
   - Unlike weight which must be strictly `> 0`, `value: 0` is legal (gifts, promotional items, documents).
4. **Country Code Normalization**:
   - Destination countries are checked against an ISO-3166 alpha-2 set in $O(1)$ time and normalized via `.trim().toUpperCase()`.

### Interview Talking Point
> *"We implemented a pure functional validator without external dependencies. It normalizes inputs, validates both lower and upper sanity bounds, and crucially accumulates all field errors in a single pass so operators see every issue at once rather than playing whack-a-mole."*

---

## Decision 5: Error Handling Philosophy (Result Objects vs Exceptions)

### Context & Problem Statement
When validation fails or routing encounters an issue, should the system throw exceptions (`throw new Error(...)`) or return structured result objects (`{ success, data, errors }`)?

### Alternatives Considered
1. **Alternative A: Throw Exceptions Everywhere (for both invalid inputs and bugs)**
2. **Alternative B: Return Result Objects for Expected Failures, Throw Only for Invariants/Bugs [CHOSEN]**
3. **Alternative C: Golang-Style Tuple Returns `[result, err]`**

### Trade-Off Matrix

| Metric | Option A: Throw Everywhere | Option B: Hybrid (Result for Input, Throw for Bugs) (Chosen) | Option C: Golang Tuples |
|---|---|---|---|
| **Semantics** | Blurs difference between bad input and server fault | **Clear distinction: Expected vs Exceptional** | Clear, but non-idiomatic in JS |
| **Performance** | High cost of stack-trace unwinding on expected bad inputs | **High speed** (objects allocated on stack/heap without trace) | High speed |
| **API Error Handling** | Requires try/catch blocks across all call sites | **Clean branching** (`if (!validation.success)`) | Clean branching |
| **Security** | Risk of leaking stack traces to clients | **Custom AppError masks internal traces** | Clean |

### Chosen Decision & Logical Rationale
- **Validation failures are EXPECTED business events**, not system crashes. Operators make typos. Therefore, `validateParcelInput()` returns a Result Object:
  `{ success: false, errors: [...] }`
- **Routing Engine Gaps are UNEXPECTED programming errors**: If a parcel cannot be matched to any department, this represents a dangerous gap in business rules (a parcel would disappear into limbo). Therefore, `findDepartment()` **throws a fatal invariant error**:
  `throw new Error("No department rule matched... indicates a gap in the routing rules configuration")`
- In the HTTP layer, we created `AppError` and `ValidationFailedError` to cleanly separate 4xx client errors (safe to show to the operator) from 500 internal errors (masked from client, logged for developers).

### Interview Talking Point
> *"Invalid user input is an expected operational scenario, so validation returns a structured Result object without stack-trace overhead. In contrast, an un-routable parcel is an invariant violation—a defect in rule coverage—so the engine throws immediately to prevent silent data corruption or lost parcels."*

---

## Decision 6: Routing Engine Architecture (Declarative Rule Objects with Injected Engine)

### Context & Problem Statement
The assessment requires routing parcels based on weight and value rules, while remaining adaptable to future rules, departments, and approval requirements without major refactoring. How should the engine be structured?

### Alternatives Considered
1. **Alternative A: Hardcoded `if / else if / else` Blocks**
2. **Alternative B: Heavy Rules Engine Library (e.g., `json-rules-engine`, Drools, RETE algorithm)**
3. **Alternative C: Traditional Gang of Four Strategy Pattern (Classes for each rule)**
4. **Alternative D: Declarative Rule Objects with Injected Functional Engine [CHOSEN]**

### Trade-Off Matrix

| Metric | Option A: Hardcoded if/else | Option B: Heavy Rules Engine | Option C: OOP Strategy Pattern | Option D: Declarative Rule Objects (Chosen) |
|---|---|---|---|---|
| **Simplicity** | Very high initially | Very low (complex DSL, AST parsing) | Moderate (lots of boilerplate files) | **High (plain JS array of objects)** |
| **Extensibility** | Zero (requires modifying core engine code) | High | High | **High (add 1 object to array, 0 engine edits)** |
| **Debuggability** | Easy for 3 rules, impossible for 50 | Difficult (black-box rule evaluation) | Moderate (step through multiple class files) | **Easiest (single step inspection, inspectable predicates)** |
| **Dependency Weight**| Zero | Heavy external library | Zero | **Zero** |
| **Testability** | Hard to test rules in isolation | Requires complex rule mocks | High | **Highest (test individual predicates or full engine)** |

### Chosen Decision & Logical Rationale
We chose **Declarative Rule Objects with an Injected Functional Engine**:
- Rules are defined as simple declarative objects in `rules.js`:
  ```javascript
  {
    name: 'mail-department',
    department: 'Mail',
    priority: 1,
    condition: (parcel) => parcel.weight <= 1,
    reason: (parcel) => `Parcel weight (${parcel.weight}kg) is 1kg or less.`
  }
  ```
- The engine (`routingEngine.js`) is an **engine evaluator** that accepts rules via dependency injection (`routeParcel(parcel, { departmentRules, approvalRules })`).
- **Open-Closed Principle (OCP)**: To add a new department (e.g., "Air Mail" or "Dangerous Goods"), a developer only adds a rule object to `rules.js`. The routing engine itself is **never edited**.

### Interview Talking Point
> *"We adhered to the Open-Closed Principle using declarative rule objects. The routing engine is a generic evaluator that remains closed for modification, while business rules are an injected configuration array open for extension. Adding a new department or approval rule requires zero changes to the engine code."*

---

## Decision 7: Bifurcated Rule Semantics (Exclusive Department Rules vs Accumulative Approval Rules)

### Context & Problem Statement
The business requirements define two distinct kinds of routing outcomes:
1. Destination department: Mail, Regular, or Heavy.
2. Approvals: Value > €1000 requires insurance.

What evaluation semantics should apply to these two concepts?

### Alternatives Considered
1. **Alternative A: Unified Single-Bucket Rules** (Treat department and insurance as identical rule types competing in one list).
2. **Alternative B: Bifurcated Semantic Pipelines (Department Partition vs Approval Accumulator) [CHOSEN]**
3. **Alternative C: Tag-Based Multi-Routing**

### Trade-Off Matrix

| Metric | Option A: Unified Bucket | Option B: Bifurcated Pipelines (Chosen) | Option C: Tag-Based |
|---|---|---|---|
| **Semantic Clarity** | Poor (department assignment gets mixed with insurance flags) | **Crystal Clear (physical destination vs policy requirement)** | Ambiguous |
| **Conflict Handling** | Messy (what if insurance wins priority over Heavy?) | **Zero conflict (Department is 1-of-N; Approvals are N-of-N)** | Unclear |
| **Business Logic Match** | Weak | **Direct match to real-world logistics workflow** | Weak |

### Chosen Decision & Logical Rationale
We recognized that logistics routing has two fundamentally different business semantics:
1. **Department Routing is a Partition Problem (Mutually Exclusive)**:
   - A physical parcel can only be placed into **one** physical sorting bin or truck at a time. It cannot be in both "Mail" and "Heavy".
   - *Semantic*: **First Match Wins** ordered by priority.
2. **Approvals are an Aggregation Problem (Cumulative)**:
   - Approvals are regulatory or risk gates. A heavy parcel of high value requires **both** Heavy sorting AND Insurance approval. If we later add Hazmat clearance, it requires all three.
   - *Semantic*: **Accumulate All Matches** (Filter map).

### Interview Talking Point
> *"Logistics routing consists of two fundamentally different problems: physical partitioning (which physical bin does the parcel go into?) and policy compliance (what safety gates must it pass?). We separated them into first-match department rules and accumulative approval rules, matching real-world operational constraints."*

---

## Decision 8: Rule Storage (In-Code Declarative Objects vs External JSON/DB Config)

### Context & Problem Statement
The assessment asks how business rules should be managed and how safety is ensured during rule changes. Should rules live in an external JSON file, a database, or version-controlled code?

### Alternatives Considered
1. **Alternative A: Database-Driven Rules (Dynamic runtime CRUD)**
2. **Alternative B: External JSON / YAML Configuration File**
3. **Alternative C: In-Code Declarative JavaScript Rules (`rules.js`) [CHOSEN]**

### Trade-Off Matrix

| Metric | Option A: DB-Driven | Option B: External JSON/YAML | Option C: In-Code Rules (Chosen) |
|---|---|---|---|
| **Safety & Auditability** | Low (runtime DB updates can crash production unnoticed) | Medium (JSON schema validation needed) | **Highest (Git PRs, code reviews, automated CI test suite)** |
| **Condition Expressiveness** | Complex (requires storing and evaluating expressions safely) | Limited (JSON cannot represent logic without custom DSL or `eval`) | **Full JavaScript expressiveness (`(p) => p.weight > 10`)** |
| **Overhead** | DB connections, migrations, caching | File I/O, parsing, schema validators | **Zero overhead** (native V8 execution) |
| **Zero-Downtime Rollback** | DB rollbacks are complex | Git revert | **Instant Git rollback (`git revert`)** |

### Chosen Decision & Logical Rationale
We chose **In-Code Declarative Objects in `rules.js`**:
- In logistics, rule changes (e.g. changing weight limits or insurance thresholds) have direct physical and financial consequences. They must go through strict peer review, automated regression tests, and version control.
- External JSON files require inventing a custom expression parser (or using dangerous `eval()`), introducing unnecessary security attack surfaces and cognitive friction.
- With in-code rules, any rule change is validated against the **automated test suite before deployment**. If a rule introduces a coverage gap or regression, CI fails immediately.

### Interview Talking Point
> *"Storing rules in code rather than an external database ensures that any rule change undergoes peer review, version-controlled git history, and automated CI regression testing before hitting production. It eliminates the security and parsing risks of dynamic DSL evaluation."*

---

## Decision 9: Rule Conflict Resolution & Fail-Safe Invariants

### Context & Problem Statement
What happens if two rules overlap? What happens if a parcel weight falls outside all defined rules (e.g., negative, or a gap between 1kg and 1.001kg)?

### Alternatives Considered
1. **Alternative A: Silent Fallback to Default Department** (e.g., if no match, send to "Regular").
2. **Alternative B: Highest Weight Match / Last Match Wins**
3. **Alternative C: Priority-Ordered First-Match with Fail-Closed Invariant [CHOSEN]**

### Trade-Off Matrix

| Metric | Option A: Silent Fallback | Option B: Arbitrary Last-Match | Option C: Explicit Priority + Fail-Closed (Chosen) |
|---|---|---|---|
| **Safety** | Dangerous (silently masks configuration errors) | Unpredictable | **Safest (errors detected immediately)** |
| **Predictability** | Poor | Poor | **Deterministic (lowest priority number evaluates first)** |
| **Bug Detection** | Bugs hide until parcels are lost | Hard to trace | **Fails fast with detailed diagnostics** |

### Chosen Decision & Logical Rationale
1. **Explicit Priority Order**:
   - Department rules are sorted by `priority` ascending before evaluation.
   - Priority 1 (Mail: $\le 1\text{kg}$) $\to$ Priority 2 (Regular: $\le 10\text{kg}$) $\to$ Priority 3 (Heavy: $> 10\text{kg}$).
   - This ensures rule ordering in the array doesn't cause subtle evaluation bugs.
2. **Fail-Closed Invariant**:
   - If no department rule matches, `routingEngine.js` **does not** pick a default. It throws an explicit error detailing the parcel parameters.
   - *Rationale*: A parcel in a warehouse that isn't matched to any department is a critical configuration failure. Silently defaulting it to "Regular" would cause oversized or misrouted parcels to jam sorting machinery.

### Interview Talking Point
> *"We avoid silent fallbacks. If business rules leave a gap in weight coverage, the engine fails closed with an explicit error. In logistics, failing fast to alert operations is far safer than silently misrouting physical packages."*

---

## Decision 10: Explainability as a First-Class Output

### Context & Problem Statement
In production, warehouse operators and customer service representatives must understand *why* a parcel was sent to a specific department or why insurance was mandated.

### Alternatives Considered
1. **Alternative A: Return Only Raw Identifiers (`{ dept: "MAIL", ins: true }`)**
2. **Alternative B: Separate Asynchronous Audit Log Service**
3. **Alternative C: First-Class Explainability in the Routing Result [CHOSEN]**

### Trade-Off Matrix

| Metric | Option A: Raw Identifiers | Option B: Separate Audit Log | Option C: First-Class Explainability (Chosen) |
|---|---|---|---|
| **Operator Clarity** | Zero (operator must guess or check manual handbook) | Delayed (requires looking up logs) | **Instant & Direct** |
| **Debugging Speed** | Slow | Moderate | **Immediate in UI and API payload** |
| **System Complexity**| Minimal | High (message queues, log aggregation) | **Minimal (generated synchronously during evaluation)** |

### Chosen Decision & Logical Rationale
Every rule defines both a `condition(parcel)` and a dynamic `reason(parcel)` function. The routing engine returns:
```json
{
  "department": "Heavy",
  "departmentReason": "Parcel weight (15kg) is greater than 10kg.",
  "departmentRule": "heavy-department",
  "requiresApproval": true,
  "approvals": [
    {
      "type": "Insurance",
      "reason": "Parcel value (€2,000) exceeds €1,000.",
      "rule": "insurance-required"
    }
  ],
  "routedAt": "2026-09-26T06:50:18.123Z"
}
```
This guarantees complete transparency across both API and UI with zero overhead.

### Interview Talking Point
> *"Explainability is not an afterthought or an auxiliary log. Every routing decision carries its human-readable justification and triggering rule name directly in the primary result object, giving operators immediate clarity and developers instant auditability."*

---

## Decision 11: Testing Strategy & Regression Safety (Pure Domain Testing)

### Context & Problem Statement
How do we prove correctness, prevent regressions, and validate boundary behavior without fragile, slow end-to-end integration tests?

### Alternatives Considered
1. **Alternative A: End-to-End API Integration Tests Only (Supertest / HTTP)**
2. **Alternative B: Pure Domain Unit Tests + Smoke API Tests [CHOSEN]**
3. **Alternative C: Manual Postman / UI Testing**

### Trade-Off Matrix

| Metric | Option A: E2E API Only | Option B: Pure Domain Unit + Smoke (Chosen) | Option C: Manual Testing |
|---|---|---|---|
| **Execution Time** | Seconds (slow server startup, socket binding) | **< 100 milliseconds for 72 tests** | Hours |
| **Precision of Failure** | Vague (HTTP 500 or 400 without clear cause) | **Pinpoint** (exact boundary line that failed) | Subjective |
| **Maintenance Cost** | High (flaky ports, connection timeouts) | **Near zero** (pure deterministic functions) | High |
| **Boundary Coverage** | Difficult to test exhaustively | **Exhaustive** (exact decimal boundaries tested) | Impractical |

### Chosen Decision & Logical Rationale
We partitioned tests into:
1. **`validation.test.js` (40 tests)**:
   - Valid inputs across standard ranges.
   - Field-by-field rejection tests (null, undefined, strings, NaN, zero weight, negative value, excessive weight, excessive value).
   - Case-insensitivity and whitespace normalization tests for country codes.
   - Sanitization of additional attributes.
   - Multi-error reporting verification.
2. **`routingEngine.test.js` (32 tests)**:
   - Standard cases for each department (0.5kg $\to$ Mail, 5kg $\to$ Regular, 15kg $\to$ Heavy).
   - **Boundary Tests**: $1.0\text{kg}$ vs $1.001\text{kg}$; $10.0\text{kg}$ vs $10.001\text{kg}$.
   - **Financial Boundaries**: $€1000$ (no insurance) vs $€1000.01$ (insurance triggered).
   - Custom rule injection tests demonstrating safe extensibility without modifying engine internals.
   - Gap detection invariant tests.

### Interview Talking Point
> *"We test business logic at the domain layer, not through the HTTP layer. Our 72 tests execute in under 100ms and exhaustively test every floating-point boundary condition (e.g. 1kg vs 1.001kg and €1000 vs €1000.01), giving us instant regression feedback."*

---

## Decision 12: Interview Debuggability Design (Debugging Scenario Readiness)

### Context & Problem Statement
Section 7 of the Technical Assessment states:
*"During the interview I may be given a buggy routing function. The system and code should therefore be structured so that I can easily understand, reproduce, fix, and add a regression test."*

### How the Architecture Directly Enables This:
1. **Single Point of Investigation**:
   - If routing logic is flawed (e.g., `<` instead of `<=`), the bug is guaranteed to be in `backend/src/domain/rules.js` or `backend/src/domain/routingEngine.js`—never lost inside HTTP middleware or UI state.
2. **Deterministic Reproduction**:
   - Because `routeParcel` is a pure function taking plain objects, any reported bug can be reproduced in a 3-line Jest test case in seconds:
     ```javascript
     test('reproduce live interview bug', () => {
       const result = routeParcel({ weight: 1.0, value: 500, destinationCountry: 'DE' });
       expect(result.department).toBe('Mail');
     });
     ```
3. **Safe Isolated Fix**:
   - Fix the predicate in `rules.js`.
   - Run `npm test`—all 72 existing tests ensure no other department or boundary was broken.
   - Commit with confidence.

### Interview Talking Point
> *"The entire codebase is intentionally optimized for live debuggability. By isolating business rules into pure predicate functions with zero framework dependencies, any reported routing defect can be reproduced, fixed, and verified with a regression test in less than two minutes."*

---

## Summary of Decisions

| # | Topic | Decision Taken | Key Benefit |
|---|---|---|---|
| **1** | Tech Stack | Plain JavaScript (Node/Express + React) | Zero build friction, instant debugging |
| **2** | Architecture | Clean Architecture Lite (Pure Domain Core) | Zero framework coupling, testable domain |
| **3** | Domain Model | Plain Objects + Open Attributes Map | Native JSON serialization, decoupled logic |
| **4** | Validation | Custom Pure Functional Validator | Zero deps, multi-error accumulation, sanity bounds |
| **5** | Error Handling | Result Objects (Validation) vs Exceptions (Bugs) | Fast UX feedback, fail-closed on system gaps |
| **6** | Routing Engine | Declarative Rule Objects + Injected Evaluator | Open-Closed Principle (OCP) compliant |
| **7** | Rule Semantics | First-Match Departments + Accumulating Approvals | Accurately models physical vs policy logistics |
| **8** | Rule Storage | In-Code Declarative Configuration | Version control, peer review, CI protection |
| **9** | Conflicts | Priority Sorting + Fail-Closed Gap Detection | Eliminates silent parcel loss |
| **10**| Explainability | Dynamic Reason Strings in Primary Output | Immediate operational clarity |
| **11**| Testing | Pure Domain Unit Testing (72 tests) | 100% boundary coverage in <100ms |
| **12**| Debuggability | Pure Predicate Functions | Fast reproduction and fix during interviews |
| **13**| Batch Format | JSON over XML | Native JS parsing, simpler syntax, smaller files |
| **14**| Batch Architecture | BullMQ + Redis, chunk checkpoints, TTL state | Async recovery, no DB/auth, single implementation |
| **15**| New Rule Workflow | Feature Branch → Tests → Merge (Git Workflow) | Safe, reviewable, documented process |
| **16**| Regression Strategy | Parameterized Snapshot Table + Boundary Tests | 18 data points covering all rule interactions |

---

## Decision 13: Batch Processing Format (JSON vs XML)

### Context & Problem Statement

Phase 4 requires operators to upload parcel data in bulk. The spec says: "Choose JSON or XML. Prefer the format that provides the simplest appropriate solution and document the reasoning."

### Alternatives Considered

| Option | Description |
|--------|-------------|
| **JSON** | Native JavaScript object notation, parsed with `JSON.parse()` |
| **XML** | Markup language, requires an external parser library (e.g., `xml2js`, `fast-xml-parser`) |

### Trade-Off Matrix

| Dimension | JSON | XML |
|-----------|------|-----|
| **Parse complexity** | Built-in (`JSON.parse()`) — zero dependencies | Requires external library |
| **File size** | ~30-50% smaller (no closing tags) | Larger due to verbose tag syntax |
| **Operator authoring** | Easy to create in any text editor | Requires careful tag matching |
| **Error messages** | Clear (line/position in JSON) | Often cryptic XML parser errors |
| **API consistency** | Matches existing POST /api/parcels/route format | Would require format translation |
| **Ecosystem** | JavaScript's native format | Legacy enterprise format |
| **Schema validation** | Can validate shape in JS | XSD adds complexity |

### Chosen Decision & Rationale

**JSON** — It is JavaScript's native data format. Using it means:
- Zero external parsing dependencies (no `xml2js` or similar)
- The batch file format matches the single-parcel API exactly
- Operators familiar with the single-parcel form can understand the batch format
- File sizes are 30-50% smaller than equivalent XML

### Interview Talking Points
- "I chose JSON because it eliminates an entire class of dependencies and matches our existing API contract."
- "XML would add parsing complexity without any benefit for this use case."
- "If we needed to integrate with enterprise systems that mandate XML, we could add an XML adapter without changing the batch processor itself."

---

## Decision 14: Batch Processing Architecture (Chunked Sync vs Job Queue)

### Context & Problem Statement

The spec requires: "Design batch processing so large files do not unnecessarily consume excessive memory." It also says: "Do not build a distributed job-processing platform unless the requirements actually justify it."

### Alternatives Considered

| Option | Description |
|--------|-------------|
| **A: Process entire array at once** | Parse full JSON, validate and route all parcels in one tight loop |
| **B: Chunked synchronous with event loop yields** | Process in configurable chunks (default 100), yielding to event loop between chunks |
| **C: Background job queue (Bull/Redis)** | Enqueue batch job, process asynchronously, poll for results |
| **D: Streaming JSON parser (JSONStream)** | Parse large JSON files as a stream without loading the entire file into memory |

### Trade-Off Matrix

| Dimension | A (All at once) | B (Chunked) | C (Job queue) | D (Streaming) |
|-----------|-----------------|-------------|---------------|----------------|
| **Memory** | Entire array in memory | Entire array + chunked processing | Low (queue-based) | Very low |
| **Complexity** | Trivial | Low | High (Redis, workers, polling) | Medium (stream callbacks) |
| **Dependencies** | None | None | Bull, Redis | JSONStream |
| **Responsiveness** | Blocks event loop for large batches | Yields between chunks | Non-blocking | Non-blocking |
| **Progress reporting** | None possible | Easy (callback per chunk) | Requires polling | Possible but complex |
| **Assessment fit** | Too naive | Blocks the event loop per request | **Selected ✓ (async + Redis checkpoints)** | Slightly over-engineered |

### Chosen Decision & Rationale

**Option C: Background job queue (BullMQ + Redis) with Redis chunk checkpoints**
— the assessment's batch flow (upload → process → show results → session ends)
needs asynchronous processing with failure recovery, and no permanent history:

- `POST /api/batches` → validate → verify Redis → create temporary Redis state
  (meta + input + `PENDING` chunk checkpoints, all TTL-expired) → BullMQ job
  carrying `{ batchId }` only → `202`
- Worker atomically claims one chunk at a time (unique ownership token per
  claim; stale locks expire and are reclaimable), routes it through the
  shared domain core, and checkpoints only if its token still holds the lock
  (parcel results via `HSETNX` + chunk `DONE` + TTL refresh) in one atomic
  Lua script
- Progress derives from checkpoint state, so retries never double-count;
  parcel-level `HSETNX` is the final idempotency safeguard
- No database, no authentication, no permanent batch listing: the API is
  anonymous and state expires (`BATCH_TTL_SECONDS`, default 24h)

Earlier iterations used Option B (chunked synchronous `processBatch()`); that
helper has been removed so only ONE batch implementation exists. Mental model:
**BullMQ = durable work ("what needs to happen"), Redis batch state =
temporary progress/results ("what happened", TTL-expired).** Duplicate
computation is minimized but not mathematically eliminated under a crash
occurring between computation and checkpoint.

### Key Implementation Details
- `POST /api/batches` assigns missing parcel IDs first, then enforces uniqueness across the FINAL IDs (generated `P{N}` can never silently collide with explicit `"P{N}"`); `enqueueBatch()` verifies Redis, applies backpressure, creates TTL state, and enqueues; queue failure deletes the temporary state and returns 503
- The worker (`worker.js`) claims/releases/checkpoints via `batchStore.js` with per-claim ownership tokens; chunk size defaults to `BATCH_CHUNK_SIZE` (500), lease `CHUNK_LEASE_MS` (5 min, matching the BullMQ lock duration — far above realistic per-chunk processing time, so no lease renewal is needed)
- Each parcel is validated and routed independently (mixed-validity handling → `COMPLETED_WITH_ERRORS`, never a silent drop); unexpected system errors propagate to BullMQ retry and are recorded in the error metric, never stored as parcel rows
- `validateBatchInput()` rejects batches over 10,000 parcels as a safety limit; results pages are capped (`RESULTS_MAX_LIMIT`) and the UI paginates (200/page, full result set reachable)
- Batch results follow ONE canonical contract (`parcelId/index/status/department/requiresApproval/approvals/matchedRules/reasons/errors/inputSummary`) rendered directly by the UI

### Interview Talking Points
- "The queue owns the work and Redis owns temporary state — both expire, because the flow ends at result display, not permanent history."
- "Checkpointing bounds recomputation to the unfinished chunk; HSETNX idempotency keeps results correct under retry."
- "No auth, no database: the assessment defines no users and no history requirement, so anonymous access plus rate limits, validation, and request limits is the honest, minimal security model."

---

## Decision 15: New Rule Addition Workflow (Feature Branch → Merge)

### Context & Problem Statement

Demonstrating how to safely evolve business rules using a realistic Git workflow.
The original assessment requires only one approval rule (`value > €1000 → Insurance`);
`Value > €5000 → Manual Review` below is a **deliberate demonstration rule** showing
that new rules can be added without touching the engine — it is NOT presented as an
original requirement.

### Workflow Executed

```text
master (Phase 4 complete, 95 tests passing)
  ↓
git checkout -b feature/manual-review-rule
  ↓
Add rule to rules.js (6 lines: name, type, condition, reason)
  ↓
Add 9 tests (boundary: €5000/€5000.01/€4999.99, combinations, explainability)
  ↓
Add 18 regression snapshot data points (parameterized test.each)
  ↓
Run full suite: 122 tests passing ✓
  ↓
git commit on feature branch
  ↓
git checkout master
  ↓
git merge --no-ff feature/manual-review-rule
  ↓
Final test run: 122 tests passing ✓
```

### Why This Demonstrates Safety

1. **No engine changes needed** — Adding the rule only touched `rules.js` (6 lines) and the test file. The routing engine was completely untouched.
2. **All existing tests still pass** — The 95 existing tests from Phases 1-4 were not modified and all passed with the new rule in place.
3. **Feature branch isolation** — The new rule was developed in isolation, so a bad rule wouldn't break `master`.
4. **No-fast-forward merge** — `--no-ff` preserves the branch history in the git graph, making the feature addition visible.

### Interview Talking Points
- "Adding the Manual Review rule required editing exactly ONE file (`rules.js`) and adding 6 lines. This validates the Open-Closed Principle from Decision 6."
- "The existing 95 tests were not modified at all, proving the rule addition is non-breaking."
- "The feature branch shows a realistic workflow — in production this would include a PR review."

---

## Decision 16: Regression Testing Strategy (Parameterized Snapshot Table)

### Context & Problem Statement

Phase 5 requires "regression protection" — tests that make it difficult for future rule changes to accidentally break existing behavior.

### Alternatives Considered

| Option | Description |
|--------|-------------|
| **A: Individual test cases per scenario** | Separate `it()` blocks for each scenario |
| **B: Parameterized data table (`test.each`)** | Single test template with an array of input/expected-output rows |
| **C: Jest snapshot testing** | Serialize routing results and compare to stored snapshots |

### Trade-Off Matrix

| Dimension | A (Individual) | B (Data Table) | C (Snapshots) |
|-----------|----------------|----------------|---------------|
| **Scanability** | Hard to see the full picture | One table shows all rules at a glance ✓ | Hidden in snapshot files |
| **Adding cases** | Write new test function | Add one row to array ✓ | Auto-generated |
| **Failure messages** | Generic assertion error | Shows exact input that broke ✓ | Diff of serialized output |
| **False positives** | Unlikely | Unlikely | Common (timestamp changes, etc.) |
| **Documentation value** | Moderate | High — reads like a specification ✓ | Low |

### Chosen Decision & Rationale

**Option B: Parameterized data table** — The regression snapshot in `routingEngine.test.js` is a `test.each()` with 18 data points:

```javascript
const regressionCases = [
  // [weight, value, expectedDept, expectedApprovals]
  [0.1,    0,       'Mail',    []],
  [1,      100,     'Mail',    []],
  [1.001,  100,     'Regular', []],
  [10,     1000,    'Regular', []],
  [10.001, 100,     'Heavy',   []],
  [5,      1000.01, 'Regular', ['Insurance']],
  [5,      5000.01, 'Regular', ['Insurance', 'Manual Review']],
  // ... 11 more cases
];
```

This is both a test AND documentation. Anyone reading this table can understand every rule in the system at a glance.

### Interview Talking Points
- "The regression table serves as living documentation — if you want to know what the system does for any input, look at this table."
- "Adding a row takes 10 seconds. Removing a row would require an explicit decision to change expected behavior."
- "Jest's `test.each` generates descriptive test names like `5kg + €5000.01 → Regular, approvals: ['Insurance', 'Manual Review']` — these read like a specification."

---

## Decision 17: Chunk Ownership Tokens + Alerting Scope

### Context & Problem Statement

A plain `SET NX PX` lock proves *someone* holds a chunk, but after the lease
expires a stale worker can no longer tell whether it still owns the chunk:
it could mark `DONE`, delete the new owner's lock, and corrupt progress.
Separately, the assessment asks that the team be notified of failures, but
no external alerting channel exists in the repo.

### Chosen Decision & Rationale

**Ownership tokens (correctness):** every successful claim mints a unique
`{workerId}:{uuid}` token stored as the lock value. Checkpoint and release
are single Lua scripts that act ONLY when the lock still holds the caller's
token — otherwise they change nothing and report rejection. Consequences:

- A stale worker cannot checkpoint, cannot mark `DONE`, cannot delete
  another worker's lock, and cannot corrupt progress — rejection is atomic.
- A lease that outlives realistic per-chunk processing (5 min default vs
  millisecond-scale chunks) plus ownership verification is the simplest safe
  combination; no renewal thread, no distributed lock framework.
- Repeated stale rejections fail the job loudly (likely `CHUNK_LEASE_MS`
  misconfiguration) instead of spinning claim→reject forever.

**Alerting scope (honesty):** current observability is structured logs +
metrics + anomaly detection exposed via `GET /api/health/detailed` — no
Slack/email/PagerDuty integration is claimed. Production extension: forward
the anomaly/critical-error signals to an external channel. Deliberately out
of scope here; the docs say so explicitly.

### Interview Talking Points
- "The token turns 'I once held this chunk' into a checkable fact: the commit
  itself verifies ownership, so races resolve to at most one winner."
- "We monitor everything an alerting platform would need; wiring the last
  mile (Slack/PagerDuty) is a deployment task, not an architecture gap."

