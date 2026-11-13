# firmware/

ESP32 sensor firmware (Phase 1). Reads the USB charger's 5 V through a voltage divider on a GPIO pin, and reports `{sensor_id, grid, battery_mv, wifi_rssi, ts, nonce}` signed with HMAC-SHA256 every 60 s, plus at once on any change.

Per-sensor ID, key and Wi-Fi details go in `secrets.h` (git-ignored) at flashing time. See `secrets.example.h` once it exists.
