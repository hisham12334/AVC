# API Contracts

## Implemented

Public process checks:

- `GET /health/live` → 200 `{ "status": "ok" }`.
- `GET /health/ready` → 200 with `database: reachable`, or 503 when PostgreSQL cannot be queried.
- `GET /api/auth/status` → whether a token-verification adapter is installed. The deployed default reports `configured: false`.

All other routes require a verified bearer token mapped by its subject to an active `avc.staff_members` record. The production adapter is intentionally unconfigured until AVC selects an OIDC provider. Test-only verifier injection does not enable live sign-in.

Only `lounge_manager` may use Milestone 1A customer, vehicle and job routes. This follows the named SRS role while the advisor/manager split is unresolved.

| Route                                           | Request                                                              | Result                                                                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/staff/me`                             | Bearer token                                                         | Staff ID, subject, display name and role.                                                                                                   |
| `GET /api/customers?query=...`                  | At least 2 characters                                                | Up to 20 matching customers by name or normalized mobile.                                                                                   |
| `POST /api/customers`                           | `fullName`, `mobileNumber`                                           | 201 customer. Exact normalized mobile + case-insensitive name match yields 409 possible duplicate. Mobile is not globally unique.           |
| `GET /api/vehicles?query=...`                   | At least 2 characters                                                | Up to 20 matches by VIN, plate, make or model.                                                                                              |
| `POST /api/vehicles`                            | `customerId`, `make`, `model`, VIN and/or plate; optional year/color | 201 vehicle. VIN is unique when present; same-customer plate or matching VIN yields 409 possible duplicate. Plates are not globally unique. |
| `POST /api/jobs/intake`                         | `customerId`, `vehicleId`, `mileageKm`, `intakeCondition`            | 201 job at Jumeirah in `intake_open`, version 1, and `job_created` event in one transaction.                                                |
| `POST /api/jobs/{id}/commands/start-inspection` | `expectedVersion`                                                    | Starts inspection only from `intake_open` with matching version; appends `inspection_started` event atomically.                             |
| `GET /api/jobs`                                 | None                                                                 | Latest 100 job summaries for the operational board.                                                                                         |
| `GET /api/jobs/{id}`                            | Job UUID                                                             | Job intake detail and ordered audit events.                                                                                                 |

There is no unrestricted `PATCH /jobs/{id}` route. Invalid input returns 400; missing token 401; inactive or unauthorized staff 403; missing job 404; duplicate or stale version 409; invalid relationship/transition 422; unconfigured verifier 503. Errors use `{ "error": { "code": "...", "message": "..." } }` and omit internal traces.

## Quotes, approval, evidence and branches (migration 0003)

Staff routes need a bearer token and the permission in `identity/permissions.ts`. Every state change takes `expectedVersion`, bumps the job version and appends one audit event (`actorType` is `staff`, `customer` or `system`).

| Route                                  | Who                            | Behaviour                                                                                                                                                                                     |
| -------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/jobs/{id}/evidence`         | lounge manager, tech, workshop | Registers photo/video/signature/document metadata (`storageKey`, optional `contentSha256`). Bytes go to object storage, which is not built yet.                                               |
| `POST /api/jobs/{id}/quotes`           | lounge manager                 | From `inspection` only. Items have `severity` critical/moderate/minor and `priceAed`. Critical and moderate items need photo/video evidence. Moves the job to `quote`; returns the link once. |
| `POST /api/jobs/{id}/findings`         | lounge manager, tech, workshop | Addendum quote while `approved`/`in_bay`/`qc`. Stage is unchanged but the job cannot advance until the customer answers. One open quote per job.                                              |
| `GET /api/jobs/{id}/quotes`            | quotes:read                    | All quote versions with items, decisions and evidence.                                                                                                                                        |
| `POST /api/jobs/{id}/customer-links`   | lounge manager                 | Re-issues the tracking link (shown once) and revokes earlier ones.                                                                                                                            |
| `POST /api/jobs/{id}/commands/advance` | lounge manager, workshop       | `approved→in_bay→qc→ready→delivered`. Refused while a quote awaits the customer.                                                                                                              |
| `GET /api/dashboard/summary?branchId=` | dashboard:read                 | Active cars, capacity, per-stage counts, aging buckets, awaiting approval, paused for finding, delivered MTD, approved value today/MTD (booked work, not invoiced revenue).                   |
| `GET/POST /api/branches`               | all staff / admin              | Branches scope jobs, bays and KPIs. Staff with a `branch_id` see only that branch; NULL sees all. Intake needs `branchId` once more than one branch is active.                                |

Customer routes need no login. The unguessable link token is the credential for one job: only its SHA-256 is stored, it expires after 30 days, responses are `no-store`, and unknown, expired and revoked links all return the same 404.

- `GET /api/track/{token}` returns stage, vehicle, open quote, decided quotes, `workPaused` and a customer-safe timeline. No storage keys, mobile numbers or staff names.
- `POST /api/track/{token}/decisions` with `{ quoteId, quoteVersion, decisions: [{ itemId, decision }] }` must answer every item. A wrong version gives 409 `QUOTE_VERSION_MISMATCH` and a second submission gives 409 `QUOTE_ALREADY_DECIDED`. An initial quote with any approval moves the job to `approved` (the start line); rejecting everything moves it to `ready` for collection. An addendum never changes the stage.

## Zoho-ready integration

Domain changes write `avc.outbox_events` in the same transaction: `customer.created`, `vehicle.created`, `job.created`, `job.stage_changed`, `quote.sent`, `quote.decided`. Nothing is pushed inline, and there is no Zoho client yet.

- `GET /api/integration/events?cursor=&limit=&types=a,b` with `Authorization: Bearer avck_…` (scope `events:read`) returns `{ events: [{ id, cursor, type, occurredAt, branch, aggregate, data }], nextCursor }`. Cursors are `txid.seq` and only expose events from finished transactions, so a late commit is never skipped. Dedupe on `id`.
- Admin routes: `POST/GET/DELETE /api/integration/api-keys` (secret shown once, hash stored) and `POST/GET/DELETE /api/integration/webhooks`. Webhook URLs must be public `https://` on port 443 without credentials.
- Webhook delivery (`dispatchWebhooks`) is at-least-once and ordered per endpoint. It signs the body with `AVC-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "t.body")>`, retries with backoff and stops at the first failure. It runs only when `WEBHOOK_DISPATCH_INTERVAL_MS` is set. The signing secret is stored as plain text and needs a secrets manager or column encryption before production. Webhook URL checks are lexical, so add an egress proxy that blocks internal DNS targets.

## Not implemented

DVI checklist, media upload and storage, customer OTP verification, transfers, QC sign-off, finance, notifications and the Zoho CRM client remain design targets. They must use versioned explicit commands, permission checks, transactions and append-only events. No endpoint implies that a QR or job ID authenticates a user. An OIDC provider and browser sign-in flow must be selected and verified before the staff UI can operate on live records.
