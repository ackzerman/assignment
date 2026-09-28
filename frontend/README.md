# Parcel Routing Frontend

React + Vite operator UI for the Parcel Routing System (see root `README.md` for the full picture).

## What it does

- **Single Parcel tab** — form → `POST /api/parcels` → routing decision with department badge, approval badges, and reasons.
- **Batch Upload tab** — JSON file (≤ 9 MB, below the server's ~10 MB body limit) → `POST /api/batches` with a per-submission `Idempotency-Key` → circular progress indicator while polling → paginated results (200 rows per page) with Total/Routed/Failed summary cards.
- Operator text never exposes internals: `COMPLETED_WITH_ERRORS` renders as `Batch completed · 100%`, batch UUIDs stay out of the UI (used internally for API calls only).

## Scripts

```bash
npm install
npm run dev      # Start development server (port 5173, proxies /api → localhost:3001)
npm test         # Run Vitest unit tests (jsdom)
npm run lint     # oxlint, zero warnings
npm run build    # Production build to dist/
```

## Key modules

- `src/api.js` — all backend calls (single route, batch create, cancellable status polling, paginated results, countries). Aborts are silent, never errors.
- `src/components/BatchUpload.jsx` — drag-and-drop + file input, client-side parse, `AbortController` + `FileReader` lifecycle guards, Cancel action.
- `src/components/BatchResults.jsx` — summary cards, per-page filters, paginated table, collapsible detail panels with generic `ApprovalItem` badges.
- `src/approvals.js` — data-driven approval normalization + deterministic badge colors (future types work with no changes).
- `src/pagination.js` — `PAGE_SIZE = 200`, page count/clamp/offset helpers.
