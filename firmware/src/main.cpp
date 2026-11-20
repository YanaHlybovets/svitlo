// Svitlo building power sensor (LilyGO T-A7670E).
//
// Watches whether the USB charger in the wall socket has power and reports it
// to https://svitlo.yanasworks.com over LTE:
//   * every 60 s, at once when the grid state changes, and again 30 s later;
//   * body {sensor_id, grid, since, ts, battery_mv, wifi_rssi, fw}, signed with
//     HMAC-SHA256 over the exact bytes (header X-Signature), see ADR 0002.
// The board runs on its 18650 battery when the grid is off, so it can always
// report "off" while the mobile network is up.

#include <Arduino.h>
#include <TinyGsmClient.h>
#include <esp_task_wdt.h>
#include <mbedtls/base64.h>
#include <mbedtls/md.h>

#include "config.h"
#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Copy include/secrets.example.h to include/secrets.h and fill it in."
#endif

#define SerialAT Serial1
static TinyGsm modem(SerialAT);

// ---------- state ----------

static uint8_t sensorKey[64];
static size_t sensorKeyLen = 0;

// Clock: Unix time = epochAtSync + seconds since millisAtSync.
static int64_t epochAtSync = 0;
static uint32_t millisAtSync = 0;

// Grid state as debounced from GRID_PIN.
static bool gridOn = false;
static bool candidate = false;
static uint8_t stableCount = 0;
static uint32_t sinceMillis = 0;   // when the current state began (board time)
static int64_t sinceEpoch = 0;     // the same in Unix time, once the clock is known
static bool sinceKnown = false;

// Reporting.
static bool reportNow = true;          // send at the next chance (boot, change)
static uint32_t confirmAt = 0;         // millis of the 30 s follow-up, 0 = none
static uint32_t lastReportMillis = 0;
static uint32_t retryAt = 0;
static uint32_t backoffMs = RETRY_MIN_MS;
static int64_t lastTs = 0;             // ts must always increase (server replay guard)
static bool forceClockSync = false;

// ---------- helpers ----------

static bool clockKnown() { return epochAtSync > 0; }

static int64_t nowEpoch() {
  return epochAtSync + static_cast<int64_t>((millis() - millisAtSync) / 1000UL);
}

// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
static int64_t daysFromCivil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return static_cast<int64_t>(era) * 146097 + static_cast<int64_t>(doe) - 719468;
}

static uint32_t batteryMv() { return analogReadMilliVolts(BOARD_BAT_ADC_PIN) * 2; }

static bool readGridRaw() { return analogReadMilliVolts(GRID_PIN) > GRID_ON_MV; }

static bool loadKey() {
  const char* b64 = SENSOR_KEY_B64;
  int rc = mbedtls_base64_decode(sensorKey, sizeof(sensorKey), &sensorKeyLen,
                                 reinterpret_cast<const unsigned char*>(b64), strlen(b64));
  return rc == 0 && sensorKeyLen == 32;
}

