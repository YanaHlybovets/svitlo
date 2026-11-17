import {
  API, BOT, STATUS_ICON, ago, clock, dayLabel, duration, el, getJSON, kyivMidnight, nowS, poll,
  registerServiceWorker, setupLanguage, shortAddress, starred, statusKey, t, toggleStar,
} from "./common.js";

const main = document.getElementById("main");
const slug = decodeURIComponent(location.pathname.replace(/^\/b\/?/, "").replace(/\/$/, ""));
const validSlug = /^[a-z0-9-]{1,64}$/.test(slug);
let building = null;
let history = null;
let state = "loading"; // loading | ready | missing | error

/** Splits [from, to) into status periods; time before the first record is "unknown". */
function segments(events, from, to) {
  const out = [];
  let cursor = from;
  for (const e of events) {
    const s = Math.max(e.started_at, from);
    const end = Math.min(e.ended_at ?? to, to);
    if (end <= s) continue;
    if (s > cursor) out.push({ status: "unknown", from: cursor, to: s });
    out.push({ status: e.status, from: s, to: end });
    cursor = Math.max(cursor, end);
  }
  if (cursor < to) out.push({ status: "unknown", from: cursor, to });
  return out;
}

const offSeconds = (segs) => segs.filter((s) => s.status === "off").reduce((sum, s) => sum + (s.to - s.from), 0);

function bar(from, to, now, label) {
  // Recorded periods up to now; the rest of the window (later today) is left empty.
  const segs = segments(history.events, from, Math.min(to, now));
  if (to > now) segs.push({ status: "future", from: now, to });
  const span = to - from;
  const node = el("div", { class: "bar", role: "img", "aria-label": label });
  for (const s of segs) {
    const part = el("span", {
      class: `seg seg-${s.status}`,
      title: s.status === "future" ? undefined : `${clock(s.from, now)}–${clock(s.to, now)} · ${t().status[s.status]} (${duration(s.to - s.from)})`,
    });
    part.style.width = `${((s.to - s.from) / span) * 100}%`;
    node.append(part);
  }
  for (const f of history.flickers.filter((f) => f.started_at >= from && f.started_at < to)) {
    const tick = el("span", { class: "flicker", title: `${clock(f.started_at, now)} · ${t().legendFlicker}` });
    tick.style.left = `${((f.started_at - from) / span) * 100}%`;
    node.append(tick);
  }
  return { node, segs };
}

/** Like main.append, but skips parts that are switched off (false/null). */
function append(...parts) {
  main.append(...parts.filter((p) => p instanceof Node));
}

function render() {
  const now = nowS();
  main.replaceChildren(el("a", { class: "back", href: "/" }, t().back));

  if (state === "loading") return main.append(el("p", { class: "muted" }, t().loading));
  if (state === "missing") return main.append(el("h1", {}, t().notFound));
  if (state === "error" && building === null) return main.append(el("p", { class: "muted" }, t().loadError));

  const b = building;
  const key = statusKey(b);
  const address = shortAddress(b);
  document.title = `${address} · ${t().status[key]} · Світло`;
  const isStarred = starred().has(b.slug);

  const since = b.status_since
    ? key === "on" || key === "off" ? t().since(clock(b.status_since, now), duration(now - b.status_since)) : t().sinceShort(clock(b.status_since, now))
    : "";

  append(
    el("div", { class: "title-row" },
      el("h1", {}, address),
      el("button", {
        class: "star star-large", type: "button", "aria-pressed": isStarred ? "true" : "false",
        "aria-label": isStarred ? t().unstar : t().star, title: isStarred ? t().unstar : t().star,
        onclick: () => { toggleStar(b.slug); render(); },
      }, isStarred ? "★" : "☆"),
    ),
    el("section", { class: `hero status-${key}`, "aria-live": "polite" },
      el("div", { class: "hero-icon", "aria-hidden": "true" }, STATUS_ICON[key]),
      el("div", {},
        el("p", { class: "hero-status" }, t().status[key]),
        since && el("p", { class: "hero-since" }, since),
        el("p", { class: "hero-updated" }, b.updated_at ? t().sensorUpdated(ago(b.updated_at, now)) : t().sensorNever),
      ),
    ),
    key === "maintenance" && el("p", { class: "note" }, t().maintenanceNote),
    key === "no_data" && el("p", { class: "note" }, t().noDataNote),
    el("a", { class: "button button-telegram", href: `${BOT}?start=b_${b.slug}`, rel: "noopener" }, t().notify),
    el("p", { class: "muted small" }, t().notifyHint),
  );

  if (history === null) return;

  // Last 24 hours.
  const day = bar(now - 86_400, now, now, t().last24h);
  main.append(el("section", { class: "panel" },
    el("h2", {}, t().last24h),
    day.node,
    el("div", { class: "axis", "aria-hidden": "true" }, el("span", {}, t().hoursAgo24), el("span", {}, t().hoursAgo12), el("span", {}, t().now)),
    el("p", { class: "muted" }, offSeconds(day.segs) > 0 ? t().offTotal(duration(offSeconds(day.segs))) : t().noOutages),
    legend(),
  ));

  // Last 7 days, one row per Kyiv calendar day.
  const rows = [];
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const from = kyivMidnight(now, i);
    const to = Math.min(kyivMidnight(now, i - 1), now);
    const full = kyivMidnight(now, i - 1);
    const row = bar(from, full, now, dayLabel(from, now));
    const off = offSeconds(segments(history.events, from, to));
    total += off;
    rows.push(el("div", { class: "day" },
      el("span", { class: "day-label" }, dayLabel(from, now)),
      row.node,
      el("span", { class: "day-off" }, off > 0 ? duration(off) : "—"),
    ));
  }
  main.append(el("section", { class: "panel" },
    el("h2", {}, t().last7d),
    el("div", { class: "days" }, rows),
    el("p", { class: "muted" }, total > 0 ? t().offTotal7(duration(total)) : t().noOutages),
  ));
}

function legend() {
  const item = (cls, text) => el("span", { class: "legend-item" }, el("span", { class: `swatch ${cls}` }), text);
  return el("div", { class: "legend" },
    item("seg-on", t().status.on), item("seg-off", t().status.off), item("seg-no_data", t().status.no_data),
    item("swatch-flicker", t().legendFlicker),
  );
}

async function refresh() {
  if (!validSlug) {
    state = "missing";
    return render();
  }
  try {
    const [list, hist] = await Promise.all([
      getJSON(`${API}/buildings`),
      getJSON(`${API}/buildings/${slug}/history?days=7`).catch((e) => (e.status === 404 ? null : Promise.reject(e))),
    ]);
    building = list.buildings.find((b) => b.slug === slug) ?? null;
    history = hist;
    state = building === null ? "missing" : "ready";
  } catch {
    state = "error";
  }
  render();
}

setupLanguage(render);
poll(refresh);
registerServiceWorker();
