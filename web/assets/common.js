// Shared helpers for the Svitlo website. No dependencies, no cookies, no trackers.
// Everything user-specific (language, starred addresses) stays in this browser.

export const API = "/api/v1";
export const BOT = "https://t.me/yhLightBot";
export const POLL_MS = 60_000;

// ---------- storage (may be unavailable: private mode, blocked site data) ----------

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* fine: the page works without storage */
  }
}

// ---------- language ----------

const TEXT = {
  uk: {
    tagline: "Чи є світло у вашому будинку — у реальному часі",
    searchLabel: "Пошук адреси",
    searchPlaceholder: "Вулиця й номер, наприклад «Ревуцького 54а»",
    myAddresses: "Мої адреси",
    allBuildings: "Усі будинки",
    noResults: "Такої адреси ще немає.",
    wantSensor: "Хочу датчик у своєму будинку",
    loading: "Завантаження…",
    loadError: "Не вдалося завантажити дані. Спробуємо ще раз за хвилину.",
    updatedAt: (time) => `Оновлено о ${time}`,
    footerSource: "Дані надходять від датчика в самому будинку, а не з графіків ДТЕК.",
    footerBot: "Сповіщення в Telegram",
    footerCode: "Код проєкту",
    status: { on: "Світло є", off: "Світла немає", no_data: "Немає даних", maintenance: "Технічні роботи", unknown: "Ще немає даних" },
    since: (time, dur) => `з ${time} · ${dur}`,
    sinceShort: (time) => `з ${time}`,
    sensorUpdated: (ago) => `Датчик звітував ${ago}`,
    sensorNever: "Датчик ще не звітував",
    justNow: "щойно",
    ago: (dur) => `${dur} тому`,
    back: "← Усі адреси",
    notify: "Отримувати сповіщення в Telegram",
    notifyHint: "Бот напише, щойно світло зникне або з’явиться.",
    star: "Додати до моїх адрес",
    unstar: "Прибрати з моїх адрес",
    last24h: "Останні 24 години",
    last7d: "Останні 7 днів",
    hoursAgo24: "24 год тому",
    hoursAgo12: "12 год тому",
    now: "зараз",
    offTotal: (dur) => `Без світла: ${dur}`,
    offTotal7: (dur) => `Без світла за 7 днів: ${dur}`,
    noOutages: "Без відключень",
    flickers: (n) => `${n} короткі перепади`,
    today: "Сьогодні",
    yesterday: "Вчора",
    notFound: "Такої адреси немає.",
    maintenanceNote: "Датчик на обслуговуванні, сповіщення тимчасово вимкнені.",
    noDataNote: "Датчик зараз не на зв’язку. Щойно він повернеться, статус оновиться.",
    legendFlicker: "короткий перепад",
    unit: { d: "д", h: "год", m: "хв", s: "с" },
    langSwitch: "EN",
    langSwitchLabel: "Switch to English",
    districts: {
      darnytskyi: "Дарницький", desnianskyi: "Деснянський", dniprovskyi: "Дніпровський", holosiivskyi: "Голосіївський",
      obolonskyi: "Оболонський", pecherskyi: "Печерський", podilskyi: "Подільський", shevchenkivskyi: "Шевченківський",
      solomianskyi: "Солом’янський", sviatoshynskyi: "Святошинський",
    },
    locale: "uk-UA",
  },
  en: {
    tagline: "Is there power in your building — in real time",
    searchLabel: "Search for an address",
    searchPlaceholder: "Street and number, e.g. “Revutskoho 54a”",
    myAddresses: "My addresses",
    allBuildings: "All buildings",
    noResults: "No such address yet.",
    wantSensor: "I want a sensor in my building",
    loading: "Loading…",
    loadError: "Couldn’t load the data. Trying again in a minute.",
    updatedAt: (time) => `Updated at ${time}`,
    footerSource: "The data comes from a sensor in the building itself, not from DTEK schedules.",
    footerBot: "Telegram alerts",
    footerCode: "Source code",
    status: { on: "Power on", off: "No power", no_data: "No data", maintenance: "Maintenance", unknown: "No data yet" },
    since: (time, dur) => `since ${time} · ${dur}`,
    sinceShort: (time) => `since ${time}`,
    sensorUpdated: (ago) => `Sensor reported ${ago}`,
    sensorNever: "The sensor hasn’t reported yet",
    justNow: "just now",
    ago: (dur) => `${dur} ago`,
    back: "← All addresses",
    notify: "Get alerts in Telegram",
    notifyHint: "The bot messages you as soon as the power goes off or comes back.",
    star: "Add to my addresses",
    unstar: "Remove from my addresses",
    last24h: "Last 24 hours",
    last7d: "Last 7 days",
    hoursAgo24: "24 h ago",
    hoursAgo12: "12 h ago",
    now: "now",
    offTotal: (dur) => `Without power: ${dur}`,
    offTotal7: (dur) => `Without power in 7 days: ${dur}`,
    noOutages: "No outages",
    flickers: (n) => `${n} short drops`,
    today: "Today",
    yesterday: "Yesterday",
    notFound: "There’s no such address.",
    maintenanceNote: "The sensor is under maintenance; alerts are paused.",
    noDataNote: "The sensor is offline right now. The status updates as soon as it’s back.",
    legendFlicker: "short drop",
    unit: { d: "d", h: "h", m: "min", s: "s" },
    langSwitch: "УКР",
    langSwitchLabel: "Перейти на українську",
    districts: {
      darnytskyi: "Darnytskyi", desnianskyi: "Desnianskyi", dniprovskyi: "Dniprovskyi", holosiivskyi: "Holosiivskyi",
      obolonskyi: "Obolonskyi", pecherskyi: "Pecherskyi", podilskyi: "Podilskyi", shevchenkivskyi: "Shevchenkivskyi",
      solomianskyi: "Solomianskyi", sviatoshynskyi: "Sviatoshynskyi",
    },
    locale: "en-GB",
  },
};

