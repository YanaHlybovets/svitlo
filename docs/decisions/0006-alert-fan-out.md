# ADR 0006: Alert fan-out through a queue, with a fast path and write guards

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

When a building's status changes, every subscriber gets a Telegram message. Limits that shape the design:

- Telegram accepts about 30 bulk messages a second.
- The free plan allows 50 outgoing requests per Worker run and 10,000 queue operations a day.
- The cron job runs at most once a minute, which alone would delay OFF alerts by up to 90 s.

## Decision

1. **Queue.** On a change, subscribers who haven't blocked the bot are split into queue messages of **40 chats** each (`svitlo-alerts`). The consumer takes one message per run (`max_batch_size: 1`, `max_concurrency: 1`). It sends at most 40 messages per run, 40 ms apart (≈25 a second), in each user's language, with `disable_notification` during their quiet hours.
2. **Retries.** On `429` or a Telegram/network error, the rest of the batch is re-queued as a new message, delayed by `retry_after` (up to 5 attempts). On `403` (or "chat not found"), the user is marked blocked and skipped from then on. An alert more than 15 minutes old is dropped, because it would mislead more than help.
3. **No duplicates.** Each queue message has a key, `<event id>:<part>`. After sending, the key is stored in `alert_batches`, and a redelivered message with a stored key is skipped. That's one D1 write per 40 recipients, not one per recipient. If a run crashes midway (rare), the batch can be partly resent on redelivery; per-recipient keys would cost 40× the writes.
4. **Fast path.** When an accepted report could confirm a change (an `off` reported at least 30 s after it began, or an `on` at least 60 s after), the report handler runs the same status rules for that one building right away, after responding. The cron job remains the safety net.
5. **Write guard.** The cron job and the fast path can evaluate the same building at the same moment. Every status write replaces a random `buildings.rev` token, but only if the token is still the one that was read. The building's event rows are written in the same transaction, and only if that update won. Only the winner enqueues alerts.
6. **Admin alerts.** The admin gets a private message when a sensor goes silent ("no data") and when it is back.

## Consequences

- OFF alerts reach subscribers about **30–35 s** after the outage begins, and ON alerts about **60–90 s** after power returns (the debounce is deliberate).
- Worst case, 3,000 subscribers of one building take about 2 minutes, from 75 queue messages × 3 operations = 225 queue operations per change.
- Tests never reach Telegram: a fake client in unit tests, and an outbound interceptor for anything else.
