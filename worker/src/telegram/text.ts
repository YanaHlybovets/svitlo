// Bot texts (Ukrainian first, English) and formatting. Times are shown in Kyiv time.

import type { Status } from "../status.ts";

export type Lang = "uk" | "en";

const KYIV = "Europe/Kyiv";

const DISTRICTS: Record<string, { uk: string; en: string }> = {
  darnytskyi: { uk: "Дарницький", en: "Darnytskyi" },
  desnianskyi: { uk: "Деснянський", en: "Desnianskyi" },
  dniprovskyi: { uk: "Дніпровський", en: "Dniprovskyi" },
  holosiivskyi: { uk: "Голосіївський", en: "Holosiivskyi" },
  obolonskyi: { uk: "Оболонський", en: "Obolonskyi" },
  pecherskyi: { uk: "Печерський", en: "Pecherskyi" },
  podilskyi: { uk: "Подільський", en: "Podilskyi" },
  shevchenkivskyi: { uk: "Шевченківський", en: "Shevchenkivskyi" },
  solomianskyi: { uk: "Солом’янський", en: "Solomianskyi" },
  sviatoshynskyi: { uk: "Святошинський", en: "Sviatoshynskyi" },
};

export function districtName(key: string, lang: Lang): string {
  return DISTRICTS[key]?.[lang] ?? key;
}

export interface BuildingView {
  address_uk: string;
  address_en: string;
  status: Status;
  status_since: number | null;
  maintenance: number;
}

/** "вул. Ревуцького, 54а" -> "Ревуцького 54а"; "Revutskoho St, 54a" -> "Revutskoho St 54a". */
export function shortAddress(b: Pick<BuildingView, "address_uk" | "address_en">, lang: Lang): string {
  const full = lang === "uk" ? b.address_uk : b.address_en;
  return full
    .replace(/^(вул\.|вулиця|просп\.|проспект|пров\.|провулок|бульв\.|бульвар|пл\.|площа)\s+/i, "")
    .replace(/,\s*/g, " ")
    .trim();
}

/** "5 год 42 хв", "1 д 3 год", "<1 хв" */
export function duration(seconds: number, lang: Lang): string {
  const u = lang === "uk" ? { d: "д", h: "год", m: "хв" } : { d: "d", h: "h", m: "min" };
  const total = Math.max(0, Math.floor(seconds / 60));
  if (total < 1) return `<1 ${u.m}`;
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return h > 0 ? `${d} ${u.d} ${h} ${u.h}` : `${d} ${u.d}`;
  if (h > 0) return m > 0 ? `${h} ${u.h} ${m.toString().padStart(2, "0")} ${u.m}` : `${h} ${u.h}`;
  return `${m} ${u.m}`;
}

const kyivParts = (ts: number) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: KYIV, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ts * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, day: get("day"), month: get("month"), time: `${get("hour")}:${get("minute")}` };
};

/** "18:52" today (Kyiv), otherwise "16.11 18:52". */
export function clock(ts: number, now: number): string {
  const t = kyivParts(ts);
  return t.date === kyivParts(now).date ? t.time : `${t.day}.${t.month} ${t.time}`;
}

