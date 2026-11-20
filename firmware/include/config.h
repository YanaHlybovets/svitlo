#pragma once
// Board pins for the LilyGO T-A7670E, from LilyGO's utilities.h (LILYGO_T_A7670).
#define MODEM_BAUDRATE 115200
#define MODEM_DTR_PIN 25
#define MODEM_TX_PIN 26
#define MODEM_RX_PIN 27
#define BOARD_PWRKEY_PIN 4
#define BOARD_POWERON_PIN 12
#define MODEM_RESET_PIN 5
#define MODEM_RESET_LEVEL HIGH
#define MODEM_POWERON_PULSE_WIDTH_MS 100
#define BOARD_BAT_ADC_PIN 35  // the board halves the battery voltage

// Grid sensing: USB 5 V -> 10 kOhm -> GPIO 34 -> 20 kOhm -> GND  (≈3.3 V when the grid is on).
// GPIO 34 is input-only and on ADC1; it is free on this board.
#define GRID_PIN 34
#define GRID_ON_MV 2000          // above this the charger has power
#define GRID_SAMPLE_MS 50
#define GRID_STABLE_SAMPLES 4    // 200 ms of the same reading before a change counts

// Reporting (matches the server: docs/architecture.md)
#define API_URL "https://svitlo.yanasworks.com/api/v1/report"
#define REPORT_INTERVAL_MS 60000UL   // every 60 s
#define CONFIRM_DELAY_MS 30000UL     // again 30 s after a change
#define RETRY_MIN_MS 5000UL          // back-off after a failed report: 5 s, 10 s, 20 s ... 60 s
#define RETRY_MAX_MS 60000UL
#define CLOCK_RESYNC_MS (6UL * 3600UL * 1000UL)
#define WATCHDOG_S 300               // reboot if the main loop is stuck for 5 min

#define FW_VERSION "0.1.0"
