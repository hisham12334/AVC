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

## Job flow: findings, pricing, approval, delivery (migrations 0003 and 0004)

Stages in order: `pickup` (only for concierge pickups), `intake`, `inspection`, `pricing`, `quote`, `approved`, `in_bay`, `qc`, `ready`, `delivered`. Staff routes need a bearer token and the permission in `identity/permissions.ts`. Every staff state change takes `expectedVersion`, bumps the job version and appends one audit event (`actorType` is `staff`, `customer` or `system`).

| Route                                         | Who                                  | Behaviour                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/customers`                         | lounge manager, workshop             | Needs `email`. Creates the portal profile (starting password = mobile number, hashed) and returns the profile QR/link once. `POST /api/customers/{id}/profile-link` replaces it.                                                                          |
| `POST /api/jobs/intake`                       | lounge manager, workshop             | `arrivalMethod` pickup or walk_in (pickup needs `pickup.address`), `returnMethod` delivery or collect, optional `leadSource`. Pickup jobs start at `pickup` with a scheduled driver leg.                                                                  |
| `POST /api/jobs/{id}/evidence`                | lounge, workshop, technician, driver | Registers photo/video/signature/document metadata (`storageKey`, optional `contentSha256`). File bytes go to object storage, which is not built yet.                                                                                                      |
| `POST /api/jobs/{id}/inspection/submit`       | technician, workshop, lounge         | `findings` have a title, detail, severity and evidence, and no price. Critical and moderate findings need a photo or video. Moves the job to `pricing`; the customer sees only "inspection complete".                                                     |
| `GET /api/jobs/{id}/findings`                 | technician, workshop, lounge, admin  | Findings with evidence and no prices.                                                                                                                                                                                                                     |
| `POST /api/jobs/{id}/quotes`                  | lounge manager (advisor)             | Prices the open findings: each line is a `findingId` (severity and proof come from the finding) or an advisor line (always minor). Every finding must be priced. Releases findings and prices to the customer. The same call prices a mid-repair finding. |
| `POST /api/jobs/{id}/findings`                | technician, workshop, lounge         | Mid-repair finding, no price. Work on it pauses; the customer sees "new finding being priced". The advisor prices it with `POST .../quotes`.                                                                                                              |
| `GET /api/jobs/{id}/quotes`, `/bill`          | quotes:read (not technicians)        | Quotes with items, decisions and evidence; and the generated bill (estimate, becoming an invoice on delivery).                                                                                                                                            |
| `POST /api/jobs/{id}/commands/advance`        | lounge manager, workshop             | `approved→in_bay→qc→ready→delivered`. Refused while a finding is unpriced or a quote awaits the customer. `ready→delivered` by the lounge is refused for cars returning by driver.                                                                        |
| `POST /api/jobs/{id}/transfers`               | lounge manager, workshop             | Schedules a `return` leg (or a `pickup` before arrival). `POST /api/transfers/{id}/assign` sets the driver.                                                                                                                                               |
| `GET /api/transfers/mine`                     | driver                               | The driver's open legs: address, contact, car, time window.                                                                                                                                                                                               |
| `POST /api/transfers/{id}/start`, `/complete` | driver (assigned)                    | Complete needs photo evidence (and optionally a signed receipt). Pickup moves the job to `intake`. Return moves it to `delivered` and records the approved total as received revenue.                                                                     |
| `POST /api/jobs/{id}/revenue/reverse`         | lounge manager, admin                | Flags a delivery payment as not received. Needs a reason; removes it from revenue and writes an audit event.                                                                                                                                              |
| `GET /api/dashboard/summary?branchId=`        | dashboard:read                       | Active cars, capacity, per-stage counts, aging, awaiting pricing, awaiting approval, paused for finding, delivered MTD, approved value, and revenue today/MTD (delivered and not reversed).                                                               |
| `GET/POST /api/branches`                      | all staff / admin                    | Branches scope jobs, bays and KPIs. Staff with a `branch_id` see only that branch; NULL sees all. Intake needs `branchId` once more than one branch is active.                                                                                            |

### Photos, queues and lookups

| Route                                                                         | Who                                  | Behaviour                                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/jobs/{id}/evidence/upload?kind=&caption=`                          | lounge, workshop, technician, driver | Body is the raw JPEG, PNG, WebP or MP4 (max 25 MB). The server checks the file bytes, stores it under `UPLOAD_DIR` (default `./uploads`) and records its SHA-256. Returns the evidence id. |
| `GET /api/evidence/{id}/file`                                                 | staff with `evidence:read`           | Streams the stored file; branch-scoped.                                                                                                                                                    |
| `GET /api/portal/evidence/{id}/file`, `/api/track/{token}/evidence/{id}/file` | the customer                         | Only evidence the advisor has released with a quote, and handover photos. Findings photos stay hidden until the quote is posted.                                                           |
| `GET /api/work/queue`                                                         | technician, workshop, lounge, admin  | Cars in inspection or being worked on: vehicle, concern, mileage. No customer contact details and no prices.                                                                               |
| `GET /api/customers/{id}/vehicles`                                            | lounge, workshop, admin              | The customer's saved cars (used by the intake form).                                                                                                                                       |
| `GET /api/staff/drivers`                                                      | lounge, workshop                     | Active drivers, for assigning pickups and deliveries.                                                                                                                                      |