/** Minutes after midnight in Kyiv. */
export function kyivMinutes(ts: number): number {
  const [h, m] = kyivParts(ts).time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function statusLine(b: BuildingView, lang: Lang, now: number): string {
  const addr = shortAddress(b, lang);
  if (b.maintenance === 1) return lang === "uk" ? `🛠 ${addr} — технічні роботи з датчиком` : `🛠 ${addr} — sensor maintenance`;
  const since = b.status_since;
  const tail = since === null ? "" : ` ${clock(since, now)} (${duration(now - since, lang)})`;
  switch (b.status) {
    case "on":
      return lang === "uk" ? `💡 ${addr} — світло є${since === null ? "" : " з"}${tail}` : `💡 ${addr} — power on${since === null ? "" : " since"}${tail}`;
    case "off":
      return lang === "uk" ? `🪫 ${addr} — світла немає${since === null ? "" : " з"}${tail}` : `🪫 ${addr} — no power${since === null ? "" : " since"}${tail}`;
    default:
      return lang === "uk"
        ? `❔ ${addr} — немає даних${since === null ? "" : ` з ${clock(since, now)}`}`
        : `❔ ${addr} — no data${since === null ? "" : ` since ${clock(since, now)}`}`;
  }
}

/** The alert sent to subscribers (Step 6). Starts with the address, as users may follow several. */
export function alertText(
  b: Pick<BuildingView, "address_uk" | "address_en">,
  status: "on" | "off",
  at: number,
  prevDuration: number | null,
  lang: Lang,
  now: number,
): string {
  const addr = shortAddress(b, lang);
  const time = clock(at, now);
  const was = prevDuration === null ? "" : ` (${lang === "uk" ? (status === "off" ? "було" : "не було") : status === "off" ? "was on for" : "was off for"} ${duration(prevDuration, lang)})`;
  if (status === "off") return lang === "uk" ? `🪫 ${addr}: світло зникло о ${time}${was}` : `🪫 ${addr}: power went off at ${time}${was}`;
  return lang === "uk" ? `💡 ${addr}: світло є з ${time}${was}` : `💡 ${addr}: power is back since ${time}${was}`;
}

export const QUIET_PRESETS = {
  off: null,
  "22-07": [22 * 60, 7 * 60],
  "23-08": [23 * 60, 8 * 60],
  "00-07": [0, 7 * 60],
} as const satisfies Record<string, readonly [number, number] | null>;
export type QuietPreset = keyof typeof QUIET_PRESETS;

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function quietLabel(from: number | null, to: number | null, lang: Lang): string {
  if (from === null || to === null) return lang === "uk" ? "вимкнено" : "off";
  return `${hhmm(from)}–${hhmm(to)}`;
}

export const T = {
  uk: {
    welcome:
      "Привіт! Я повідомляю, коли в обраних будинках зникає або з’являється світло.\n\n" +
      "Дані надходять від датчика в самому будинку, а не з графіків ДТЕК.\n\nДодайте адресу, щоб почати.",
    addAddress: "➕ Додати адресу",
    myAddresses: "📋 Мої адреси",
    settings: "⚙️ Налаштування",
    askAddress: "Напишіть назву вулиці й номер будинку (наприклад, «Ревуцького 54а») або оберіть район:",
    chooseBuilding: "Оберіть будинок:",
    found: "Ось що я знайшов:",
    notFound: "Не знайшов такої адреси. Можливо, датчика там ще немає.",
    tooShort: "Напишіть щонайменше 2 літери назви вулиці.",
    wantSensor: "🙋 Хочу датчик у своєму будинку",
    byDistrict: "🗺 Обрати район",
    noBuildings: "Поки що немає будинків із датчиком.",
    subscribed: "Готово! Надішлю сповіщення, коли тут зникне або з’явиться світло.",
    alreadySubscribed: "Ви вже стежите за цією адресою.",
    tooMany: "Можна стежити щонайбільше за 20 адресами. Спершу відпишіться від якоїсь.",
    noAddresses: "У вас ще немає адрес.",
    yourAddresses: "Ваші адреси:",
    unsubscribe: "Відписатися",
    unsubscribed: "Відписано.",
    unknownBuilding: "Цієї адреси більше немає.",
    askRequest:
      "Напишіть адресу будинку, де хочете датчик (вулиця й номер).\n\n" +
      "Якщо у вас є вільна розетка й ви готові тримати датчик у квартирі, напишіть і про це.",
    requestThanks: "Дякую! Я передав запит. Коли датчик з’явиться, адресу можна буде додати тут.",
    requestTooLong: "Задовго. Напишіть коротше, до 200 символів.",
    settingsTitle: (lang: string, quiet: string) =>
      `Налаштування\n\nМова: ${lang}\nТихі години: ${quiet}\n\nУ тихі години сповіщення приходять без звуку.`,
    quietOff: "🔔 Без тихих годин",
    deleteAsk: "Видалити всі ваші дані (адреси й налаштування)? Це не можна скасувати.",
    deleteYes: "Так, видалити",
    cancel: "Скасувати",
    deleted: "Готово. Усі ваші дані видалено. Щоб почати знову, надішліть /start.",
    cancelled: "Скасовано.",
    help:
      "Команди:\n/my — мої адреси\n/status — статус моїх адрес\n/add — додати адресу\n/settings — мова й тихі години\n/delete_me — видалити мої дані",
    slowDown: "Забагато запитів. Спробуйте за хвилину.",
    languageName: "Українська",
  },
  en: {
    welcome:
      "Hi! I let you know when the power goes off or comes back in the buildings you choose.\n\n" +
      "The data comes from a sensor in the building itself, not from DTEK schedules.\n\nAdd an address to start.",
    addAddress: "➕ Add address",
    myAddresses: "📋 My addresses",
    settings: "⚙️ Settings",
    askAddress: "Type the street name and building number (for example, “Revutskoho 54a”) or choose a district:",
    chooseBuilding: "Choose a building:",
    found: "Here’s what I found:",
    notFound: "I couldn’t find that address. There may be no sensor there yet.",
    tooShort: "Type at least 2 letters of the street name.",
    wantSensor: "🙋 I want a sensor in my building",
    byDistrict: "🗺 Choose a district",
    noBuildings: "There are no buildings with a sensor yet.",
    subscribed: "Done! I’ll message you when the power goes off or comes back here.",
    alreadySubscribed: "You already follow this address.",
    tooMany: "You can follow up to 20 addresses. Unsubscribe from one first.",
    noAddresses: "You have no addresses yet.",
    yourAddresses: "Your addresses:",
    unsubscribe: "Unsubscribe",
    unsubscribed: "Unsubscribed.",
    unknownBuilding: "This address no longer exists.",
    askRequest:
      "Type the address of the building where you want a sensor (street and number).\n\n" +
      "If you have a free socket and could keep the sensor in your flat, mention that too.",
    requestThanks: "Thank you! I’ve passed on your request. Once there’s a sensor, you can add the address here.",
    requestTooLong: "Too long. Please keep it under 200 characters.",
    settingsTitle: (lang: string, quiet: string) =>
      `Settings\n\nLanguage: ${lang}\nQuiet hours: ${quiet}\n\nDuring quiet hours, alerts arrive without sound.`,
    quietOff: "🔔 No quiet hours",
    deleteAsk: "Delete all your data (addresses and settings)? This can’t be undone.",
    deleteYes: "Yes, delete",
    cancel: "Cancel",
    deleted: "Done. All your data is deleted. Send /start to begin again.",
    cancelled: "Cancelled.",
    help:
      "Commands:\n/my — my addresses\n/status — status of my addresses\n/add — add an address\n/settings — language and quiet hours\n/delete_me — delete my data",
    slowDown: "Too many requests. Please try again in a minute.",
    languageName: "English",
  },
} as const;
