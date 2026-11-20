// Admin panel UI. All data comes from /api/* on this origin (behind Cloudflare Access).
// The DOM is built from text nodes only.

const $ = (id) => document.getElementById(id);
const DISTRICTS = {
  darnytskyi: "Дарницький", desnianskyi: "Деснянський", dniprovskyi: "Дніпровський", holosiivskyi: "Голосіївський",
  obolonskyi: "Оболонський", pecherskyi: "Печерський", podilskyi: "Подільський", shevchenkivskyi: "Шевченківський",
  solomianskyi: "Солом’янський", sviatoshynskyi: "Святошинський",
};
const STATUS = { on: "💡 Світло є", off: "🪫 Світла немає", no_data: "❔ Немає даних" };
const SILENT_AFTER_S = 180;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

const time = (ts) =>
  ts ? new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ts * 1000)) : "—";
function ago(ts, now) {
  if (!ts) return "ніколи";
  const s = Math.max(0, now - ts);
  if (s < 60) return `${s} с тому`;
  if (s < 3600) return `${Math.floor(s / 60)} хв тому`;
  if (s < 86400) return `${Math.floor(s / 3600)} год тому`;
  return `${Math.floor(s / 86400)} д тому`;
}
const batteryPct = (mv) => Math.round(Math.min(Math.max((mv - 3300) / (4150 - 3300), 0), 1) * 100);
function signal(dbm) {
  if (dbm === null || dbm === undefined) return "—";
  const q = dbm >= -85 ? "добрий" : dbm >= -100 ? "середній" : "слабкий";
  return `${dbm} дБм (${q})`;
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-svitlo-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function act(fn) {
  try {
    showError("");
    await fn();
    await load();
  } catch (e) {
    showError(`Помилка: ${e.message}`);
  }
}

function showKey({ sensor_id, key }) {
  const panel = $("key-panel");
  const copy = el("button", { type: "button", onclick: async () => {
    try { await navigator.clipboard.writeText(key); copy.textContent = "Скопійовано ✓"; } catch { copy.textContent = "Скопіюйте вручну"; }
  } }, "Скопіювати ключ");
  panel.replaceChildren(
    el("h2", {}, "🔑 Ключ датчика — показується лише один раз"),
    el("p", {}, "Запишіть його у прошивку датчика (secrets.h). Після закриття цієї панелі його не можна буде побачити знову."),
    el("dl", {}, el("dt", {}, "ID датчика"), el("dd", {}, el("code", {}, sensor_id)), el("dt", {}, "Ключ"), el("dd", {}, el("code", { class: "key" }, key))),
    el("div", { class: "row" }, copy, el("button", { type: "button", class: "secondary", onclick: () => { panel.hidden = true; panel.replaceChildren(); } }, "Я зберіг ключ, закрити")),
  );
  panel.hidden = false;
  panel.scrollIntoView({ behavior: "smooth" });
}

function buildingCard(b, now) {
  const hasSensor = b.sensor_id !== null;
  const silent = hasSensor && (!b.last_seen || now - b.last_seen > SILENT_AFTER_S);
  const lowBattery = b.battery_mv !== null && b.battery_mv < 3500;
  const flag = (path, value, label, confirmText) =>
    el("button", { type: "button", class: "secondary", onclick: () => {
      if (confirmText && !window.confirm(confirmText)) return;
      act(() => api("POST", `/api/buildings/${b.id}/${path}`, { value }));
    } }, label);

  return el("article", { class: `building ${b.active ? "" : "inactive"}` },
    el("div", { class: "building-head" },
      el("div", {},
        el("h3", {}, b.address_uk),
        el("p", { class: "muted" }, `${b.address_en} · ${DISTRICTS[b.district] ?? b.district} · /b/${b.slug}`),
      ),
      el("div", { class: "tags" },
        el("span", { class: `tag status-${b.status}` }, STATUS[b.status] ?? b.status),
        b.maintenance ? el("span", { class: "tag warn" }, "🛠 Обслуговування") : null,
        b.active ? null : el("span", { class: "tag" }, "Приховано"),
        el("span", { class: "tag" }, `👥 ${b.subscribers}`),
      ),
    ),
    hasSensor
      ? el("dl", { class: "health" },
          el("div", {}, el("dt", {}, "Датчик"), el("dd", {}, el("code", {}, b.sensor_id), b.sensor_enabled ? "" : " (вимкнено)")),
          el("div", { class: silent ? "bad" : "" }, el("dt", {}, "Останній звіт"), el("dd", {}, ago(b.last_seen, now))),
          el("div", { class: lowBattery ? "bad" : "" }, el("dt", {}, "Батарея"), el("dd", {}, b.battery_mv ? `${b.battery_mv} мВ (~${batteryPct(b.battery_mv)}%)` : "—")),
          el("div", { class: b.wifi_rssi !== null && b.wifi_rssi < -100 ? "bad" : "" }, el("dt", {}, "Сигнал"), el("dd", {}, signal(b.wifi_rssi))),
          el("div", {}, el("dt", {}, "Прошивка"), el("dd", {}, b.firmware ?? "—")),
          el("div", {}, el("dt", {}, "Статус з"), el("dd", {}, time(b.status_since))),
        )
      : el("p", { class: "muted" }, "Датчика ще немає."),
    el("div", { class: "row" },
      el("button", { type: "button", onclick: () => {
        if (hasSensor && !window.confirm("Видати датчику новий ключ? Старий перестане працювати, датчик треба буде перепрошити.")) return;
        act(async () => showKey(await api("POST", `/api/buildings/${b.id}/sensor_key`)));
      } }, hasSensor ? "🔑 Новий ключ" : "➕ Створити датчик"),
      flag("maintenance", !b.maintenance, b.maintenance ? "Завершити обслуговування" : "🛠 Обслуговування"),
      hasSensor ? flag("sensor_enabled", !b.sensor_enabled, b.sensor_enabled ? "Вимкнути датчик" : "Увімкнути датчик",
        b.sensor_enabled ? "Вимкнути датчик? Його звіти буде відхилено, будинок покаже «немає даних»." : null) : null,
      flag("active", !b.active, b.active ? "Сховати з сайту" : "Показати на сайті", b.active ? "Сховати будинок із сайту й бота?" : null),
    ),
  );
}

async function load() {
  let data;
  try {
    data = await api("GET", "/api/overview");
  } catch (e) {
    showError(`Не вдалося завантажити дані: ${e.message}`);
    return;
  }
  const now = data.now;
  const pendingRequests = data.requests.length;
  $("stats").replaceChildren(
    ...[
      ["Будинків", data.buildings.length],
      ["Користувачів", `${data.users.total}${data.users.blocked ? ` (${data.users.blocked} заблок.)` : ""}`],
      ["Підписок", data.subscriptions],
      ["Запитів", pendingRequests],
    ].map(([label, value]) => el("div", { class: "stat" }, el("span", { class: "stat-value" }, value), el("span", { class: "muted" }, label))),
  );
  $("buildings").replaceChildren(...data.buildings.map((b) => buildingCard(b, now)));

  const select = $("district");
  if (select.options.length === 0) select.append(...data.districts.map((d) => el("option", { value: d }, DISTRICTS[d] ?? d)));

  $("requests").replaceChildren(
    pendingRequests === 0
      ? el("p", { class: "muted" }, "Немає нових запитів.")
      : el("ul", { class: "list" }, data.requests.map((r) =>
          el("li", {},
            el("div", {}, el("strong", {}, r.text), el("p", { class: "muted" }, `${time(r.created_at)} · чат ${r.chat_id}`)),
            el("button", { type: "button", class: "secondary", onclick: () => act(() => api("DELETE", `/api/requests/${r.id}`)) }, "Закрити"),
          ))),
  );
  $("audit").replaceChildren(
    data.audit.length === 0
      ? el("p", { class: "muted" }, "Ще немає дій.")
      : el("ul", { class: "list audit" }, data.audit.map((a) =>
          el("li", {}, el("span", {}, `${time(a.at)} · ${a.action}`), el("span", { class: "muted" }, `${a.admin} · ${a.details ?? ""}`)))),
  );
}

async function loadUsage() {
  const box = $("usage");
  let data;
  try {
    const res = await fetch("/api/usage", { headers: { accept: "application/json" } });
    data = await res.json();
  } catch {
    box.replaceChildren(el("p", { class: "muted" }, "Не вдалося завантажити."));
    return;
  }
  if (!data.configured) {
    box.replaceChildren(el("p", { class: "muted" }, "Не налаштовано: потрібен токен CF_API_TOKEN (Account Analytics: Read)."));
    return;
  }
  if (data.error) {
    box.replaceChildren(el("p", { class: "muted" }, `Помилка Cloudflare API: ${data.error}`));
    return;
  }
  box.replaceChildren(el("div", { class: "meters" }, data.metrics.map((m) => {
    const pct = Math.min(100, Math.round(m.share * 1000) / 10);
    const fill = el("span", { class: `meter-fill ${m.share >= 0.9 ? "bad" : m.share >= 0.7 ? "warn" : ""}` });
    fill.style.width = `${pct}%`;
    return el("div", { class: "meter-row" },
      el("div", { class: "meter-label" }, el("span", {}, m.label), el("span", { class: "muted" }, `${m.used.toLocaleString("uk-UA")} / ${m.limit.toLocaleString("uk-UA")} · ${pct}%`)),
      el("div", { class: "meter", role: "img", "aria-label": `${m.label}: ${pct}%` }, fill),
    );
  })));
}

$("add-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = Object.fromEntries(new FormData(form));
  act(async () => {
    await api("POST", "/api/buildings", fields);
    form.reset();
  });
});

// Suggest a slug from the English address.
document.querySelector('[name="address_en"]').addEventListener("input", (e) => {
  const slug = document.querySelector('[name="slug"]');
  if (slug.dataset.touched) return;
  slug.value = e.target.value.toLowerCase()
    .replace(/\b(st|street|ave|avenue|blvd|boulevard|lane|square)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
});
document.querySelector('[name="slug"]').addEventListener("input", (e) => { e.target.dataset.touched = "1"; });

api("GET", "/api/me").then((me) => { $("me").textContent = me.email; }).catch(() => {});
load();
loadUsage();
setInterval(() => { if (!document.hidden) load(); }, 60_000);
setInterval(() => { if (!document.hidden) loadUsage(); }, 300_000);
