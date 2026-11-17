# firmware/

ESP32 sensor firmware (Phase 1). Connects over **LTE**, not Wi-Fi ([ADR 0005](../docs/decisions/0005-lte-sensors.md)).

## Hardware (one building)

- LilyGO **T-A7670E** (ESP32 + A7670E LTE Cat-1 modem + 18650 holder). Make sure it's the **E** (Europe) version.
- One protected 18650 cell (Samsung, LG or Panasonic)
- Prepaid SIM (Kyivstar, Vodafone or lifecell) with a small data plan; turn off the SIM PIN
- USB wall charger (5 V, 1 A) and a data USB cable. The charger is what gets measured.
- 10 kΩ + 20 kΩ resistors: a voltage divider from the USB 5 V line to a GPIO pin (about 3.3 V when the grid is on)
- Small case and a label: "Не вимикати — датчик світла в будинку"

## Behaviour

Reports `{sensor_id, grid, since, ts, battery_mv, wifi_rssi, fw}` signed with HMAC-SHA256 (see `docs/architecture.md`) every 60 s, at once on any change, and again 30 s after a change. `wifi_rssi` holds the mobile signal strength in dBm. The clock comes from the mobile network, and `ts` always increases. The sensor ID, key and SIM APN go in `secrets.h` (git-ignored) at flashing time.
