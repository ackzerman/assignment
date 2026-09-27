# Parcel Routing System

An internal parcel routing system that processes parcels and routes them to the appropriate department based on configurable business rules.

> 📘 **Comprehensive Architectural & Engineering Decisions**: For an in-depth breakdown of every design decision, trade-off matrix, alternatives considered, and interview talking points, see [ENGINEERING_DECISIONS.md](./ENGINEERING_DECISIONS.md).

## Tech Stack

- **Backend:** Node.js + Express (JavaScript)
- **Frontend:** React + Vite (JavaScript)
- **Testing:** Jest (72 tests passing, 100% domain boundary coverage)

## Project Structure

```
assignment/
├── backend/                  # Node.js + Express API
│   ├── src/
│   │   ├── domain/           # Pure business logic (zero framework dependencies)
│   │   │   ├── parcel.js     # Parcel domain model documentation
│   │   │   ├── validation.js # Input validation logic & country code set
│   │   │   ├── rules.js      # Business rules configuration (departments & approvals)
│   │   │   └── routingEngine.js # Pure evaluation engine
│   │   ├── errors/           # Custom error classes
│   │   │   └── AppError.js   # AppError, ValidationFailedError
│   │   ├── api/
│   │   │   ├── routes/       # Express route handlers (thin HTTP layer)
│   │   │   │   └── parcelRoutes.js
│   │   │   └── middleware/   # Centralized error handling
│   │   ├── app.js            # Express app configuration (testable without server)
│   │   └── index.js          # Server entry point
│   └── tests/
│       └── domain/           # Unit tests for domain logic
│           ├── validation.test.js    # 40 validation tests
│           └── routingEngine.test.js # 32 routing engine & boundary tests
├── frontend/                 # React + Vite UI
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
npm test           # Run 167 automated tests
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
| `POST` | `/api/batches` | Create batch, async, `202` + `{ batchId, status: QUEUED }` |
| `GET` | `/api/batches/:batchId` | Poll progress `{ status, total, processed, successful, failed, progress }` |
| `GET` | `/api/batches/:batchId/results` | Persisted results (paginated `?limit&offset`) |
| `GET` | `/health/live` | Liveness: is the process alive? |
| `GET` | `/health/ready` | Readiness: DB + queue reachable? |
| `GET` | `/api/metrics` | Counters: HTTP, routing, jobs, queue depth, latencies |

Legacy aliases kept: `POST /api/parcels/route` (single), `POST /api/parcels/batch` (async alias of `POST /api/batches`, returns `202`).

## Configuration (`backend/.env.example`)

- `API_TOKENS` — optional Bearer tokens; when set, batches are owned and cross-owner reads → `403`.
- `MAX_QUEUE_DEPTH` (default `100`) — backpressure limit; over-limit `POST /api/batches` → `429 + Retry-After`.
- `REDIS_HOST` / `REDIS_PORT` — BullMQ durable queue; retries `3` with exponential backoff `1s→2s→4s`.
- `BATCH_CHUNK_SIZE` (default `500`) — parcels per worker recovery checkpoint.
- `CHUNK_LEASE_MS` (default `300000`) — chunk claim lease; stale `PROCESSING` chunks become reclaimable after expiry.
- Queue payload is `{ batchId }` only; worker loads data from DB. Results protected by `UNIQUE(batch_id, parcel_id)` (final idempotency safeguard); chunk checkpoints (`PENDING → PROCESSING → DONE`) are the recovery optimization. **Redis/BullMQ = durable work, database = durable state and results.**

## Core Architecture Decisions Summary

- **Pure Domain Core (Clean Architecture Lite):** Business logic (`validation.js`, `routingEngine.js`, `rules.js`) has **zero dependencies** on Express or external libraries. Pure functions allow testing without HTTP servers or mocks.
- **Declarative Rule Objects & Injected Evaluator:** Rules in `rules.js` are separated from the engine in `routingEngine.js`. Adding a new department or approval rule touches only configuration, honoring the Open-Closed Principle.
- **Bifurcated Rule Semantics:**
  - *Department Rules:* First-match-wins sorted by explicit priority (models physical sorting bins).
  - *Approval Rules:* Accumulate all matches (models policy and compliance requirements like Insurance).
- **Error Accumulation:** Input validation checks all fields simultaneously so operators see every issue at once.
- **Fail-Closed Safety:** If parcel attributes fall into an unmapped gap, the engine throws an invariant error rather than silently misrouting physical packages.

*For full alternative comparisons and trade-offs, read [ENGINEERING_DECISIONS.md](./ENGINEERING_DECISIONS.md).*
