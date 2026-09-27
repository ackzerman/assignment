# MASTER IMPLEMENTATION PROMPT — Parcel Routing System

> **IMPLEMENTATION AMENDMENT (adopted):** the assessment defines no user
> accounts and no permanent batch history, so the implementation is
> deliberately simpler than some sections below suggest:
> * **No authentication / no batch ownership** — the API is anonymous/public;
>   security comes from rate limiting, validation, request limits, safe
>   errors, and infrastructure isolation (§25 applies except Authentication /
>   Authorization, which are intentionally not implemented).
> * **No relational database** — temporary Redis state (TTL-expired) holds
>   batch progress, chunk checkpoints, and results; there is no permanent
>   batch listing or history (§13/§14/§19/§33/§34 apply with "Redis temporary
>   state" in place of "database", and Redis `HSETNX` parcel writes in place
>   of a SQL unique constraint).
> * Flow is upload → process → show results → session ends / state expires.

## ROLE

You are a senior backend/full-stack engineer implementing and hardening the existing **Parcel Routing System**.

Your job is to modify the existing repository incrementally and safely.

Do **not** rewrite the project from scratch.

Before changing anything, inspect the existing codebase, understand the current architecture, preserve working functionality, and implement each phase independently.

The final system must be:

* Correct
* Extensible
* Testable
* Secure
* Reliable
* Observable
* Fault-tolerant
* Explainable
* Production-oriented without unnecessary over-engineering

This is an **on-campus/fresher technical assessment**, so prioritize clear engineering decisions and understandable architecture over enterprise-level complexity.

---

# 1. EXISTING BUSINESS REQUIREMENTS

A parcel contains:

```text
weight
value
destinationCountry
additionalAttributes
```

## Department routing rules

```text
weight <= 1 kg       → Mail
weight <= 10 kg      → Regular
weight > 10 kg       → Heavy
```

These department rules are mutually exclusive.

They use:

> **first matching rule wins**

with explicit priority.

## Approval rules

```text
value > €1000 → Insurance approval required
```

Approval rules are cumulative.

Multiple approval rules may match the same parcel.

## Routing result

A routing decision should be explainable.

It should contain information such as:

```json
{
  "parcelId": "P123",
  "department": "REGULAR",
  "approvals": ["INSURANCE"],
  "matchedRules": [
    "department.regular",
    "approval.insurance"
  ],
  "reasons": [
    "Weight is <= 10kg",
    "Value exceeds €1000"
  ]
}
```

Do not expose unnecessary internal implementation details.

---

# 2. CORE ARCHITECTURE

Use a clean-architecture-lite approach.

The architecture should conceptually remain:

```text
                         CLIENT
                           |
                           v
                    Express API
                           |
             +-------------+-------------+
             |                           |
        Single Parcel                  Batch
             |                           |
        Validation                 Batch validation
             |                           |
        Routing Engine             Create Batch
             |                           |
           Rules                       Queue
                                         |
                                    Worker Pool
                                         |
                                    Validation
                                         |
                                    Routing Engine
                                         |
                                       Rules
                                         |
                                 Redis state/results
                                         |
                                  Status / Results
                                         |
                                      API
                                         |
                                    Frontend
```

## Critical architectural rule

The **queue does NOT contain business logic**.

The queue only represents durable work.

The worker consumes a queue job and invokes:

```text
validation
    ↓
routing engine
    ↓
rules
```

Both single-parcel and batch processing must ultimately use the **same domain routing logic**.

Do not duplicate routing logic for batch processing.

---

# 3. DOMAIN CORE MUST REMAIN FRAMEWORK-INDEPENDENT

The core domain should not depend on:

* Express
* Redis
* BullMQ
* HTTP request/response objects
* state models
* frontend code

The conceptual dependency should be:

```text
Input
 ↓
Validation
 ↓
Routing Engine
 ↓
Rules
 ↓
Routing Result
```

The domain should be deterministic.

Given the same valid parcel:

```text
same input → same routing result
```

This is important for:

* testing
* retries
* queue processing
* idempotency
* debugging
* explainability

---

# 4. PHASE 0 — BASELINE AUDIT

Before modifying anything:

