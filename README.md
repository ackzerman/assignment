# Parcel Routing System

An internal parcel routing system that processes parcels and routes them to the appropriate department based on configurable business rules.

## Project Structure

```
assignment/
├── backend/                  # Node.js + Express + TypeScript API
│   ├── src/
│   │   ├── domain/           # Pure business logic (no framework dependencies)
│   │   │   ├── parcel.ts     # Parcel domain model & types
│   │   │   └── validation.ts # Input validation logic
│   │   ├── errors/           # Custom error classes
│   │   │   └── AppError.ts   # AppError, ValidationFailedError
│   │   ├── api/
│   │   │   ├── routes/       # Express route handlers (thin HTTP layer)
│   │   │   └── middleware/   # Error handling, etc.
│   │   ├── app.ts            # Express app configuration
│   │   └── index.ts          # Server entry point
│   └── tests/
│       └── domain/           # Unit tests for domain logic
│           └── validation.test.ts
├── frontend/                 # React + Vite + TypeScript UI
└── MASTER_PROMPT.md          # Assessment specification
```

## Quick Start

### Backend

```bash
cd backend
npm install
npm run dev        # Start development server (port 3001)
npm test           # Run tests
```

### Frontend

```bash
cd frontend
npm install
npm run dev        # Start development server (port 5173)
```

## Architecture Decisions

### Domain Layer Separation
The core business logic (parcel model, validation, routing rules) lives in `src/domain/` with **zero dependencies** on Express, React, or any framework. This ensures:
- Business logic can be tested without HTTP
- Easy to reason about routing rules in isolation
- Supports the debugging requirement (interview scenario)

### Validation Strategy
- All fields validated independently, collecting **all** errors at once
- Operators see every problem in one response, not one at a time
- Pure functions with no side effects — easy to test and extend

### Error Handling
- `AppError`: distinguishes operational errors (user mistakes) from programming errors (bugs)
- `ValidationFailedError`: carries structured field-level errors for the UI
- Error middleware centralizes response formatting

## How to Run

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend (in a new terminal)
cd frontend
npm install
npm run dev
```

## How to Test

```bash
cd backend
npm test           # Run all tests
npm run test:watch # Watch mode
```
