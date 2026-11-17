# ADR 0007: Admin panel as a separate Worker behind Cloudflare Access

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

Adding buildings, issuing sensor keys and switching maintenance must be possible without code changes or redeploys, and only for the maintainer. A home-made login (passwords, sessions, password reset) would be a large attack surface for a one-person project.

## Decision

- A separate Worker, `svitlo-admin`, serves `svitlo-admin.yanasworks.com`. The public Worker contains no admin code. Both use the same D1 database.
- **Cloudflare Access** guards the hostname at the edge: a one-time code sent to the maintainer's email, and a policy that allows only that address.
- **Defence in depth:** the admin Worker runs first for every request, UI files included (`run_worker_first: true`). It verifies the Access token (`Cf-Access-Jwt-Assertion`) itself:
  - RS256 signature against the team's published keys (re-fetched once when the key ID is unknown, so key rotation works);
  - issuer, audience tag, expiry;
  - the email against `ADMIN_EMAILS`.

  If Access were ever misconfigured, the Worker would still refuse everyone.
- **CSRF:** Access authenticates with a cookie, so changes also require JSON, an `X-Svitlo-Admin` header and a same-origin `Origin`.
- Every change is written to `audit_log` in the same transaction as the change.
- Sensor keys are generated server-side, shown once, and stored only AES-GCM-encrypted.
- Locally, `DEV_NO_ACCESS=1` (only in `.dev.vars`) skips Access, but only for requests to `localhost`.

## Consequences

- No passwords to store or leak. Access is free for up to 50 users.
- The admin panel can't be reached at all without both Access and an allowed email. Until Access is configured, it answers 403 to everything.
- Usage against the free-plan limits needs a Cloudflare API token with Analytics read permission. That will be added separately.