1. Inspect the entire repository.
2. Understand:

   * backend structure
   * frontend structure
   * domain files
   * routes
   * middleware
   * tests
   * batch implementation
   * configuration
   * package dependencies
3. Read:

   * `MASTER_PROMPT.md`
   * `ENGINEERING_DECISIONS.md`
   * `README`
4. Run:

   * tests
   * build
   * application locally
5. Record the current state.

Do not change architecture before understanding the existing implementation.

### Verification

After Phase 0 report:

```text
Current architecture
Existing functionality
Existing tests
Existing risks
Planned changes
```

Stop if the baseline does not work.

---

# 5. PHASE 1 — PROTECT THE DOMAIN CORE

Preserve/refactor the domain into clear responsibilities.

Expected conceptual structure:

```text
domain/
    parcel.js
    validation.js
    rules.js
    routingEngine.js
```

Responsibilities:

### `validation.js`

Responsible for:

* validating incoming parcel data
* normalizing external input
* accumulating validation errors
* returning canonical domain representation

Validation should be strict.

Do not rely on permissive parsing such as:

```js
parseFloat("5abc")
```

being accepted as `5`.

Reject malformed numeric values.

Validate:

* required fields
* types
* numeric ranges
* country code
* additional attributes
* unexpected/malformed structures

### `rules.js`

Contains the actual routing rules.

Rules should be declarative wherever practical.

Example conceptual structure:

```text
id
type
priority
condition
result
reason
```

### `routingEngine.js`

Responsible for:

* evaluating rules
* applying department-rule priority
* applying approval rules cumulatively
* generating explainable routing decisions
* failing closed when no department rule matches

The routing engine decides **how rules are evaluated**.

Rules define **what the business rules are**.

Do not mix these responsibilities.

---

# 6. RULE SEMANTICS

Explicitly preserve these semantics.

## Department rules

Mutually exclusive:

```text
first matching rule wins
```

Use explicit priority.

Do not depend accidentally on array order without documenting the behavior.

## Approval rules

Cumulative:

```text
all matching approval rules apply
```

Example:

```text
value > 1000 → insurance
value > 5000 → manager approval
```

A €6000 parcel should receive both approvals.

## Explainability

Every routing result should be able to explain:

```text
which rule matched
why it matched
what decision it caused
```

This should be represented through stable rule IDs/reasons.

---

# 7. PHASE 2 — VALIDATION + API BOUNDARY

The API layer must remain an adapter.

Conceptually:

```text
HTTP request
     ↓
extract input
     ↓
validate
     ↓
call domain service
     ↓
serialize result
     ↓
HTTP response
```

Routes must NOT contain business routing logic.

They should not independently evaluate weight/value rules.

## Error handling

Distinguish:

### Expected errors

Examples:

* invalid parcel
* missing field
* invalid country
* invalid batch

These should produce appropriate client errors.

### Unexpected errors

Examples:

* Redis failure
* programming error

These should go through centralized error handling.

Never expose:

* stack traces
* internal state details
* secrets
* implementation internals

---

# 8. PHASE 3 — SINGLE PARCEL PROCESSING

Single parcel processing should remain **synchronous** unless there is a specific business requirement for asynchronous processing.

Flow:

```text
POST /api/parcels
      ↓
Validation
      ↓
Routing Engine
      ↓
Rules
      ↓
Immediate response
```

Example:

```http
POST /api/parcels
```

returns:

```http
200 OK
```

with the routing result.

Do NOT unnecessarily send single parcels through the queue.

### Why?

Because routing is computationally cheap and the caller expects an immediate answer.

A queue would add:

* latency
* infrastructure
* complexity
* asynchronous API semantics

without solving an actual requirement.

---

# 9. PHASE 4 — BATCH PROCESSING ARCHITECTURE

Batch processing is asynchronous.

Do NOT make the HTTP request itself process a huge batch synchronously.

Instead:

```text
POST /api/batches
       ↓
Validate batch envelope
       ↓
Create batch record
       ↓
Queue batch job
       ↓
Return 202
```

Response:

```json
{
  "batchId": "B123",
  "status": "QUEUED"
}
```

Use:

```http
202 Accepted
```

because processing has not completed yet.

---

