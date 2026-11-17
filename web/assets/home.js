import {
  API, BOT, STATUS_ICON, clock, districtName, duration, el, getJSON, matches, nowS, poll,
  registerServiceWorker, setupLanguage, shortAddress, starred, statusKey, t, toggleStar,
} from "./common.js";

const list = document.getElementById("buildings");
const search = document.getElementById("search");
const updated = document.getElementById("updated");
let data = null;
let failed = false;

function card(b, now, isStarred) {
  const key = statusKey(b);
  const since = b.status_since && key !== "maintenance" && key !== "no_data"
    ? t().since(clock(b.status_since, now), duration(now - b.status_since))
    : b.status_since && key === "no_data" ? t().sinceShort(clock(b.status_since, now)) : "";
  return el("li", { class: `card status-${key}` },
    el("a", { class: "card-link", href: `/b/${b.slug}` },
      el("span", { class: "card-address" }, shortAddress(b)),
      el("span", { class: "badge" }, el("span", { "aria-hidden": "true" }, STATUS_ICON[key]), " ", t().status[key]),
      since && el("span", { class: "card-since" }, since),
    ),
    el("button", {
      class: "star", type: "button", "aria-pressed": isStarred ? "true" : "false",
      "aria-label": `${isStarred ? t().unstar : t().star}: ${shortAddress(b)}`,
      title: isStarred ? t().unstar : t().star,
      onclick: () => { toggleStar(b.slug); render(); },
    }, isStarred ? "★" : "☆"),
  );
}

function section(title, buildings, now, stars) {
  return el("section", { class: "group" },
    el("h2", {}, title),
    el("ul", { class: "cards" }, buildings.map((b) => card(b, now, stars.has(b.slug)))),
  );
}

function render() {
  list.replaceChildren();
  if (data === null) {
    list.append(el("p", { class: "muted" }, failed ? t().loadError : t().loading));
    return;
  }
  const now = nowS();
  const stars = starred();
  const query = search.value.trim();
  const shown = data.buildings.filter((b) => matches(b, query));

  if (shown.length === 0) {
    list.append(el("div", { class: "empty" },
      el("p", {}, t().noResults),
      el("a", { class: "button", href: BOT, rel: "noopener" }, t().wantSensor),
    ));
  } else {
    const mine = shown.filter((b) => stars.has(b.slug));
    if (mine.length > 0) list.append(section(`★ ${t().myAddresses}`, mine, now, stars));
    const districts = [...new Set(shown.map((b) => b.district))].sort((a, b) => districtName(a).localeCompare(districtName(b)));
    for (const d of districts) list.append(section(districtName(d), shown.filter((b) => b.district === d), now, stars));
  }
  updated.textContent = data.generated_at ? t().updatedAt(clock(data.generated_at, now)) : "";
}

async function refresh() {
  try {
    data = await getJSON(`${API}/buildings`);
    failed = false;
  } catch {
    failed = true;
  }
  render();
}

search.addEventListener("input", render);
setupLanguage(render);
poll(refresh);
registerServiceWorker();