export let lang = load("svitlo.lang", "uk") === "en" ? "en" : "uk";
export const t = () => TEXT[lang];

/** Fills elements marked data-i18n="key" and wires the language switch. */
export function setupLanguage(onChange) {
  const apply = () => {
    document.documentElement.lang = lang;
    for (const node of document.querySelectorAll("[data-i18n]")) {
      const value = t()[node.dataset.i18n];
      if (typeof value === "string") node.textContent = value;
    }
    for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
      node.placeholder = t()[node.dataset.i18nPlaceholder];
    }
    const sw = document.getElementById("lang-switch");
    if (sw) {
      sw.textContent = t().langSwitch;
      sw.setAttribute("aria-label", t().langSwitchLabel);
    }
  };
  document.getElementById("lang-switch")?.addEventListener("click", () => {
    lang = lang === "uk" ? "en" : "uk";
    save("svitlo.lang", lang);
    apply();
    onChange();
  });
  apply();
}

// ---------- time (always Kyiv) ----------

const ZONE = (() => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: "Europe/Kyiv" });
    return "Europe/Kyiv";
  } catch {
    return "Europe/Kiev"; // older browsers
  }
})();

export function kyivParts(ts) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ts * 1000));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

/** Unix time of Kyiv midnight on the day containing `ts`, `daysBack` days earlier. */
export function kyivMidnight(ts, daysBack = 0) {
  const p = kyivParts(ts);
  const offset = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 1000 - ts;
  return Date.UTC(p.y, p.mo - 1, p.d - daysBack) / 1000 - offset;
}

const pad = (n) => String(n).padStart(2, "0");

