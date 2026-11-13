# ADR 0001: Run everything on Cloudflare's free plan

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

A portfolio project with one maintainer, up to 10 buildings and a few thousand users. It needs an HTTPS API for sensors, a database, scheduled status checks, a message queue for Telegram fan-out, and a static website. It should cost nothing to run, and there should be no servers to patch.

## Decision

Use Cloudflare Workers, D1, Queues, Cron Triggers and Pages on the free plan. The domain `yanasworks.com` is registered with Cloudflare Registrar, and the project lives at `svitlo.yanasworks.com`.

## Consequences

- No servers to patch, plus global CDN caching and DDoS protection included.
- The design must respect the daily limits: 100k Worker requests, 100k D1 writes, 10k queue operations, 10 ms CPU per request. Hence one DB write per sensor report, building rows written only on change, and 40 chats per queue message.
- If a limit is hit, D1 errors until 00:00 UTC. Upgrading to Workers Paid fixes this in minutes with no code changes.
- Some lock-in to Cloudflare APIs (D1, Queues), which is acceptable at this scale.