Local-disk storage is a stand-in behind `evidence/files.ts`; replacing it with object storage changes only that file.

### Customer access

Two credentials, both stored only as SHA-256 hashes and both returned with `no-store`:

- **Profile (portal).** The QR/link `/p/<token>` is a long-lived token that works as a bearer token for the portal routes. The customer can also sign in with `POST /api/portal/login { email, password }`; the starting password is the mobile number (digits-only form accepted, spaces and `+` ignored while the password is still the default). Five wrong passwords lock the account for 15 minutes, and the response is the same generic 401. `POST /api/portal/password { currentPassword, newPassword }` (Users page) sets a new password of at least 8 characters that is not the phone number and signs out other sessions. `GET /api/portal/me` lists the customer, vehicles and jobs; `GET /api/portal/jobs/{id}` (+ `/decisions`, `/bill`) only serves the customer's own jobs, and another customer's job is a 404.
- **Per-job link.** `/track/<token>` with `GET /api/track/{token}` (+ `/decisions`, `/bill`) covers one job for 30 days; staff re-issue it with `POST /api/jobs/{id}/customer-links`.

Decisions must answer every item and name the quote version. A wrong version is 409 `QUOTE_VERSION_MISMATCH` and a second submission is 409 `QUOTE_ALREADY_DECIDED`. An initial quote with any approval moves the job to `approved`; rejecting everything moves it to `ready` for collection. An addendum never changes the stage.

## Zoho-ready integration

Domain changes write `avc.outbox_events` in the same transaction: `customer.created`, `vehicle.created`, `job.created`, `job.stage_changed`, `inspection.completed`, `finding.raised`, `quote.sent`, `quote.decided`, `transfer.completed`, `job.delivered` (carries the received amount) and `revenue.reversed`. Nothing is pushed inline, and there is no Zoho client yet.

- `GET /api/integration/events?cursor=&limit=&types=a,b` with `Authorization: Bearer avck_…` (scope `events:read`) returns `{ events: [{ id, cursor, type, occurredAt, branch, aggregate, data }], nextCursor }`. Cursors are `txid.seq` and only expose events from finished transactions, so a late commit is never skipped. Dedupe on `id`.
- Admin routes: `POST/GET/DELETE /api/integration/api-keys` (secret shown once, hash stored) and `POST/GET/DELETE /api/integration/webhooks`. Webhook URLs must be public `https://` on port 443 without credentials.
- Webhook delivery (`dispatchWebhooks`) is at-least-once and ordered per endpoint. It signs the body with `AVC-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "t.body")>`, retries with backoff and stops at the first failure. It runs only when `WEBHOOK_DISPATCH_INTERVAL_MS` is set. The signing secret is stored as plain text and needs a secrets manager or column encryption before production. Webhook URL checks are lexical, so add an egress proxy that blocks internal DNS targets.

## Not implemented

A QC checklist, video capture in the app, object storage for photos, WhatsApp and email notifications, VAT on the bill, and the Zoho CRM client remain to be built. They must use versioned explicit commands, permission checks, transactions and append-only events. No endpoint implies that a QR or job ID authenticates a user. An OIDC provider and browser sign-in flow must be selected and verified before the staff UI can operate on live records.
