# Parcel Routing System

A public parcel routing system that processes parcels and routes them to the appropriate department based on configurable business rules. No user accounts: single parcels route synchronously, batches process asynchronously via BullMQ + Redis with temporary (TTL-expired) state.

> 📘 **Comprehensive Architectural & Engineering Decisions**: For an in-depth breakdown of every design decision, trade-off matrix, alternatives considered, and interview talking points, see [ENGINEERING_DECISIONS.md](./ENGINEERING_DECISIONS.md).

## Tech Stack

- **Backend:** Node.js + Express (JavaScript)
- **Queue + temporary state:** BullMQ + Redis (`ioredis`)
- **Frontend:** React + Vite (JavaScript)
- **Testing:** Jest (backend suite, Redis state via `ioredis-mock`)

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
npm test           # Run 195 automated tests
```

### Frontend

```bash
cd frontend
npm install
npm run dev        # Start development server (port 5173)
```

## API Contracts

| Method | Endpoint | Meaning |
|---|---|---|
| `POST` | `/api/parcels` | Single parcel, sync, `200` + `{ parcelId, department, approvals, matchedRules, reasons }` |
| `POST` | `/api/batches` | Create batch, async, `202` + `{ batchId, status: QUEUED }` (full-UUID `BATCH-<uuid>`) |
| `GET` | `/api/batches/:batchId` | Poll progress `{ status, total, processed, successful, failed, progress }` (404 when unknown/expired) |
| `GET` | `/api/batches/:batchId/results` | Temporary results, paginated (`?limit&offset`, limit capped server-side) |
| `GET` | `/health/live` | Liveness: is the process alive? |
| `GET` | `/health/ready` | Readiness: Redis + queue reachable? |
| `GET` | `/api/metrics` | Counters: HTTP, routing, jobs, queue depth, latencies |

Legacy alias kept: `POST /api/parcels/route` (single). There is exactly one batch implementation (`POST /api/batches` → BullMQ → worker).

## Configuration (`backend/.env.example`)

- `REDIS_URL` (preferred) or `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` — BullMQ queue + temporary batch state. Redis is never publicly exposed (localhost/private network + password in production).
- `BATCH_TTL_SECONDS` (default `86400`) — temporary batch state lifetime; no permanent batch history is retained.
- `RESULTS_MAX_LIMIT` (default `1000`) — max results per results request; the UI paginates.
- `MAX_QUEUE_DEPTH` (default `100`) — backpressure limit; over-limit `POST /api/batches` → `429 + Retry-After`.
- `BATCH_CHUNK_SIZE` (default `500`) — parcels per worker recovery checkpoint.
- `CHUNK_LEASE_MS` (default `300000`) — chunk claim lease; stale `PROCESSING` chunks become reclaimable after expiry.

Mental model: **BullMQ = durable work ("what needs to happen"), Redis batch state = temporary progress/results ("what happened", TTL-expired).** Chunk checkpoints (`PENDING → PROCESSING → DONE`, atomic `SET NX PX` claim) are the recovery optimization — retries skip `DONE` work. Parcel-level `HSETNX` result writes are the final idempotency safeguard. Duplicate computation is minimized but not mathematically eliminated under a crash occurring between computation and checkpoint.

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