/** "18:52" today, otherwise "16.11 18:52". */
export function clock(ts, now) {
  const a = kyivParts(ts);
  const b = kyivParts(now);
  const time = `${pad(a.h)}:${pad(a.mi)}`;
  return a.y === b.y && a.mo === b.mo && a.d === b.d ? time : `${pad(a.d)}.${pad(a.mo)} ${time}`;
}

export function dayLabel(ts, now) {
  const today = kyivMidnight(now);
  if (ts >= today) return t().today;
  if (ts >= kyivMidnight(now, 1)) return t().yesterday;
  return new Intl.DateTimeFormat(t().locale, { timeZone: ZONE, weekday: "short", day: "numeric", month: "numeric" }).format(new Date(ts * 1000));
}

/** "5 год 42 хв", "1 д 3 год", "<1 хв" */
export function duration(seconds) {
  const u = t().unit;
  const total = Math.max(0, Math.floor(seconds / 60));
  if (total < 1) return `<1 ${u.m}`;
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return h > 0 ? `${d} ${u.d} ${h} ${u.h}` : `${d} ${u.d}`;
  if (h > 0) return m > 0 ? `${h} ${u.h} ${pad(m)} ${u.m}` : `${h} ${u.h}`;
  return `${m} ${u.m}`;
}

export function ago(ts, now) {
  const s = Math.max(0, now - ts);
  if (s < 15) return t().justNow;
  if (s < 60) return t().ago(`${s} ${t().unit.s}`);
  return t().ago(duration(s));
}

export const nowS = () => Math.floor(Date.now() / 1000);

// ---------- buildings ----------

/** "on" | "off" | "no_data" | "maintenance" */
export function statusKey(b) {
  return b.maintenance ? "maintenance" : b.status;
}

export const STATUS_ICON = { on: "💡", off: "🪫", no_data: "❔", maintenance: "🛠", unknown: "·" };

export function shortAddress(b) {
  const full = lang === "uk" ? b.address_uk : b.address_en;
  return full.replace(/^(вул\.|вулиця|просп\.|проспект|пров\.|провулок|бульв\.|бульвар|пл\.|площа)\s+/i, "").replace(/,\s*/g, " ").trim();
}

export function districtName(key) {
  return t().districts[key] ?? key;
}

// Same tolerant matching as the bot: Ukrainian, Russian or Latin spelling.
const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i",
  ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
  ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ы: "y", э: "e", ё: "e", ъ: "",
};
const STOP = new Set(["vul", "vulytsia", "vulitsa", "ulitsa", "ul", "st", "street", "prosp", "prospekt", "pr", "avenue", "ave",
  "prov", "provulok", "lane", "bulv", "bulvar", "boulevard", "blvd", "pl", "ploshcha", "square"]);

export function normalize(text) {
  return Array.from(text.toLowerCase(), (ch) => TRANSLIT[ch] ?? ch).join("")
    .replace(/g/g, "h").replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !STOP.has(w));
}

export function matches(b, query) {
  const words = normalize(query);
  if (words.length === 0) return true;
  const hay = normalize(`${b.address_uk} ${b.address_en} ${b.slug}`).join(" ");
  return words.every((w) => hay.includes(w));
}

// ---------- starred addresses (this browser only) ----------

export function starred() {
  const list = load("svitlo.starred", []);
  return new Set(Array.isArray(list) ? list.filter((s) => typeof s === "string") : []);
}
export function toggleStar(slug) {
  const set = starred();
  set.has(slug) ? set.delete(slug) : set.add(slug);
  save("svitlo.starred", [...set]);
  return set.has(slug);
}

// ---------- network ----------

export async function getJSON(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

/** Runs `fn` now and every POLL_MS while the tab is visible; at once when it becomes visible again. */
export function poll(fn) {
  let timer = null;
  const start = () => {
    if (timer !== null) return;
    fn();
    timer = setInterval(fn, POLL_MS);
  };
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  if (!document.hidden) start();
}

// ---------- DOM (text only: never innerHTML with data) ----------

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function registerServiceWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
