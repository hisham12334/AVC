# Job Lifecycle

## Specified path

Jumeirah intake → DVI → advisor estimate → per-item customer approval and signature → express or Al Quoz repair → QC → return/staging → invoice/payment → handover. The SRS's statuses mix progress and location; the proposed model below separates them.

## Proposed job status state machine

`intake_open → inspection_pending → inspection_complete → awaiting_approval → authorized → work_in_progress → qc_pending → qc_passed → ready_for_handover → completed`.

`on_hold`, `cancelled`, partial approval, rework and supplementary estimate paths need AVC policy. Failed QC returns to work with an audit event. Declining all items cannot silently become authorized.

| Transition             | Actor                            | Required guard/evidence                                                           |
| ---------------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| Open / complete intake | Advisor or lounge manager        | Customer, vehicle, odometer, condition, actor and time.                           |
| Complete DVI           | Assigned technician              | Checklist and required synchronized evidence.                                     |
| Publish estimate       | Advisor                          | Frozen version, line prices, VAT and scope.                                       |
| Authorize              | Verified customer                | Decision per actionable line, signature, exact version and total.                 |
| Start work             | Assigned technician/manager      | Approved task and assignment.                                                     |
| Dispatch               | Origin staff and assigned driver | Transfer order, departure condition and custody release.                          |
| Receive                | Destination advisor/manager      | Arrival condition and acknowledged custody; driver alone cannot complete receipt. |
| Pass QC                | Workshop manager                 | Checklist, evidence and sign-off; failure opens rework.                           |
| Mark ready             | Jumeirah advisor                 | Vehicle at release location, final condition, commercial gate satisfied.          |
| Close                  | Jumeirah advisor                 | Recipient, key/vehicle release receipt and time.                                  |

Every command checks role, assignment, current version and guards in one transaction; it appends an audit event and queues later notifications/integration. Job status never substitutes for location, assignment, work stage or payment state. Full operational map: `../AVC Workflow and Architecture Map.md`.

## Implemented boundary

Milestone 1A implements only `create intake job` → `intake_open` (version 1) and `start inspection` → `inspection_pending` (version 2). Both record events in the same transaction. The second command requires an expected version and rejects stale or invalid transitions. It does not submit a DVI or imply inspection evidence exists. No estimate, transfer, QC or completion command is exposed yet.
