# Parcel Routing System

A public parcel routing system that processes parcels and routes them to the appropriate department based on configurable business rules. No user accounts: single parcels route synchronously, batches process asynchronously via BullMQ + Redis with temporary (TTL-expired) state.

> 📘 **Comprehensive Architectural & Engineering Decisions**: For an in-depth breakdown of every design decision, trade-off matrix, alternatives considered, and interview talking points, see [ENGINEERING_DECISIONS.md](./ENGINEERING_DECISIONS.md).

## Tech Stack

- **Backend:** Node.js + Express (JavaScript)
- **Queue + temporary state:** BullMQ + Redis (`ioredis`)
- **Frontend:** React + Vite (JavaScript)
- **Testing:** Jest (backend, 28 suites / 380 tests, Redis state via `ioredis-mock`) + Vitest (frontend, 9 files / 66 tests, jsdom)

## Project Structure

```
assignment/
├── backend/                  # Node.js + Express API
│   ├── src/
│   │   ├── domain/           # Pure business logic (zero framework dependencies)
│   │   │   ├── parcel.js     # Parcel domain model documentation
│   │   │   ├── validation.js # Input validation logic & full ISO country set
│   │   │   ├── rules.js      # Business rules configuration (departments & approvals)
│   │   │   ├── routingEngine.js # Pure evaluation engine
│   │   │   └── batchProcessor.js # Batch envelope validation (no runtime processing)
│   │   ├── errors/           # Custom error classes
│   │   │   └── AppError.js   # AppError, ValidationFailedError
│   │   ├── infrastructure/   # Queue + worker + Redis state
│   │   │   ├── queue.js      # BullMQ queue (payloads are { batchId } only)
│   │   │   ├── redis.js      # Shared Redis client (lazy connect, env config)
│   │   │   ├── batchStore.js # Temporary batch state: checkpoints + results (TTL)
│   │   │   └── worker.js     # BullMQ consumer: claim chunk → route → checkpoint
│   │   ├── api/
│   │   │   ├── routes/       # Express route handlers (thin HTTP layer)
│   │   │   │   ├── parcelRoutes.js # Single-parcel endpoints
│   │   │   │   └── batchRoutes.js  # Async batch endpoints (single implementation)
│   │   │   └── middleware/   # Security, logging, error handling (no auth)
│   │   ├── observability/    # Structured logs, metrics, anomaly detection
│   │   ├── app.js            # Express app configuration (testable without server)
│   │   └── index.js          # Server entry point
│   └── tests/                # Jest suites (domain, batch, api, security, observability)
├── frontend/                 # React + Vite UI (paginated batch results)
├── ENGINEERING_DECISIONS.md  # Comprehensive architecture decisions & trade-offs
├── MASTER_PROMPT.md          # Technical assessment specification
└── README.md
```

## Quick Start

### Backend

```bash
cd backend
npm install
npm run dev        # Start development server (port 3001)
npm test           # Run 380 automated backend tests (28 suites)
```

### Frontend

```bash
cd frontend
npm install
npm run dev        # Start development server (port 5173)
npm test           # Run 66 frontend unit tests (vitest: pagination, API client, components)
```

## API Contracts

| Method | Endpoint | Meaning |
|---|---|---|
| `POST` | `/api/parcels` | Single parcel, sync, `200` + `{ parcelId, department, approvals, matchedRules, reasons }` |
| `POST` | `/api/parcels/validate` | Validate only (no routing), `200` + `{ parcel }` or `400` field errors |
| `GET` | `/api/parcels/countries` | Full ISO 3166-1 alpha-2 country list for the UI dropdown |
| `POST` | `/api/batches` | Create batch, async, `202` + `{ batchId, status: QUEUED }` (full-UUID `BATCH-<uuid>`) |
| `GET` | `/api/batches/:batchId` | Poll progress `{ status, total, processed, successful, failed, progress }` (404 when unknown/expired) |
| `GET` | `/api/batches/:batchId/results` | Temporary results, paginated (`?limit&offset`, strictly validated, limit capped server-side, malformed values → `400`) |
| `GET` | `/health/live` | Liveness: is the process alive? (excluded from metrics/logs) |
| `GET` | `/health/ready` | Readiness: Redis + queue reachable? (excluded from metrics/logs) |
| `GET` | `/api/health` | Legacy liveness alias, `200` + `{ status: ok }` |
| `GET` | `/api/health/detailed` | Anomaly status + current metrics snapshot |
| `GET` | `/api/metrics` | Counters: HTTP, routing, jobs, queue depth, job-execution vs terminal-batch latencies |

Legacy alias kept: `POST /api/parcels/route` (single). There is exactly one batch implementation (`POST /api/batches` → BullMQ → worker). Requests over the 10 MB JSON body limit get `413` (never `500`).

## Configuration (`backend/.env.example`)

- `REDIS_URL` (preferred) or `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` — BullMQ queue + temporary batch state. Redis is never publicly exposed (localhost/private network + password in production).
- Rate limiting (independent windows; invalid values fall back safely):
  - `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` (defaults `900000` / `300`) — general API, 300 / 15 min.
  - `BATCH_RATE_LIMIT_WINDOW_MS` / `BATCH_RATE_LIMIT_MAX` (defaults `600000` / `30`) — batch creation only, 30 / 10 min.
  - `POLLING_RATE_LIMIT_WINDOW_MS` / `POLLING_RATE_LIMIT_MAX` (defaults `900000` / `1200`) — batch status/results polling, 1200 / 15 min (never consumes the general budget).