static bool signHex(const char* body, char out[65]) {
  uint8_t mac[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (mbedtls_md_hmac(info, sensorKey, sensorKeyLen, reinterpret_cast<const unsigned char*>(body),
                      strlen(body), mac) != 0) {
    return false;
  }
  static const char* hex = "0123456789abcdef";
  for (int i = 0; i < 32; i++) {
    out[i * 2] = hex[mac[i] >> 4];
    out[i * 2 + 1] = hex[mac[i] & 0x0f];
  }
  out[64] = '\0';
  return true;
}

// ---------- modem ----------

static void pulsePowerKey() {
  digitalWrite(BOARD_PWRKEY_PIN, LOW);
  delay(100);
  digitalWrite(BOARD_PWRKEY_PIN, HIGH);
  delay(MODEM_POWERON_PULSE_WIDTH_MS);
  digitalWrite(BOARD_PWRKEY_PIN, LOW);
}

static void startModem() {
  pinMode(BOARD_POWERON_PIN, OUTPUT);
  digitalWrite(BOARD_POWERON_PIN, HIGH);  // power to the modem

  pinMode(MODEM_RESET_PIN, OUTPUT);
  digitalWrite(MODEM_RESET_PIN, !MODEM_RESET_LEVEL);
  delay(100);
  digitalWrite(MODEM_RESET_PIN, MODEM_RESET_LEVEL);
  delay(2600);
  digitalWrite(MODEM_RESET_PIN, !MODEM_RESET_LEVEL);

  pinMode(MODEM_DTR_PIN, OUTPUT);
  digitalWrite(MODEM_DTR_PIN, LOW);  // keep the modem awake

  pinMode(BOARD_PWRKEY_PIN, OUTPUT);
  pulsePowerKey();

  SerialAT.begin(MODEM_BAUDRATE, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);
  Serial.println("Modem: starting");
  int tries = 0;
  while (!modem.testAT(1000)) {
    esp_task_wdt_reset();
    if (++tries % 30 == 0) {
      Serial.println("Modem: no answer, pulsing power key again");
      pulsePowerKey();
    }
  }
  Serial.println("Modem: ready");

  SimStatus sim = SIM_ERROR;
  for (int i = 0; i < 30 && sim != SIM_READY; i++) {
    sim = modem.getSimStatus();
    if (sim == SIM_LOCKED && strlen(SIM_PIN) > 0) modem.simUnlock(SIM_PIN);
    esp_task_wdt_reset();
    delay(1000);
  }
  Serial.printf("SIM: %s\n", sim == SIM_READY ? "ready" : "NOT READY (check the card and its PIN)");
  modem.setNetworkAPN(SIM_APN);
}

static bool dataConnected() {
  if (!modem.isNetworkConnected()) return false;
  String ip = modem.getLocalIP();
  return ip.length() > 0 && ip != "0.0.0.0";
}

static bool ensureNetwork() {
  if (dataConnected()) return true;
  Serial.println("Network: connecting");
  uint32_t start = millis();
  while (!modem.isNetworkConnected()) {
    esp_task_wdt_reset();
    if (millis() - start > 120000UL) {
      Serial.println("Network: not registered yet");
      return false;
    }
    delay(1000);
  }
  if (!modem.setNetworkActive(SIM_APN)) {
    Serial.println("Network: data connection failed");
    return false;
  }
  delay(1000);
  Serial.printf("Network: connected, IP %s\n", modem.getLocalIP().c_str());
  return dataConnected();
}

static bool syncClock() {
  modem.NTPServerSync("pool.ntp.org", 0);  // set the modem clock to UTC
  int y, mo, d, h, mi, s;
  float tz = 0;
  if (!modem.getNetworkTime(&y, &mo, &d, &h, &mi, &s, &tz) || y < 2025) {
    Serial.println("Clock: sync failed");
    return false;
  }
  int64_t local = daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s;
  epochAtSync = local - static_cast<int64_t>(tz * 3600.0f);
  millisAtSync = millis();
  if (!sinceKnown) {
    sinceEpoch = nowEpoch() - static_cast<int64_t>((millis() - sinceMillis) / 1000UL);
    sinceKnown = true;
  }
  Serial.printf("Clock: %04d-%02d-%02d %02d:%02d:%02d (tz %+.2f) -> %lld\n", y, mo, d, h, mi, s, tz,
                static_cast<long long>(epochAtSync));
  return true;
}

// ---------- reporting ----------

/** Sends the current state. Returns the HTTP status, or -1 when nothing could be sent. */
static int sendReport(const char* reason) {
  int64_t ts = nowEpoch();
  if (ts <= lastTs) ts = lastTs + 1;
  int64_t since = sinceEpoch > ts ? ts : sinceEpoch;

  int csq = modem.getSignalQuality();  // 0..31, 99 = unknown
  char rssi[8];
  if (csq >= 0 && csq <= 31) snprintf(rssi, sizeof(rssi), "%d", -113 + 2 * csq);
  else snprintf(rssi, sizeof(rssi), "null");

  char body[256];
  snprintf(body, sizeof(body),
           "{\"sensor_id\":\"%s\",\"grid\":\"%s\",\"since\":%lld,\"ts\":%lld,\"battery_mv\":%u,"
           "\"wifi_rssi\":%s,\"fw\":\"%s\"}",
           SENSOR_ID, gridOn ? "on" : "off", static_cast<long long>(since), static_cast<long long>(ts),
           static_cast<unsigned>(batteryMv()), rssi, FW_VERSION);

  char signature[65];
  if (!signHex(body, signature)) return -1;

  int code = -1;
  if (modem.https_begin()) {
    modem.https_set_timeout(30, 20, 20);
    if (modem.https_set_url(API_URL) && modem.https_set_content_type("application/json") &&
        modem.https_add_header("X-Signature", signature)) {
      code = modem.https_post(body);
    }
    modem.https_end();
  }
  // Even a failed attempt may have reached the server, so never reuse this ts.
  lastTs = ts;
  Serial.printf("Report (%s): grid %s -> HTTP %d\n", reason, gridOn ? "on" : "off", code);
  if (code == 401) forceClockSync = true;  // most likely our clock drifted
  return code;
}

static void sampleGrid() {
  bool raw = readGridRaw();
  if (raw == gridOn) {
    stableCount = 0;
    return;
  }
  if (raw != candidate) {
    candidate = raw;
    stableCount = 0;
  }
  if (++stableCount < GRID_STABLE_SAMPLES) return;

  gridOn = raw;
  stableCount = 0;
  sinceMillis = millis();
  sinceKnown = clockKnown();
  if (sinceKnown) sinceEpoch = nowEpoch();
  reportNow = true;
  confirmAt = millis() + CONFIRM_DELAY_MS;
  if (confirmAt == 0) confirmAt = 1;
  Serial.printf("Grid: %s\n", gridOn ? "ON" : "OFF");
}

// ---------- Arduino ----------

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\nSvitlo sensor %s (%s)\n", FW_VERSION, SENSOR_ID);

  esp_task_wdt_init(WATCHDOG_S, true);
  esp_task_wdt_add(nullptr);

  analogReadResolution(12);
  pinMode(GRID_PIN, INPUT);
  gridOn = readGridRaw();
  candidate = gridOn;
  sinceMillis = millis();
  Serial.printf("Grid at boot: %s, battery %u mV\n", gridOn ? "ON" : "OFF", static_cast<unsigned>(batteryMv()));

  if (!loadKey()) {
    // Without a valid key nothing can be sent; make the problem obvious.
    while (true) {
      Serial.println("SENSOR_KEY_B64 is not a valid 32-byte base64 key. Fix secrets.h and re-flash.");
      esp_task_wdt_reset();
      delay(5000);
    }
  }
  startModem();
}

