# Open Questions

These are client decisions, not assumptions to encode in screens or database constraints yet.

1. What is the current intake/key custody procedure, and who issues/uses the valet QR?
2. Are lounge manager and service advisor separate roles? Who can override price, discounts or states?
3. What work can occur at Jumeirah, and who determines Al Quoz transfer?
4. Must every quote line receive an explicit decision? How are supplementary findings approved?
5. Who releases and receives custody on each leg, and which photos/signatures are mandatory?
6. Is QC mandatory for all services, and can failed/waived checks be released?
7. When does Zoho receive a draft versus approved estimate, when is an invoice issued, and can keys be released before payment sync?
8. Is parts stock managed in Zoho Books, Zoho Inventory or elsewhere?
9. Which technician actions must work offline, for how long, and how are conflicting edits resolved?
10. Which identity provider and customer approval verification channel will AVC use?
11. What storage residency, retention, consent and deletion rules apply to photos, video, IDs and signatures?
12. What is the hosting target, secrets manager, backup policy and production monitoring owner?
13. Which payment provider, POS reconciliation process and refund policy apply?
    The supplied SRS also states specific media upload, Zoho latency and push timing targets without payload sizes or measurement conditions. Define these before treating them as testable service levels.

Working assumptions made while building migration 0003, to confirm with the client:

- AVC has one outlet today (Al Quoz 1) and adds branches later as data.
- The client answered question 4: the customer approves or rejects each line, approval starts the work, and a new finding is re-quoted in the customer app. It is implemented; whether approval needs a verified channel (OTP) is still question 10.
- Rejecting every line of an initial quote sends the car to `ready` for collection.
- QC is a required step before `ready` (question 6).
- A customer link is valid for 30 days and is the only approval credential until question 10 is settled.
- Approved value is booked work; invoiced revenue waits for Zoho.
- The integration target is Zoho CRM, not only Zoho Books (question 7).

Client answers received after migration 0003 (now built in migration 0004):

- Customer profile: created at intake from email and mobile; the QR/link opens it directly, and email plus mobile number is the starting login. The client chose to keep the mobile number valid as the password until the customer changes it; hashing and a wrong-password lockout are added underneath.
- The technician describes findings with proof and never sees prices. The advisor prices each finding from their own catalog (none is built), and only then does the customer see findings and prices. The customer is told "inspection complete, preparing your quote" in between. The advisor's entries become the bill.
- Parts and stock: not needed yet.
- Arrival and return are a mix of concierge and walk-in, so both are supported.
- Payment: the lounge handles it. When the driver (or the lounge, for a collected car) marks the car delivered, the approved amount is recorded as received and counted as revenue. The lounge can reverse it with a reason.
- Still open: VAT treatment and the company details on the bill; whether a customer approval needs a verified channel (OTP).