- `BATCH_TTL_SECONDS` (default `86400`) — temporary batch state lifetime; no permanent batch history is retained.
- `RESULTS_MAX_LIMIT` (default `1000`) — max results per results request; the UI paginates. Pagination is a deliberate bounded tradeoff: pages are served from the in-Redis results hash (bounded by this cap and the 10,000-parcel batch limit), preserving stable index ordering without cursor infrastructure.
- `MAX_QUEUE_DEPTH` (default `100`) — backpressure limit; over-limit `POST /api/batches` → `429 + Retry-After`.
- `BATCH_CHUNK_SIZE` (default `500`) — parcels per worker recovery checkpoint.
- `CHUNK_LEASE_MS` (default `300000`) — chunk claim lease; stale `PROCESSING` chunks become reclaimable after expiry.
- `RECOVERY_GRACE_MS` / `RECOVERY_INTERVAL_MS` (defaults `60000` / `60000`) — orphan reconciliation: old `QUEUED` batches with no queue job are re-enqueued, periodically while running.
- Upload sizes: the UI caps files at 9 MB, deliberately below the server's ~10 MB JSON body limit (the `{"parcels": [...]}` envelope adds bytes); the backend remains authoritative.
- Production CORS allows `Content-Type`, `Idempotency-Key`, and `X-Request-ID` from the configured `CORS_ORIGINS` allowlist (never `*`).

Mental model: **BullMQ = durable work ("what needs to happen"), Redis batch state = temporary progress/results ("what happened", TTL-expired).** Chunk checkpoints (`PENDING → PROCESSING → DONE`) are the recovery optimization — retries skip `DONE` work. Each claim mints a unique ownership token; checkpoint/release commit only when the lock still holds the caller's token (atomic Lua scripts), so a stale worker can never overwrite another worker's chunk. Batch status itself is a guarded state machine (`QUEUED → PROCESSING → COMPLETED / COMPLETED_WITH_ERRORS`, `QUEUED / PROCESSING → FAILED`): `QUEUED → PROCESSING` is atomic, so a stale worker can never resurrect a terminal batch, and terminal states are final. `Idempotency-Key` claims carry ownership tokens — only the claim owner may complete or clean up its record. Orphaned `QUEUED` batches (crash between state creation and enqueue) are re-enqueued by startup + periodic reconciliation once past the grace period. Parcel-level `HSETNX` result writes are the final idempotency safeguard. Duplicate computation is minimized but not mathematically eliminated under a crash occurring between computation and checkpoint (at-least-once processing with idempotent commits — never exactly-once execution).

## Batch Result Contract

`GET /api/batches/:batchId/results` returns the single canonical representation the UI renders — one object per parcel:

```json
{
  "parcelId": "P1",
  "index": 0,
  "status": "routed",
  "department": "Regular",
  "requiresApproval": true,
  "approvals": [{ "type": "Insurance", "reason": "..." }],
  "matchedRules": ["department.regular", "approval.insurance"],
  "reasons": ["..."],
  "errors": null,
  "inputSummary": { "weight": 5, "value": 2000, "destinationCountry": "DE" }
}
```

`status` is `routed` or `invalid` (validation failures carry `errors` + `inputSummary`; unexpected system failures never become parcel rows — the job fails and BullMQ retries). Parcel IDs are final at submission: missing IDs are generated as `P{index+1}` first, then uniqueness is enforced across all IDs, so generated and explicit IDs can never collide.

## Observability & Alerting Scope

Current: structured JSON logs (request/batch/parcel/job/worker IDs), in-memory operational metrics (`GET /api/metrics` — per-execution job durations kept separate from terminal start→terminal batch durations, recorded exactly once by the transition winner), anomaly detection surfaced via `GET /api/health/detailed`, and liveness/readiness probes. In-memory metrics reset on process restart by design. No active notifications are sent — there is no Slack/email/PagerDuty integration.

Production extension: connect the anomaly detector and critical-error log signals to an external alerting channel. Deliberately out of scope for this assessment.

## Business Rules

- Departments: `weight ≤ 1kg → Mail`, `≤ 10kg → Regular`, `> 10kg → Heavy` (first match wins).
- Original requirement: `value > €1000 → Insurance` approval.
- Additional demonstration rule (safe-evolution example, not an original requirement): `value > €5000 → Manual Review`. See `ENGINEERING_DECISIONS.md` Decision 15.

## Core Architecture Decisions Summary

- **Pure Domain Core (Clean Architecture Lite):** Business logic (`validation.js`, `routingEngine.js`, `rules.js`) has **zero dependencies** on Express or external libraries. Pure functions allow testing without HTTP servers or mocks.
- **Declarative Rule Objects & Injected Evaluator:** Rules in `rules.js` are separated from the engine in `routingEngine.js`. Adding a new department or approval rule touches only configuration, honoring the Open-Closed Principle.
- **Bifurcated Rule Semantics:**
  - *Department Rules:* First-match-wins sorted by explicit priority (models physical sorting bins).
  - *Approval Rules:* Accumulate all matches (models policy and compliance requirements like Insurance).
- **Error Accumulation:** Input validation checks all fields simultaneously so operators see every issue at once.
- **Fail-Closed Safety:** If parcel attributes fall into an unmapped gap, the engine throws an invariant error rather than silently misrouting physical packages.

*For full alternative comparisons and trade-offs, read [ENGINEERING_DECISIONS.md](./ENGINEERING_DECISIONS.md).*
