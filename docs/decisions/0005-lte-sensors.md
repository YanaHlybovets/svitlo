# ADR 0005: Sensors connect over LTE, not the host's Wi-Fi

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

The sensor runs on its own battery, so it notices a blackout instantly. But on the host's Wi-Fi it can only *report* one if the internet survives the blackout. In Kyiv that often fails: many routers have no backup power, and many providers bring Ethernet into the building through a switch in the stairwell that also loses power. The sensor then goes silent, the building shows "no data" after 3 minutes, and **no one is alerted**, neither when the light goes off nor when it comes back.

## Decision

Each sensor has its own LTE connection: an ESP32 board with an LTE Cat-1 modem and an 18650 holder (for example LilyGO T-A7670**E**, the Europe-band version), plus a prepaid SIM with a small data plan. The host provides only a free wall socket.

## Consequences

- Alerts don't depend on the host's router or internet provider, and hosts are easier to find (no Wi-Fi password, nothing on their network).
- **Backend, bot and website are unchanged.** The report format, signatures and status rules stay the same. `wifi_rssi` holds the mobile signal strength (dBm, same range).
- Firmware talks to the modem (TinyGSM or the modem's own HTTPS stack), takes the time from the network, and has a SIM APN flashed instead of Wi-Fi details.
- Cost: a more expensive board, plus a small monthly mobile plan per building (about 100–300 MB a month with reports every 60 s). This is the project's only running cost.
- Mobile towers have backup batteries, but a very long blackout can take one down. The "off" report is sent within seconds, while the tower is still up, and silence after "off" keeps the building OFF. Only the "back on" alert can be delayed while the tower recovers.
- LTE uses more battery than Wi-Fi. The pilot will measure how long a sensor lasts off-grid.
