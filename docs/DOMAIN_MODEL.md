# Domain Model

## Specified concepts

Customer owns or is authorized for vehicles. A vehicle can have many job cards. A job card is one service visit and is the link between intake, DVI, estimates, work, transfer, QC and finance. A DVI consists of checklist findings with urgency and media. An estimate has priced labor/parts; a customer chooses each item and signs. Vehicles can move between Jumeirah and Al Quoz with condition records. QC and financial records precede handover.

## Proposed normalized model

`customer 1—many vehicle 1—many job_card`; `job_card 1—many intake_report, inspection, estimate_version, work_task, transfer, qc_report, audit_event`; `inspection 1—many finding`; `estimate_version 1—many estimate_line`; `estimate_line 1—one customer_decision per authorization`; media assets attach through evidence links. `job_card` stores current projection fields, but audit/transfer records retain history.

Estimate publication freezes a version. Each decision references that version and line. A new price or scope creates a new version; supplementary work requires separate authorization. Store currency, fixed-decimal amounts, VAT basis, tax, discount and rounding with the signed snapshot. Do not calculate invoices from the latest editable quote.

Future inspection evidence must use durable media-asset records with storage key, checksum, capture time, uploader and synchronization state (`pending`, `uploaded`, `verified` or `failed`). Findings reference asset IDs rather than form-only URLs. These tables and estimate authorization are out of Milestone 1A scope.

Transfer has origin, destination, assigned driver, departure evidence, releasing party, arrival evidence, receiving party, discrepancy and timestamps. Physical location derives from accepted transfer events. QC has checklist version, result, evidence and manager sign-off. Audit events are append-only with actor, action, entity, prior/new version, timestamp, evidence references and correlation ID. Correction is a compensating event, not deletion.

## Independent state dimensions

- Job status: business authorization/progress.
- Vehicle location: physical custody and transit.
- Assigned responsibility: owner of next action.
- Work stage: current task activity, possibly several in parallel.

See `JOB_LIFECYCLE.md` for proposed transitions and `OPEN_QUESTIONS.md` for policies AVC has not confirmed.

## Implemented in Milestone 1A

Migration `0002_staff_intake_jobs.sql` creates `staff_members`, `customers`, `vehicles`, `job_cards` and `job_events`. A composite foreign key ensures a job's vehicle belongs to its customer. VIN is unique when present; phone and plate are searchable but not globally unique. Exact same-name/mobile and same-customer plate checks reduce accidental duplicates without encoding ownership-transfer policy. A job records mileage in kilometres, free-text condition, responsible/creating staff, creation time, version, status, location and stage. This does not assert key custody. `job_events` has a database trigger that rejects update and delete.
