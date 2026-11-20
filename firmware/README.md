# firmware/

Firmware for the building sensor: a **LilyGO T-A7670E** (ESP32 + A7670E LTE Cat-1 modem + 18650 holder). It connects over its own SIM, not the host's Wi-Fi ([ADR 0005](../docs/decisions/0005-lte-sensors.md)).

What it does:
- Measures whether the USB charger in the wall socket has power (GPIO 34, through a voltage divider). The battery keeps the board running when it doesn't.
- Reports to `https://svitlo.yanasworks.com/api/v1/report` every 60 s, **at once** when the state changes, and again 30 s later. Each report is signed with HMAC-SHA256 ([ADR 0002](../docs/decisions/0002-signed-reports-replay-guard.md)).
- Gets its clock from the mobile network (NTP through the modem) and re-syncs every 6 h, or at once if the server rejects a report.
- Retries failed reports with back-off (5 s → 60 s). A watchdog reboots the board if it ever hangs for 5 minutes.

## Parts (one building)

| Part | Notes |
|---|---|
| LilyGO **T-A7670E** | The **E** (Europe) version: LTE bands used in Ukraine |
| 18650 cell, protected | Samsung, LG or Panasonic. **Check the polarity marking on the holder.** |
| Prepaid SIM | Kyivstar, Vodafone or lifecell, small data plan (about 100–300 MB a month). Turn the PIN off in a phone first. |
| USB wall charger, 5 V 1–2 A | This is what gets measured. The modem draws up to about 2 A in short bursts, so prefer 2 A. |
| **USB-A female breakout board** | Gives access to the charger's 5 V and GND pins |
| USB-A → USB-C cable | From the breakout to the board (check the board's connector) |
| Resistors 10 kΩ and 20 kΩ | Voltage divider |
| LTE antenna | Usually included with the board; **never power the modem without it** |
| Small case, label | "Не вимикати — датчик світла в будинку" |

## Wiring

```
 wall socket
     │
 USB charger ──► USB-A breakout ──► USB cable ──► T-A7670E (USB port: powers the board, charges the 18650)
                   │ 5V      │ GND
                   │         └──────────────────────► GND pin
                   └─[10 kΩ]──┬────────────────────► GPIO 34
                              └─[20 kΩ]── GND
```

With the grid on, GPIO 34 sees about 5 V × 20/30 ≈ **3.3 V**. With the grid off, it sees **0 V** while the battery keeps the board running. Never connect the 5 V line to GPIO 34 directly.

> Why not the board's own 5V pin? On some boards that pin is fed back from the battery, so it would read "on" during a blackout. Measuring at the breakout always measures the charger itself.

## Set up and flash

1. Install the tools once: PlatformIO Core is in `~/.platformio/penv`. Add `alias pio=~/.platformio/penv/bin/pio` to `~/.zshrc`, or install the "PlatformIO IDE" extension in VS Code.
2. In the admin panel (https://svitlo-admin.yanasworks.com), on the building's card, press **🔑 Новий ключ** (or **➕ Створити датчик**). Copy the sensor ID and key; they're shown once.
3. `cp include/secrets.example.h include/secrets.h`. Fill in `SENSOR_ID`, `SENSOR_KEY_B64` and `SIM_APN`. This file is git-ignored; never commit it.
4. Insert the SIM, screw on the antenna, insert the 18650, and connect the board to your Mac by USB.
5. `pio run -t upload`, then `pio device monitor` to watch the logs:
   ```
   Svitlo sensor 0.1.0 (s-revutskogo-54a)
   Grid at boot: ON, battery 4105 mV
   Modem: ready
   SIM: ready
   Network: connected, IP 10.x.x.x
   Clock: 2026-11-21 10:15:02 (tz +0.00) -> 1795...
   Report (change): grid on -> HTTP 204
   ```

## Test before installing (at home)

| Test | Do | Expect |
|---|---|---|
| Reports | Leave it running for 5 minutes | `HTTP 204` every 60 s; admin card shows "Останній звіт" under a minute, plus battery and signal |
| Grid off | Unplug the **charger from the wall** | `Grid: OFF` at once, then `HTTP 204`. About 30 s later the Telegram alert "світло зникло" |
| Grid back | Plug it back in | ON alert about 60 s later, with the outage length |
| Flicker | Unplug and replug within 10 s | No alert; a red flicker mark on the website timeline |
| No network | Unscrew the antenna for 5 min (grid on) | Admin alert "датчик не на зв'язку"; site shows "Немає даних"; no false OFF alert |

Turn on maintenance in the admin panel before testing if other people already follow the building.

## Notes

- `wifi_rssi` holds the mobile signal strength in dBm (CSQ converted), the same field the server already has.
- Over-the-air updates (plan, Phase 1 step 5) aren't implemented yet. Updating means re-flashing by USB.
- The TinyGSM fork (LilyGO's, with the modem's built-in HTTPS) is pinned to a specific commit in `platformio.ini`.
