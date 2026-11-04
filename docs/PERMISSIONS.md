# Permissions

## Source roles

The SRS identifies customer, Jumeirah lounge manager, diagnostic/master technician, flatbed driver, Al Quoz workshop manager and finance/Zoho admin. It also uses “service advisor” without defining whether that is a separate role.

## Proposed permission matrix

| Action                   | Customer      | Advisor / lounge manager  | Technician        | Driver                     | Workshop manager | Finance          |
| ------------------------ | ------------- | ------------------------- | ----------------- | -------------------------- | ---------------- | ---------------- |
| View own/assigned job    | Own           | Assigned/site             | Assigned          | Transfer subset            | Workshop/site    | Financial subset |
| Intake and job creation  | —             | Create/edit               | —                 | —                          | Read             | Read             |
| DVI and evidence         | Released view | Read                      | Assigned edit     | —                          | Read             | —                |
| Price/publish estimate   | View          | Create/publish            | —                 | —                          | Read             | Read             |
| Item decisions/signature | Own authorize | Assisted only by policy   | —                 | —                          | —                | —                |
| Work/bay assignment      | —             | Read                      | Assigned progress | —                          | Manage           | —                |
| Transit evidence         | Progress      | Origin/receipt            | —                 | Assigned departure/arrival | Receipt/return   | —                |
| QC sign-off              | Result        | Read                      | Read              | —                          | Sign             | —                |
| Invoice/payment          | Own           | Desk collection by policy | —                 | —                          | Read             | Manage           |
| Integration errors       | —             | Scoped read               | —                 | —                          | Scoped read      | Manage           |

Apply permissions in API handlers and database queries, not UI visibility. Deny by default. Customer approval links need expiry, binding to estimate version, verification and replay protection. Overrides must have a named permission and audit reason. No authentication is implemented in Phase 0.

## Milestone 1A enforcement

The API maps a verified external subject to one active staff record. `apps/server/src/identity/permissions.ts` is the code-level capability map. `lounge_manager` alone can search/create customers and vehicles, create intake jobs, start inspection and read the job board/detail. This grants lounge managers organization-wide access in the current single-organization model. Other named roles are explicit in the schema but receive no 1A business permissions. The advisor split and site/assignment scoping are open decisions that must be settled before production use. The deployed verifier fails closed until an OIDC provider is configured; test-only verifier injection proves the API authorization boundary, not live authentication.

## Staff accounts and super admin

Staff sign in with email and password; the server stores only a scrypt hash and a SHA-256 of each 12-hour session token. `super_admin` holds every grant and alone has `staff:manage`: create accounts (temporary password shown once, change forced at first sign-in), assign role and branch, reset passwords, switch accounts off (which ends their sessions). The last active super admin cannot be demoted or switched off. The first super admin is created from the command line, never through the API.

## Milestone 1B additions

An `admin` role exists for branch, dashboard and integration management. `staff_members.branch_id` pins staff to one branch, and NULL means all branches. Working grants live in `apps/server/src/identity/permissions.ts`: lounge managers publish quotes, issue customer links and advance jobs; technicians and workshop managers raise findings and register evidence; admins manage branches, API keys and webhooks. Customers act only through an expiring per-job link bound to the quote version. These grants stay provisional until the advisor split (question 2) is answered.