# 10. QUEUE DESIGN

Use a durable queue such as:

```text
BullMQ + Redis
```

unless the repository already has an appropriate queue infrastructure.

Do not introduce Kafka or other heavyweight distributed infrastructure unless the requirements genuinely justify it.

## Important

The queue payload should NOT contain an unnecessarily huge batch.

Prefer:

```json
{
  "batchId": "B123"
}
```

The worker can retrieve the batch data from the persistent store.

This keeps queue messages small and allows durable recovery.

---

# 11. WORKER DESIGN

The worker consumes a batch job.

Conceptually:

```text
Queue
  ↓
Worker
  ↓
Load batch
  ↓
Process parcels
  ↓
Validate parcel
  ↓
Routing Engine
  ↓
Persist result
  ↓
Update progress
```

The worker must use the **same validation and routing engine** as synchronous processing.

Do not create:

```text
singleParcelRouting()
batchRouting()
```

with duplicated business rules.

Instead:

```text
single API ───────┐
                  ├──> validation → routing engine → rules
batch worker ─────┘
```

---

# 12. BATCH CHUNKING

Initially, use:

```text
1 queue job = 1 batch
```

and process the batch internally in chunks.

For example:

```text
Batch: 100,000 parcels

Worker
 ├── chunk 1
 ├── chunk 2
 ├── chunk 3
 ├── ...
```

Yield to the Node.js event loop where appropriate.

Remember:

> `setImmediate()` prevents monopolizing the event loop; it does NOT create parallelism.

If future scale requires it, the architecture can evolve toward:

```text
batch
 ↓
chunk jobs
 ↓
worker pool
```

but do not introduce this complexity prematurely.

---

# 13. PHASE 5 — TEMPORARY BATCH STATE (Redis, TTL-expired)

Temporary Redis state is required for the asynchronous batch workflow because the system needs application state while processing. No permanent history is retained: keys expire after the session.

Redis state answers:

> **What happened?**

The queue answers:

> **What work needs to happen?**

Do not confuse their responsibilities.

## Persist batch state

Example:

```text
QUEUED
PROCESSING
COMPLETED
COMPLETED_WITH_ERRORS
FAILED
```

Store:

```text
batchId
status
total
processed
successful
failed
createdAt
startedAt
completedAt
error information
```

Potentially:

```text
progress percentage
```

can be derived from:

```text
processed / total
```

rather than unnecessarily storing redundant values.

---

# 14. PARCEL RESULT TEMPORARY STORAGE

Store the routing result in temporary Redis state (TTL-expired) for the
active processing session.

For example:

```text
batchId
parcelId
department
approvals
matchedRules
reasons
status
createdAt
```

This provides:

* temporary results for the session
* status retrieval
* explainability
* idempotency
* recovery after worker crashes

Explainability is **one reason** to store results, not the only reason.

---

# 15. REAL-TIME PROGRESS

The user SHOULD be able to see batch progress.

The queue itself is not exposed to the user.

The flow should be:

```text
Worker
  ↓
updates progress
  ↓
Redis state
  ↓
API
  ↓
Frontend
```

Expose:

```http
GET /api/batches/:batchId
```

Example:

```json
{
  "batchId": "B123",
  "status": "PROCESSING",
  "total": 10000,
  "processed": 3200,
  "successful": 3150,
  "failed": 50,
  "progress": 32
}
```

Frontend can display:

```text
Processing batch B123

████████░░░░░░░░░░░░ 32%

3,200 / 10,000 processed
3,150 successful
50 failed
```

## Initial implementation

Use **polling**.

For example:

```text
Frontend
   ↓
GET /api/batches/B123
   ↓
wait
   ↓
GET /api/batches/B123
   ↓
...
```

This is sufficient for the assessment.

Do not introduce WebSockets/SSE unless required.

## Optional future enhancement

The architecture should allow:

```text
Worker → WebSocket/SSE → Frontend
```

for push-based updates.

---

# 16. BATCH RESULTS API

After completion:

```http
GET /api/batches/:batchId/results
```

should return persisted routing results.

Example:

```json
{
  "batchId": "B123",
  "status": "COMPLETED_WITH_ERRORS",
  "results": [
    {
      "parcelId": "P1",
      "department": "MAIL",
      "approvals": [],
      "matchedRules": ["department.mail"],
      "reasons": ["Weight is <= 1kg"]
    }
  ]
}
```

Do not force the client to keep the original request payload in memory.

Temporary Redis state is the source of truth for asynchronous results during the session.

---

# 17. PHASE 6 — IDEMPOTENCY + DUPLICATE PROCESSING

Assume the queue provides **at-least-once delivery**.

Therefore:

```text
same job may execute more than once
```

This is normal.

Do not assume:

```text
one queue message = exactly one execution
```

## Important distinction

Idempotency prevents:

> duplicate final state

It does NOT necessarily prevent:

> duplicate computation

Example:

```text
Worker 1 processes P123
Worker 1 writes result
Worker crashes before ACK

Queue retries job

Worker 2 processes P123 again
```

The routing computation may happen twice.

That is acceptable if the final persisted result remains correct.

---

# 18. STABLE PARCEL IDENTITY

Every parcel in a batch must have a stable identity.

Prefer:

```text
batchId + parcelId
```

Do NOT use the parcel content itself as the unique identity.

Why?

Two legitimate parcels can have:

```text
same weight
same value
same country
same attributes
```

but still be different parcels.

---

# 19. REDIS-LEVEL DUPLICATE PROTECTION

Store results with an idempotent Redis write (one `HSETNX` per parcel result
inside the checkpoint transaction):

```text
HSETNX batch:{id}:results {parcelIndex} {result}
```

This is the authoritative protection against duplicate final records.

The architecture becomes:

```text
At-least-once queue
        ↓
Possible duplicate execution
        ↓
Idempotent worker
        ↓
Stable parcel identity
        ↓
Redis HSETNX result writes
        ↓
Correct final state
```

Queue-level job IDs can reduce accidental duplicate jobs, but they are NOT sufficient as the only idempotency mechanism.

Redis idempotent writes must protect the final state.

---

# 20. PARTIAL FAILURE

A single invalid parcel should not necessarily destroy the entire batch.

Example:

```text
10,000 parcels
9,950 valid
50 invalid
```

The worker should process valid parcels and record invalid ones.

Final state:

```text
COMPLETED_WITH_ERRORS
```

Store enough information for the user to understand what failed.

Do not silently discard failed parcels.

---

# 21. RETRIES

Retry only failures that are likely to be transient.

Examples:

```text
Redis temporary failure
Redis connection interruption
temporary network failure
```

Do not blindly retry:

```text
invalid parcel
invalid schema
business-rule rejection
```

Use:

```text
exponential backoff
+
jitter
+
maximum retry count
```

After retries are exhausted, transition the appropriate job/batch into a failed/dead-letter state.

---

# 22. DEAD-LETTER / FAILED JOB HANDLING

Implement a clear failure path.

Conceptually:

```text
Queue
 ↓
Worker
 ↓
failure
 ↓
retry
 ↓
retry
 ↓
max attempts reached
 ↓
failed/dead-letter state
```

The system should make failed jobs diagnosable.

Do not silently lose jobs.

---

# 23. PHASE 7 — RELIABILITY

Implement:

### Timeouts

Do not allow external/dependency calls to hang forever.

### Graceful shutdown

On shutdown:

```text
stop accepting new work
 ↓
finish/stop current processing safely
 ↓
close queue connections
 ↓
close Redis connection
 ↓
exit
```

### Health endpoints

Separate:

```text
liveness
readiness
```

Conceptually:

```text
/live
```

answers:

> Is the process alive?

```text
/ready
```

answers:

> Can this instance safely receive work?

Readiness should account for critical dependencies where appropriate.

---

# 24. FAULT-TOLERANCE MODEL

Do not claim that the system can never fail.

Instead, explicitly design for failure.

### Batch

Durable queue + persistent DB means:

```text
API crashes
    ↓
batch already persisted
    ↓
queue job remains
    ↓
worker can continue/retry
```

### Single request

Single parcel processing is synchronous.

Therefore, if the server dies before completing the request:

```text
request may fail
```

This is acceptable unless the business requires guaranteed eventual processing.

If guaranteed eventual processing for single parcels becomes a requirement, then single parcel can also become asynchronous:

```text
POST
 ↓
202
 ↓
job ID
 ↓
queue
 ↓
worker
```

But that changes the API semantics and should only be done when justified.

---

# 25. PHASE 8 — SECURITY

Implement security at boundaries.

## Validation

Never trust frontend validation.

Backend validation is authoritative.

## Input sanitization

Protect against injection attacks.

Do not confuse:

```text
sanitization
```

with:

```text
validation
```

Validation answers:

> Is this allowed?

Sanitization answers:

> Can this input be safely represented/processed?

## Body size limits

Prevent excessively large requests.

## Batch limits

Define sensible limits for:

* number of parcels
* request size
* processing size

## Rate limiting

Protect API endpoints from abuse.

## CORS

Understand that CORS is a browser security mechanism.

It is NOT authentication.

## Helmet

Use secure HTTP headers.

## Authentication

Not implemented: the assessment defines no users or accounts, so the API is
intentionally anonymous. Do not add JWT/sessions/login.

## Authorization

Not implemented: there are no users and no private batches, so there is
nothing to own or scope. Anonymous abuse is handled with rate limiting,
validation, request/body/batch limits, safe errors, and Redis isolation.

Prevent object-level authorization issues.

## Secrets

Never commit:

* Redis credentials
* API keys

Use environment variables/secrets management. Redis must not be publicly exposed.

---

# 26. PHASE 9 — OBSERVABILITY

Implement structured logging.

Every important operation should be traceable.

Useful IDs:

```text
requestId
batchId
parcelId
jobId
workerId
```

Example conceptual log:

```json
{
  "event": "parcel_routed",
  "requestId": "R123",
  "batchId": "B123",
  "parcelId": "P42",
  "department": "REGULAR"
}
```

Avoid logging:

* secrets
* sensitive data
* unnecessary full request bodies

---

# 27. METRICS

Track meaningful operational metrics.

Examples:

```text
HTTP request count
HTTP error count
request latency
batch processing duration
queue depth
jobs processed
jobs failed
jobs retried
validation failures
worker utilization
```

The goal is to answer:

```text
Is the system healthy?
Is work accumulating?
Are failures increasing?
Are workers keeping up?
```

---

# 28. BACKPRESSURE

Understand:

```text
incoming batch rate
        vs
worker processing rate
```

If:

```text
incoming > processing
```

queue depth increases.

The system should have limits and monitoring rather than accepting unlimited work.

Do not implement arbitrary infinite queues.

---

# 29. PHASE 10 — TESTING

Use multiple testing layers.

## Unit tests

Majority of domain tests should be here.

Test:

* validation
* individual rules
* routing engine
* department priority
* cumulative approvals
* boundary values
* explainability
* fail-closed behavior

Important boundaries:

```text
1kg
1.000...kg
10kg
10.000...kg
€1000
€1000.01
```

## Integration tests

Test:

```text
API
 ↓
domain
 ↓
Redis/queue boundaries
```

Use Supertest where appropriate.

## Batch tests

Test:

* batch creation
* queueing
* worker execution
* progress updates
* partial failures
* retries
* duplicate processing
* idempotency
* final state

## Regression tests

Every new rule must trigger tests for:

* the new rule
* existing rules
* boundary cases
* priority interactions
* approval interactions

---

# 30. RULE EVOLUTION

Adding a new rule should be safe.

Process:

```text
Add rule
 ↓
Assign stable ID
 ↓
Define priority/semantics
 ↓
Add unit tests
 ↓
Add interaction tests
 ↓
Run complete regression suite
 ↓
Review behavior
```

Never modify rules without testing the effect on existing routing behavior.

---

# 31. PHASE 11 — FRONTEND

Frontend responsibilities:

### Single parcel

```text
form
 ↓
POST /api/parcels
 ↓
immediate routing result
```

Display:

* department
* approvals
* reasons
* matched rules where appropriate

### Batch

```text
upload/input batch
 ↓
POST /api/batches
 ↓
receive batchId
 ↓
show queued
 ↓
poll status
 ↓
show progress
 ↓
show completed/errors
 ↓
fetch results
```

Example UI:

