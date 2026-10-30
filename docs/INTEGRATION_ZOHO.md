# Zoho Books Integration

## Specified scope

The SRS calls for customer/item mapping, estimate synchronization, tax invoices, payment status, inventory/parts lookup and retry handling. It gives conflicting estimate triggers: one-click draft sync and post-approval sync. It also describes invoice conversion at payment/handover. These trigger rules require AVC confirmation.

## Proposed boundary

AVC owns operational facts and signed commercial snapshots. Zoho owns mapped financial records and its invoice/payment ledger. Store organization ID, mapped customer/item IDs, Zoho estimate/invoice IDs and synchronization status separately from job status. OAuth credentials go in a secret store, never code or logs.

Commit AVC approval and an outbox record in the same PostgreSQL transaction. A worker sends idempotent Zoho requests, stores response IDs/status, retries transient errors with backoff and routes permanent failures to finance. Payment webhooks/events need signature verification, deduplication and reconciliation. Never let a failed Zoho call erase customer authorization or show a fake success. Use a Zoho test organization for contract tests before production.

## Pending decisions

- Exact estimate creation/update trigger and whether staff may edit it in Zoho.
- Invoice timing and payment-before-release policy.
- Customer/item/tax mapping and whether Zoho Books or Zoho Inventory is the source for stock.
- VAT/discount handling, credit notes, refunds and partial payments.
- OAuth organization, scopes, hosting region, rate limits and webhook capabilities.

No Zoho client or credentials are included in Phase 0.