void loop() {
  esp_task_wdt_reset();
  sampleGrid();

  uint32_t now = millis();
  bool confirmDue = confirmAt != 0 && static_cast<int32_t>(now - confirmAt) >= 0;
  bool periodicDue = now - lastReportMillis >= REPORT_INTERVAL_MS;
  bool due = reportNow || confirmDue || periodicDue;

  if (due && static_cast<int32_t>(now - retryAt) >= 0) {
    bool ok = false;
    if (ensureNetwork()) {
      if (!clockKnown() || forceClockSync || millis() - millisAtSync > CLOCK_RESYNC_MS) {
        if (syncClock()) forceClockSync = false;
      }
      if (clockKnown()) {
        const char* reason = reportNow ? "change" : confirmDue ? "confirm" : "periodic";
        ok = sendReport(reason) == 204;
      }
    }
    if (ok) {
      reportNow = false;
      if (confirmDue) confirmAt = 0;
      lastReportMillis = millis();
      backoffMs = RETRY_MIN_MS;
    } else {
      retryAt = millis() + backoffMs;
      Serial.printf("Retry in %lu s\n", static_cast<unsigned long>(backoffMs / 1000));
      backoffMs = backoffMs * 2 > RETRY_MAX_MS ? RETRY_MAX_MS : backoffMs * 2;
    }
  }
  delay(GRID_SAMPLE_MS);
}
