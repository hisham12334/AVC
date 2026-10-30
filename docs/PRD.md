# Product Requirements

## Confirmed from supplied specifications

AVC proposes a cloud workshop system spanning Jumeirah intake/lounge and Al Quoz workshop operations. The job card connects customer, vehicle, DVI, estimate, approval, assigned work, transfers, QC, invoice, payment and handover. Staff, technician, driver, workshop manager, finance and customer experiences are identified. Inspections need media and offline technician capture. Customer approval is per estimate line. Zoho Books integration, notifications, loyalty and live transport tracking appear in the SRS.

## Implemented through Milestone 1A

The repository starts locally, validates configuration, connects to PostgreSQL, runs migrations, serves a React PWA shell, exposes health checks and passes automated checks. The API supports staff-role-checked customer and vehicle search/creation, vehicle intake, auditable job creation, a guarded start-inspection command, and read-only job board/detail. Live staff sign-in is blocked until AVC selects an OIDC provider. DVI, estimates, transfers, QC and finance are not implemented.

## Proposed delivery sequence

1. Workshop operations MVP: identity/roles, customer/vehicle, intake, job card, DVI and work board.
2. Versioned estimates and customer authorization.
3. Custody transfers, bay work and QC.
4. Zoho Books, invoicing and payment reconciliation.
5. Full customer and mobile features, loyalty and advanced tracking.

This order follows dependencies, not hard release gates. See `IMPLEMENTATION_PLAN.md` and `OPEN_QUESTIONS.md`.
