# Parcel Routing System — Implementation Master Prompt

You are helping me build the **Parcel Routing System Technical Assessment** described below.

Your job is to help me implement this project **phase-by-phase**, while staying strictly within the requirements of the assessment. Do not introduce unnecessary features, technologies, abstractions, or scope that are not justified by the requirements.

I will implement the project incrementally. **Do not build the entire application at once.** Work on one phase at a time and wait for me to explicitly ask you to continue.

---

# 1. Assessment Context

We are building an internal parcel routing system for a parcel delivery company.

The system processes parcels and routes them to departments according to business rules.

The company expects the system to:

* Be adaptable to business changes
* Be reliable when failures occur
* Be safe to evolve
* Provide sufficient visibility when something goes wrong
* Demonstrate thoughtful engineering beyond basic coding

AI tools are explicitly allowed and expected to be used for at least two parts of the assignment.

The final deliverables are:

* Production-ready application
* Automated tests
* Configuration system if used
* README containing:
  * Architecture decisions
  * Trade-offs
  * AI usage documentation
  * How to extend the routing system
* 10–15 minute presentation

---

# 2. Core Business Requirements

Each parcel contains:

* Weight (kg)
* Value (€)
* Destination country
* Optional additional attributes

Default routing rules:

```text
Weight <= 1 kg       → Mail Department
Weight <= 10 kg      → Regular Department
Weight > 10 kg       → Heavy Department

Value > €1000        → Insurance approval required
```

The system must:

* Route parcels according to these rules
* Make business rules adaptable
* Allow future departments/routing conditions without major refactoring
* Consider the safety/correctness implications of rule changes
* Clearly communicate routing decisions

---

# 3. UI Requirements

The application must provide a simple interface that allows operators to:

* Enter parcel data
* Upload batch data
* View routing outcomes clearly

For batch upload, choose either JSON or XML and justify the decision.

The UI must:

* Be usable by non-technical operators
* Clearly communicate routing decisions
* Handle large input files gracefully
* Be responsive if web-based
* Prioritize clarity and usability over visual complexity

Do not build unnecessary UI features or elaborate dashboards.

---

# 4. Quality Requirements

The application must:

* Have automated tests for routing logic
* Demonstrate regression protection
* Demonstrate how a new rule can be introduced safely
* Include a small example of feature development from branch to merge
* Explain how correctness is validated beyond automated tests

---

# 5. Monitoring & Reliability Requirements

The system must provide sufficient visibility when something goes wrong.

Design for:

* Failure detection
* Useful logs
* Error context
* Investigation/debugging
* Notification/alerting
* Detection of unusual routing patterns

Do not build an unnecessarily complex observability platform. Implement only what is appropriate for this assessment.

---

# 6. Security Requirements

The application will be exposed to the public internet.

Implement appropriate protection against common threats.

The implementation and documentation should address relevant areas such as:

* Input validation
* API security
* Authentication/authorization where applicable
* Rate limiting
* File-upload security
* Secure configuration/secrets
* Injection protection
* Resource exhaustion
* Appropriate HTTP/security protections

Do not add security features merely for the sake of complexity. Explain why each implemented security measure is relevant.

---

# 7. Debugging Requirement

During the interview I may be given a buggy routing function.

The system and code should therefore be structured so that I can easily:

1. Understand the routing logic
2. Identify incorrect behavior
3. Reproduce the problem
4. Fix it
5. Add a regression test
6. Explain my reasoning

The routing code must remain readable and easy to reason about.

---

# 8. AI Usage Requirement

I must use AI for at least two parts of the assignment.

The project must document:

* The prompts used
* What AI generated
* What I changed
* Why I changed it
* What I accepted
* What I rejected
* Limitations of AI
* How I verified the generated output

AI should assist development, not replace my understanding.

Whenever you generate code for me, explain the important design decisions and make sure I understand the code before moving on.

---

# IMPLEMENTATION ROADMAP

Group the work into the following **8 major phases**.

Do not skip ahead unless I explicitly ask.

---

# PHASE 1 — Foundation, Domain Model & Validation

## Goal

Establish the basic project structure and define the parcel domain correctly.

## Tasks

### 1. Project foundation

Set up:

* Backend
* Frontend
* Project structure
* Environment configuration
* Git repository
* Basic README
* Basic error-handling structure

### 2. Parcel model