```text
Batch B123

Status: Processing

████████████░░░░░░░░ 62%

6,200 / 10,000 processed

Successful: 6,100
Failed:       100
```

When complete:

```text
COMPLETED
```

or:

```text
COMPLETED_WITH_ERRORS
```

Do not expose queue implementation details to the user.

The user should think in terms of:

```text
batch
progress
results
errors
```

not:

```text
Redis
BullMQ
worker
job acknowledgment
```

---

# 32. API CONTRACTS

Document clear API contracts.

Expected conceptual endpoints:

```text
POST   /api/parcels
POST   /api/batches
GET    /api/batches/:batchId
GET    /api/batches/:batchId/results
GET    /health/live
GET    /health/ready
```

Batch creation:

```text
202 Accepted
```

Single parcel:

```text
200 OK
```

Use consistent error responses.

---

# 33. REDIS TEMPORARY-STATE RESPONSIBILITIES

Temporary Redis state (TTL-expired, no permanent history) is responsible for
batch state while processing.

It should support:

```text
batch status
batch progress
parcel identity
routing results
idempotency
explainability
```

Redis temporary state is NOT being introduced simply because:

> "async systems require databases."

That is incorrect.

The correct reasoning is:

```text
Queue → durable work

Redis state → temporary batch/application state for the active session
```

A queue-only architecture can exist if there is no requirement to keep state/results.
This system keeps temporary batch state/results in Redis (TTL-expired) because
the worker, progress polling, and result display need them during processing —
not because history must be retained.

---

# 34. QUEUE VS REDIS STATE — MENTAL MODEL

Always preserve this distinction:

```text
QUEUE

"What work needs to happen?"

        vs

REDIS TEMPORARY STATE

"What happened / what is the current state?"
```

Example:

```text
Queue:
Process Batch B123

Redis state:
B123
10,000 total
6,200 processed
6,100 successful
100 failed
status = PROCESSING
```

---

# 35. COMPLETE REQUEST FLOWS

## Single parcel

```text
Client
  ↓
POST /api/parcels
  ↓
Validation
  ↓
Routing Engine
  ↓
Rules
  ↓
Result
  ↓
200 OK
  ↓
Client
```

## Batch

```text
Client
  ↓
POST /api/batches
  ↓
Validate batch
  ↓
Create B123 in DB
  ↓
Queue { batchId: B123 }
  ↓
202 Accepted
  ↓
Client receives B123
```

Then:

```text
Queue
  ↓
Worker
  ↓
Load batch
  ↓
Process parcel
  ↓
Validate
  ↓
Routing Engine
  ↓
Rules
  ↓
Persist result
  ↓
Update batch progress
```

Meanwhile:

```text
Frontend
   ↓
GET /api/batches/B123
   ↓
DB
   ↓
progress
```

Eventually:

```text
status = COMPLETED
```

or:

```text
status = COMPLETED_WITH_ERRORS
```

Then:

```text
GET /api/batches/B123/results
```

---

# 36. PHASE 12 — FINAL ENGINEERING REVIEW

Before declaring the project complete, verify:

### Architecture

* [ ] Domain is framework-independent
* [ ] Same routing engine used everywhere
* [ ] Queue contains no business logic
* [ ] Worker owns asynchronous execution
* [ ] Single parcel remains synchronous
* [ ] Batch is asynchronous
* [ ] Redis owns temporary state (TTL-expired, no permanent history)
* [ ] Queue owns durable work

### Correctness

* [ ] Routing rules correct
* [ ] Department priority correct
* [ ] Approval rules cumulative
* [ ] Boundary cases tested
* [ ] Fail-closed behavior implemented
* [ ] Explainability preserved

### Batch

* [ ] 202 response
* [ ] batchId (full UUID, unpredictable)
* [ ] temporary batch state (TTL-expired)
* [ ] worker
* [ ] queue
* [ ] progress
* [ ] partial failures
* [ ] result retrieval
* [ ] idempotency
* [ ] duplicate protection

### Reliability

* [ ] retries
* [ ] exponential backoff
* [ ] retry limits
* [ ] failed/dead-letter handling
* [ ] graceful shutdown
* [ ] health checks
* [ ] readiness checks
* [ ] timeouts

