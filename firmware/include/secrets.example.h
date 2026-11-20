#pragma once
// Copy this file to secrets.h (git-ignored) and fill it in for each sensor.

// From the admin panel: "Створити датчик" / "Новий ключ" shows both, once.
#define SENSOR_ID "s-revutskogo-54a"
#define SENSOR_KEY_B64 "PASTE-THE-KEY-FROM-THE-ADMIN-PANEL"

// Mobile data APN of the SIM card's operator. Check the operator's website;
// commonly "internet" (Vodafone, lifecell) and "www.kyivstar.net" (Kyivstar prepaid).
#define SIM_APN "internet"

// Leave empty if the SIM has no PIN (recommended: turn the PIN off in a phone first).
#define SIM_PIN ""