Define the parcel representation:

```text
weight
value
destinationCountry
additionalAttributes
```

### 3. Input validation

Validate:

* Required fields
* Data types
* Weight
* Value
* Country
* Additional attributes where appropriate
* Invalid/malformed input

Examples:

```text
weight = -5       → reject
weight = "hello"  → reject
value = "abc"     → reject
missing country   → reject
```

## Important

Do not implement the complete UI, batch system, monitoring, or security infrastructure yet.

At the end of this phase I should have a clean foundation and valid parcel data entering the system.

---

# PHASE 2 — Core Routing Engine & Extensible Rules

## Goal

Implement the core business logic and design it so business rules can evolve safely.

## Tasks

Implement:

```text
Weight <= 1kg   → Mail
Weight <= 10kg  → Regular
Weight > 10kg   → Heavy

Value > €1000   → Insurance approval
```

The routing result should contain enough information to explain the decision.

For example:

```text
Department: Heavy

Reason:
Parcel weight is greater than 10kg.

Insurance:
Required

Reason:
Parcel value exceeds €1000.
```

## Extensibility

Design a clean mechanism for adding future:

* Departments
* Conditions
* Routing rules
* Approval requirements

without major refactoring.

Possible approaches may include:

* Rule abstraction
* Strategy pattern
* Chain of Responsibility
* Configuration-driven rules

Do not blindly implement a design pattern.

Choose the simplest architecture that satisfies the requirements and explain:

* Why it was selected
* Alternatives considered
* Trade-offs
* How a new rule would be added

## Rule conflicts

Think about what happens if multiple future rules match the same parcel.

The design must have a clear and explainable approach to:

* Rule precedence
* Multiple applicable rules
* Routing decision
* Approval requirements

## Configuration safety

If rules are configurable, consider:

* Validation
* Invalid configurations
* Overlapping rules
* Missing ranges
* Safe rollout
* Rule/version identification

Do not create an unnecessarily complex configuration management system.

---

# PHASE 3 — Single Parcel UI & Routing API

## Goal

Provide the operator-facing functionality for processing one parcel.

## Tasks

Create a simple interface containing:

```text
Weight
Value
Destination Country
Additional Attributes

[ Route Parcel ]
```

Display results clearly.

Example:

```text
Department: Regular

Insurance: Not Required

Reason:
Parcel weight is between 1kg and 10kg.
```

Also implement the necessary backend API.

## UI principles

The UI must be:

* Simple
* Clear
* Usable by non-technical operators
* Responsive
* Focused on the routing task

Do not add unnecessary dashboards, animations, user-management screens, or other features that aren't required.

---

# PHASE 4 — Batch Processing & Large File Handling

## Goal

Allow operators to upload parcel data in bulk while handling large inputs responsibly.

## Tasks

Choose JSON or XML.

Prefer the format that provides the simplest appropriate solution and document the reasoning.

Implement:

```text
Upload
  ↓
Validate
  ↓
Process
  ↓
Route
  ↓
Display results
```

The system should handle mixed-validity batches.

For example:

```text
Parcel 1 → Routed
Parcel 2 → Invalid weight
Parcel 3 → Routed
Parcel 4 → Invalid value
```

Do not allow one invalid record to make the entire batch result unusable unless there is a strong business reason.

## Large files

Design batch processing so large files do not unnecessarily consume excessive memory.

Where appropriate use:

* Streaming
* Chunking
* Bounded processing
* Progress reporting

The UI should clearly communicate batch progress/results.

Example:

```text
Processing...

65,000 / 100,000

Successful: 64,850
Failed: 150
```

Do not build a distributed job-processing platform unless the requirements actually justify it.

---

# PHASE 5 — Testing, Safe Rule Changes & Git Workflow

## Goal

Demonstrate strong engineering discipline around business correctness.

## Automated tests

Create tests for:

### Normal cases

```text
0.5kg → Mail
5kg   → Regular
15kg  → Heavy
```

### Boundary cases

```text
1kg       → Mail
just above 1kg → Regular

10kg      → Regular
just above 10kg → Heavy

€1000     → No insurance
just above €1000 → Insurance
```

### Combined cases

```text
15kg + €2000
→ Heavy + Insurance
```

### Invalid inputs

Test relevant invalid inputs.

## Regression protection

Tests should make it difficult for future rule changes to accidentally break existing behavior.