### Security

* [ ] strict validation
* [ ] body limits
* [ ] batch limits
* [ ] rate limiting
* [ ] Helmet
* [ ] CORS correctly configured
* [ ] no authentication by design (anonymous public API; abuse handled via the above)
* [ ] secrets protected
* [ ] Redis not publicly exposed
* [ ] safe error responses

### Observability

* [ ] structured logs
* [ ] request IDs
* [ ] batch IDs
* [ ] job IDs
* [ ] worker IDs
* [ ] useful metrics
* [ ] queue depth monitoring

### Testing

* [ ] unit tests
* [ ] integration tests
* [ ] API tests
* [ ] worker tests
* [ ] idempotency tests
* [ ] retry tests
* [ ] regression tests
* [ ] failure-path tests

---

# 37. IMPLEMENTATION DISCIPLINE

Implement the project **phase by phase**.

After every phase:

1. Run tests.
2. Run build.
3. Start the application if appropriate.
4. Perform relevant manual verification.
5. Inspect `git diff`.
6. Check for accidental changes.
7. Explain what changed.
8. Explain why it changed.
9. Identify remaining risks.
10. Only then continue.

If a phase breaks existing functionality:

> STOP and fix it before proceeding.

Do not silently continue with a broken baseline.

---

# 38. DO NOT OVER-ENGINEER

This project is intended for an assessment.

Prefer:

```text
simple + correct + explainable
```

over:

```text
complex + theoretically scalable + difficult to explain
```

Do NOT introduce unnecessary:

* microservices
* Kafka
* Kubernetes
* distributed tracing infrastructure
* event sourcing
* CQRS
* complex caching
* multiple databases

unless a concrete requirement justifies them.

A strong implementation for this project is:

```text
React
   ↓
Express
   ↓
Domain Core
   ↓
Response

Batch:
Express
   ↓
Queue
   ↓
Worker
   ↓
Domain Core
   ↓
Redis state/results (TTL)
```

---

# 39. INTERVIEW-ORIENTED IMPLEMENTATION

While implementing, maintain a short engineering explanation for every major decision.

For each important component, be able to answer:

### Why?

Why does this component exist?

### Why here?

Why does this logic belong in this layer?

### Why not another approach?

What alternative was considered?

### Failure?

What happens if it fails?

### Scale?

What happens when load increases?

### Consistency?

What prevents incorrect or duplicate state?

### Testing?

How do we prove it works?

### Tradeoff?

What complexity did we deliberately avoid?

The final implementation should allow the candidate to explain the architecture confidently in a **10–15 minute presentation**.

---

# 40. FINAL PRESENTATION STORY

The final presentation should be explainable as:

```text
1. Problem
   ↓
2. Domain model
   ↓
3. Rule engine
   ↓
4. Synchronous single-parcel processing
   ↓
5. Why batches need asynchronous processing
   ↓
6. Queue + worker architecture
   ↓
7. Redis temporary state/results (TTL-expired)
   ↓
8. Idempotency and duplicate handling
   ↓
9. Progress tracking
   ↓
10. Security
   ↓
11. Reliability
   ↓
12. Observability
   ↓
13. Testing
   ↓
14. Tradeoffs and future improvements
```

The key architectural sentence to remember is:

> **Single parcels are processed synchronously through the shared domain core, while batches are durably queued and processed asynchronously by workers using that exact same domain core. The queue manages work, Redis holds temporary state and results, and the API exposes progress and results to the frontend.**

---

## IMPLEMENTATION ORDER

Follow this exact order:

```text
Phase 0   → Baseline audit
Phase 1   → Domain core
Phase 2   → Validation/API boundary
Phase 3   → Single parcel
Phase 4   → Batch architecture
Phase 5   → Persistent batch state
Phase 6   → Queue
Phase 7   → Worker
Phase 8   → Batch API + progress
Phase 9   → Idempotency + failure handling
Phase 10  → Reliability
Phase 11  → Security
Phase 12  → Observability
Phase 13  → Testing + regression
Phase 14  → Frontend integration
Phase 15  → Final architecture review
Phase 16  → Presentation/interview preparation
```

**Do not jump ahead. Complete and verify each phase before moving to the next.**
