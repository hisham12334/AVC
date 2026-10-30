# Test Plan

## Phase 0 checks

CI runs frozen dependency install, formatting check, ESLint, TypeScript checks, Vitest and production build. API injection tests cover liveness and both ready/unavailable database outcomes. Migration validation needs PostgreSQL and detects pending, changed or missing applied migration files.

## Milestone 1A coverage

Vitest integration tests connect to a dedicated PostgreSQL test database named in `TEST_DATABASE_URL`; they apply and validate migrations, truncate only AVC tables in that test database, and use invented staff/customer records. Tests cover unauthenticated/invalid tokens, role denial, customer/vehicle lookup and duplicate checks, relationship integrity, job creation, audit immutability, stale and invalid commands, and error responses. CI starts PostgreSQL 17 for these tests. The local run used PostgreSQL 18.

## Later coverage

- Unit tests for lifecycle guards, amounts/VAT rounding and permission decisions.
- PostgreSQL integration tests for later domain constraints, idempotency and concurrent version conflicts.
- API tests for denied access and error contract, using invented fixture data.
- Upload/offline tests for retry, checksum, duplicate events and stale inspection conflict.
- Zoho test-organization contract tests and failure/retry/reconciliation tests once credentials exist.
- Browser accessibility and key workflow tests after screens exist.

Never use real customer data in tests. Production release gates also need backup/restore and security review; deployment target is not yet selected.