## New rule demonstration

Introduce one realistic new rule, for example:

```text
Value > €5000 → Manual Review
```

Demonstrate:

```text
Create feature branch
        ↓
Implement rule
        ↓
Add tests
        ↓
Run complete test suite
        ↓
Review
        ↓
Merge
```

Test its boundaries:

```text
€4999 → no review
€5000 → no review
€5001 → manual review
```

## Git workflow

Show a small realistic feature-development example:

```text
main
  ↓
feature/manual-review-rule
  ↓
implementation + tests
  ↓
review
  ↓
merge
```

Keep this realistic rather than creating unnecessary Git process complexity.

---

# PHASE 6 — Security

## Goal

Secure the public-facing application against relevant common threats.

Implement appropriate protections for:

### Input

* Server-side validation
* Malformed input
* Injection attacks

### APIs

* Appropriate authentication/authorization where required
* Rate limiting
* Secure error responses

### File uploads

* Allowed file types
* File-size limits
* Content validation
* Malformed/malicious file handling
* Resource-exhaustion protection

### Application

* HTTPS in deployment
* Secure secrets/configuration
* Appropriate security headers
* Correct CORS configuration where applicable
* Dependency/security considerations

## Important

For every security measure, be able to explain:

```text
Threat
  ↓
Protection
  ↓
Why it matters
```

Do not add security mechanisms without understanding them.

---

# PHASE 7 — Reliability, Monitoring & Observability

## Goal

Make the system diagnosable and reliable when things go wrong.

## Failure handling

Consider:

* Invalid parcel
* Invalid batch
* Routing failure
* Database/persistence failure if applicable
* Unexpected application errors
* Partial batch failures

The system should distinguish between:

### User-facing information

Example:

```text
Unable to process this batch.

980 parcels processed successfully.
20 parcels require correction.

Batch ID: BATCH-1234
```

and:

### Internal technical information

Detailed logs should contain enough information for developers to investigate.

## Logging

Where appropriate capture:

```text
timestamp
request/batch ID
parcel ID
operation
routing result
rule/version
error information
```

Avoid unnecessary sensitive data.

## Metrics

Track relevant information such as:

```text
Parcels processed
Routing outcomes
Failed parcels
Batch failures
Processing time
Errors
```

## Unusual routing patterns

The system should make it possible to identify suspicious/unexpected routing behavior.

For example:

```text
Normal:
Mail       30%
Regular    60%
Heavy      10%

Unexpected:
Mail        0%
Regular     2%
Heavy      98%
```

The goal is visibility, not building a sophisticated ML anomaly-detection system.

## Alerts

Define reasonable conditions under which the engineering team should be notified.

Keep the implementation proportional to the assessment.

---

# PHASE 8 — Validation, AI Documentation, README & Presentation

## Goal

Finish the project and prepare it for the assessment interview.

### 1. Validation beyond automated tests

Document and demonstrate:

* Manual functional testing
* Boundary testing
* Batch testing
* Invalid input testing
* Failure testing
* Rule-change validation
* End-to-end testing

Explain how these complement automated tests.

---

## 2. AI usage documentation

Document at least two meaningful uses of AI.

For each:

```text
Purpose
↓
Prompt
↓
AI output
↓
What I changed
↓
Why I changed it
↓
How I verified it
↓
Limitations
```

I must be able to explain the generated code during the interview.

---

## 3. README

The README must contain:

```text
Project Overview

Architecture

Architecture Decisions

Trade-offs

Routing Rules

How Routing Rules Can Be Extended

Testing Strategy

Safe Rule Changes

Security

Reliability

Monitoring / Observability

Configuration Safety

AI Usage

How to Run

How to Test
```

Keep the README directly aligned with the assessment.

---

## 4. 10–15 minute presentation

Prepare a concise presentation covering:

```text
1. Problem & Requirements
2. Architecture
3. Single Parcel Demo
4. Batch Processing
5. Routing Rule Extensibility
6. Testing & Safe Rule Change
7. Security
8. Reliability & Monitoring
9. AI-Assisted Development
10. Trade-offs
```

The presentation should demonstrate engineering judgment rather than simply showing screenshots.

---

# DEVELOPMENT RULES

These rules apply throughout the entire project.

## Rule 1 — Implement phase-by-phase

Do NOT implement future phases prematurely.

When I say:

> "Start Phase 1"

only work on Phase 1.

When Phase 1 is complete, summarize:

* What was implemented
* Important files
* Important design decisions
* How to test it
* Any trade-offs
* What remains for the next phase

Then wait for me.

---

## Rule 2 — Stay within the assessment

Do not introduce unrelated features such as:

* Payment systems
* Notifications unrelated to failures
* Complex user profiles
* Analytics unrelated to routing/monitoring
* Recommendation systems
* AI routing
* Microservices purely for complexity
* Kubernetes unless actually justified
* Event-driven architecture purely for demonstration
* Distributed systems unnecessarily
* Complex dashboards
* Unrequested business features

Every significant implementation decision should be traceable to an assessment requirement.

---

## Rule 3 — Prefer simplicity

This is an interview assessment, not a production system serving millions of parcels.

Choose the simplest architecture that satisfies:

* Correctness
* Extensibility
* Reliability
* Security
* Testability
* Observability

Do not over-engineer.

---

## Rule 4 — Explain before implementing important architecture

For major decisions, explain:

```text
Problem
Options
Chosen approach
Why
Trade-offs
```

Then implement.

Do not blindly generate code.

---

## Rule 5 — Keep business logic independent

The routing engine should not be tightly coupled to:

* HTTP
* UI
* Database
* File upload
* Framework-specific code

The core business logic should be easy to test independently.

---

## Rule 6 — Prioritize correctness at boundaries

Whenever a business rule contains:

```text
<=
<
>
>=
```

explicitly test the boundary.

Do not assume the condition is correct.

---

## Rule 7 — Every important feature gets tests

When implementing a business rule:

```text
Implementation
+
Positive tests
+
Negative tests
+
Boundary tests
+
Regression tests
```

---

## Rule 8 — Make routing decisions explainable

Whenever possible, the routing result should make clear:

```text
What decision was made
Why it was made
Which rule caused it
```

This is important for operators, debugging, testing, and auditability.

---

## Rule 9 — Treat configuration changes as potentially dangerous

If routing rules are configurable, consider:

* Validation
* Rule conflicts
* Safe changes
* Versioning
* Testing
* Rollback/recovery where appropriate

Do not allow configuration changes to silently create invalid routing behavior.

---

## Rule 10 — AI does not replace understanding

If you generate code using AI:

* Review it
* Explain it
* Test it
* Modify it where appropriate
* Document the reasoning

I need to be able to defend the implementation during the interview.

---

# HOW YOU SHOULD TEACH/HELP ME

I am preparing this specifically for a technical assessment and interview.

Therefore, don't just give me code.

For important concepts, teach me in this order:

```text
1. Requirement
2. Problem
3. Design options
4. Chosen approach
5. Why this approach
6. Trade-offs
7. Implementation
8. Tests
9. Interview questions
10. How to explain the decision in the interview
```

Keep explanations practical and interview-oriented.

Focus especially on:

* First principles
* Why the architecture works
* Failure scenarios
* Edge cases
* Trade-offs
* Extensibility
* Testing
* Security
* Production reasoning

Avoid unnecessary theoretical explanations that do not help implement or defend this project.

---

# IMPORTANT INTERVIEW PREPARATION

For every major phase, help me prepare for questions such as:

```text
Why did you choose this approach?

What alternatives did you consider?

What happens if this component fails?

How would you add a new routing rule?

How do you prevent a rule change from breaking existing behavior?

How do you test boundary conditions?

How would this behave with a large batch?

How would you debug an incorrect routing decision?

How would you secure this endpoint?

How would you know something went wrong in production?

How would you investigate an unusual routing pattern?

What did AI generate?

What did you change from the AI output?

Why?
```

Do not manufacture questions unrelated to the assessment.

---

# FINAL PRINCIPLE

The final system should demonstrate this engineering progression:

```text
Correct Business Logic
        ↓
Adaptable Rules
        ↓
Usable Interface
        ↓
Reliable Batch Processing
        ↓
Automated Testing
        ↓
Safe Evolution
        ↓
Security
        ↓
Failure Handling
        ↓
Observability
        ↓
Documentation
        ↓
Interview-Ready System
```

The goal is **not maximum complexity**.

The goal is to demonstrate that I can take an open-ended business requirement and build a system that is:

**correct, understandable, adaptable, testable, secure, reliable, and observable.**
