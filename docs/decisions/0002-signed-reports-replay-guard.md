# ADR 0002: Signed sensor reports with a timestamp replay guard

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

Anyone who can send a convincing "grid off" report can trigger false alerts for a whole building. Sensors sit in residents' flats on home Wi-Fi, and their reports cross the public internet. The free plan allows 100,000 D1 row writes a day, and the plan's budget assumes **one write per report**.

## Decision

- Each sensor has its own random 256-bit key. It's shown once when the sensor is added, flashed into the device, and stored in D1 only encrypted (AES-GCM) with a master key that exists only as a Worker secret.
- The sensor signs the **exact body bytes** with HMAC-SHA256 and sends the result as hex in `X-Signature`. Signing raw bytes avoids JSON canonicalisation problems.
- A report is accepted only if:
  1. the signature is valid (constant-time check via Web Crypto `verify`);
  2. its `ts` is within 60 s of server time;
  3. its `ts` is **strictly later** than the last accepted `ts` for that sensor.
- Rule 3 is enforced inside the single `UPDATE … WHERE last_ts < ?` that stores the report. A replayed or out-of-order report changes zero rows and is rejected.
- Every authentication failure returns the same `401` with no body.

## Why not a nonce table

The plan first suggested a per-report nonce. Remembering seen nonces would need a second write per report (doubling D1 writes) plus clean-up of old nonces. A strictly increasing timestamp gives the same protection, because a report can be used once and never after a newer one. It costs no extra write. The firmware guarantees `ts` always increases, even for two reports in the same second, by using `max(now, last + 1)`.

## Consequences

- The sensor's clock must be within 60 s of real time, so the firmware syncs it with NTP before sending.
- Changes that happen while the sensor is offline are summarised by `grid` + `since` in the next report. Every intermediate flip during a long Wi-Fi outage isn't kept. A buffered `changes` list can be added later without breaking this format.
- Rotating a key (lost or replaced sensor) is one database update, with no redeploy.
