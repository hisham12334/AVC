# Implementation Plan

## Completed foundation and Milestone 1A boundary

One Fastify process serves an API and built React PWA. PostgreSQL stores staff identities, customers, vehicles, intake jobs and append-only job events. Role-checked commands create intake jobs and start inspection; role-checked queries return the board and detail. The identity verifier and browser sign-in remain blocked pending OIDC provider selection. No external integration is implemented.

## Remaining dependency within Milestone 1A

Select the staff OIDC provider and confirm advisor/loungemanager role mapping before live staff access. Configure a verifier, staff provisioning and browser sign-in, then test the full flow end to end. Confirm intake custody evidence before adding it. The current implementation deliberately does not treat a test verifier as live authentication.

## Later increments

1B DVI checklist/media/offline proof of concept; 2 versioned estimates and customer authorization; 3 transfers, bay tasks and QC; 4 Zoho and payment reconciliation; 5 full mobile/loyalty/tracking features. Each increment should be end-to-end and testable, with client decisions from `OPEN_QUESTIONS.md` resolved before its relevant rules are encoded.
