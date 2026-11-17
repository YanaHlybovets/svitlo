import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, MAX_SUBSCRIPTIONS, type Update } from "../src/telegram/bot.ts";
import type { TelegramClient, TgResult } from "../src/telegram/client.ts";
import { normalize, searchBuildings } from "../src/telegram/search.ts";
import { alertText, clock, duration, shortAddress, statusLine } from "../src/telegram/text.ts";
import { BASE, resetState } from "./helpers.ts";

// Each test gets its own chat, so the per-chat rate limiter (shared within this file) never interferes.
let CHAT = 1000;
const NOW = 1_794_900_000; // 2026-11-16 ~17:20 Kyiv

interface Call { method: string; params: Record<string, unknown> }

function fakeTelegram(fail?: (method: string) => TgResult | undefined) {
  const calls: Call[] = [];
  const client: TelegramClient = {
    async call<T>(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      return (fail?.(method) ?? { ok: true, result: true }) as TgResult<T>;
    },
  };
  const sent = () => calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText");
  const last = () => sent().at(-1)?.params as { chat_id: number; text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } };
  const buttons = () => last()?.reply_markup?.inline_keyboard.flat().map((b) => b.callback_data) ?? [];
  return { client, calls, last, buttons };
}

let nextId = 1;
const text = (t: string, chat = CHAT, type = "private", language_code = "uk"): Update => ({
  update_id: nextId++,
  message: { message_id: nextId++, chat: { id: chat, type }, from: { id: chat, language_code }, text: t },
});
const press = (data: string, chat = CHAT): Update => ({
  update_id: nextId++,
  callback_query: { id: `cb${nextId++}`, from: { id: chat }, data, message: { message_id: 50, chat: { id: chat, type: "private" } } },
});

async function subscriptions(chat = CHAT) {
  const { results } = await env.DB.prepare("SELECT building_id FROM subscriptions WHERE chat_id = ?").bind(chat).all();
  return results.map((r) => r.building_id);
}

beforeEach(async () => {
  CHAT += 1;
  await resetState();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM building_requests"),
    env.DB.prepare("DELETE FROM subscriptions"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM buildings WHERE id > 1"),
    env.DB.prepare("UPDATE buildings SET status = 'on', status_since = ? WHERE id = 1").bind(NOW - 7500),
  ]);
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(duration(30, "uk")).toBe("<1 хв");
    expect(duration(42 * 60, "uk")).toBe("42 хв");
    expect(duration(5 * 3600 + 42 * 60, "uk")).toBe("5 год 42 хв");
    expect(duration(2 * 3600 + 5 * 60, "uk")).toBe("2 год 05 хв");
    expect(duration(27 * 3600, "en")).toBe("1 d 3 h");
  });

  it("shows Kyiv time, with the date when it is not today", () => {
    expect(clock(NOW, NOW)).toMatch(/^\d{2}:\d{2}$/);
    expect(clock(NOW - 86_400 * 2, NOW)).toMatch(/^\d{2}\.\d{2} \d{2}:\d{2}$/);
    // 2026-11-16 16:52 UTC = 18:52 in Kyiv (UTC+2 in winter)
    expect(clock(Date.UTC(2026, 10, 16, 16, 52) / 1000, Date.UTC(2026, 10, 16, 20, 0) / 1000)).toBe("18:52");
  });

  it("formats alerts as in the plan, address first", () => {
    const b = { address_uk: "вул. Ревуцького, 54а", address_en: "Revutskoho St, 54a" };
    const at = Date.UTC(2026, 10, 16, 16, 52) / 1000;
    expect(shortAddress(b, "uk")).toBe("Ревуцького 54а");
    expect(alertText(b, "off", at, 5 * 3600 + 42 * 60, "uk", at)).toBe("🪫 Ревуцького 54а: світло зникло о 18:52 (було 5 год 42 хв)");
    expect(alertText(b, "on", at, 3600 + 55 * 60, "uk", at)).toBe("💡 Ревуцького 54а: світло є з 18:52 (не було 1 год 55 хв)");
    expect(alertText(b, "off", at, null, "en", at)).toBe("🪫 Revutskoho St 54a: power went off at 18:52");
  });

  it("shows maintenance and no-data status lines", () => {
    const b = { address_uk: "вул. Ревуцького, 54а", address_en: "x", status: "no_data" as const, status_since: null, maintenance: 0 };
    expect(statusLine(b, "uk", NOW)).toBe("❔ Ревуцького 54а — немає даних");
    expect(statusLine({ ...b, maintenance: 1 }, "uk", NOW)).toBe("🛠 Ревуцького 54а — технічні роботи з датчиком");
  });
});

describe("address search", () => {
  const buildings = [
    { id: 1, slug: "revutskogo-54a", address_uk: "вул. Ревуцького, 54а", address_en: "Revutskoho St, 54a" },
    { id: 2, slug: "revutskogo-7", address_uk: "вул. Ревуцького, 7", address_en: "Revutskoho St, 7" },
    { id: 3, slug: "mayakovskogo-1", address_uk: "просп. Маяковського, 1", address_en: "Mayakovskoho Ave, 1" },
  ];
  it.each([
    ["Ревуцького 54а", [1]],
    ["ревуцкого 54а", [1]],
    ["revutskogo 54a", [1]],
    ["вул. Ревуцького", [1, 2]],
    ["маяковського", [3]],
    ["хрещатик", []],
  ])("%s", (query, ids) => {
    expect(searchBuildings(buildings, query).map((b) => b.id)).toEqual(ids);
  });
  it("ignores street-type words", () => expect(normalize("вул. Ревуцького")).toEqual(["revutskoho"]));
});

describe("bot", () => {
  it("/start creates the user and shows the welcome with buttons", async () => {
    const tg = fakeTelegram();
    await handleUpdate(text("/start"), env, tg.client, NOW);
    expect(tg.last().text).toContain("Привіт!");
    expect(tg.buttons()).toEqual(["add", "my", "settings"]);
    const user = await env.DB.prepare("SELECT language, blocked FROM users WHERE telegram_chat_id = ?").bind(CHAT).first();
    expect(user).toEqual({ language: "uk", blocked: 0 });
  });

  it("uses English for English-language Telegram users", async () => {
    const tg = fakeTelegram();
    await handleUpdate(text("/start", CHAT, "private", "en-GB"), env, tg.client, NOW);
    expect(tg.last().text).toContain("Hi!");
  });

  it("finds an address by text and subscribes with one tap", async () => {
    const tg = fakeTelegram();
    await handleUpdate(text("ревуцкого 54а"), env, tg.client, NOW);
    expect(tg.buttons()).toEqual(["s:1"]);
    await handleUpdate(press("s:1"), env, tg.client, NOW);
    expect(await subscriptions()).toEqual([1]);
    expect(tg.last().text).toContain("Готово!");
    expect(tg.last().text).toContain("💡 Ревуцького 54а — світло є з");
    expect(tg.calls.at(-1)?.method).toBe("answerCallbackQuery");
  });

  it("offers a sensor request when nothing is found", async () => {
    const tg = fakeTelegram();
    await handleUpdate(text("Хрещатик 1"), env, tg.client, NOW);
    expect(tg.last().text).toContain("Не знайшов");
    expect(tg.buttons()).toEqual(["req", "add"]);
  });

  it("browses by district", async () => {
    const tg = fakeTelegram();
    await handleUpdate(press("add"), env, tg.client, NOW);
    expect(tg.buttons()).toEqual(["d:darnytskyi", "req"]);
    await handleUpdate(press("d:darnytskyi"), env, tg.client, NOW);
    expect(tg.last().text).toContain("Дарницький");
    expect(tg.buttons()).toEqual(["s:1"]);
  });

  it("subscribes from a deep link", async () => {
    const tg = fakeTelegram();
    await handleUpdate(text("/start b_revutskogo-54a"), env, tg.client, NOW);
    expect(await subscriptions()).toEqual([1]);
    await handleUpdate(text("/start b_nowhere"), env, tg.client, NOW);
    expect(tg.last().text).toContain("Не знайшов");
  });

  it("ignores forged or unknown button data", async () => {
    const tg = fakeTelegram();
    for (const data of ["s:999", "s:abc", "s:1;DROP", "u:", "q:12-34", "d:../x", "zzz"]) {
      await handleUpdate(press(data), env, tg.client, NOW);
    }
    expect(await subscriptions()).toEqual([]);
    expect(tg.calls.filter((c) => c.method === "answerCallbackQuery")).toHaveLength(7);
  });

  it("limits subscriptions per user", async () => {
    const tg = fakeTelegram();
    const inserts = Array.from({ length: MAX_SUBSCRIPTIONS }, (_, i) =>
      env.DB.prepare("INSERT INTO buildings (slug, address_uk, address_en, district) VALUES (?, ?, ?, 'darnytskyi')").bind(`b-${i}`, `вул. Тестова, ${i}`, `Test St, ${i}`),
    );
    await env.DB.batch(inserts);
    await handleUpdate(text("/start"), env, tg.client, NOW);
    await env.DB.prepare("INSERT INTO subscriptions (chat_id, building_id) SELECT ?, id FROM buildings WHERE id > 1").bind(CHAT).run();
    await handleUpdate(press("s:1"), env, tg.client, NOW);
    expect(tg.last().text).toContain("щонайбільше за 20");
    expect(await subscriptions()).not.toContain(1);
  });

  it("/my lists addresses with status and unsubscribes", async () => {
    const tg = fakeTelegram();
    await handleUpdate(text("/start b_revutskogo-54a"), env, tg.client, NOW);
    await handleUpdate(text("/my"), env, tg.client, NOW);
    expect(tg.last().text).toContain("Ваші адреси:");
    expect(tg.buttons()).toEqual(["u:1", "add"]);
    await handleUpdate(press("u:1"), env, tg.client, NOW);
    expect(await subscriptions()).toEqual([]);
    expect(tg.calls.at(-1)?.params).toMatchObject({ text: "Відписано." });
  });

  it("/status shows every followed address", async () => {
    const tg = fakeTelegram();
    await handleUpdate(text("/start b_revutskogo-54a"), env, tg.client, NOW);
    await handleUpdate(text("/status"), env, tg.client, NOW);
    expect(tg.last().text).toMatch(/^💡 Ревуцького 54а — світло є з \d{2}:\d{2} \(2 год 05 хв\)$/);
  });

  it("changes language and quiet hours in settings", async () => {
    const tg = fakeTelegram();
    await handleUpdate(press("lang:en"), env, tg.client, NOW);
    expect(tg.last().text).toContain("Language: English");
    await handleUpdate(press("q:23-08"), env, tg.client, NOW);
    expect(tg.last().text).toContain("Quiet hours: 23:00–08:00");
    const user = await env.DB.prepare("SELECT language, quiet_from, quiet_to FROM users WHERE telegram_chat_id = ?").bind(CHAT).first();
    expect(user).toEqual({ language: "en", quiet_from: 1380, quiet_to: 480 });
    await handleUpdate(press("q:off"), env, tg.client, NOW);
    expect(tg.last().text).toContain("Quiet hours: off");
  });

  it("/delete_me removes the user and everything they stored", async () => {
    const tg = fakeTelegram();
    await handleUpdate(text("/start b_revutskogo-54a"), env, tg.client, NOW);
    await handleUpdate(press("req"), env, tg.client, NOW);
    await handleUpdate(text("Хрещатик 1"), env, tg.client, NOW);
    await handleUpdate(text("/delete_me"), env, tg.client, NOW);
    expect(tg.buttons()).toEqual(["del:yes", "del:no"]);
    await handleUpdate(press("del:yes"), env, tg.client, NOW);
    const counts = await env.DB.batch<{ n: number }>([
      env.DB.prepare("SELECT COUNT(*) AS n FROM users"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM building_requests"),
    ]);
    expect(counts.map((c) => c.results[0]?.n)).toEqual([0, 0, 0]);
  });

  it("collects a sensor request and forwards it to the admin", async () => {
    const tg = fakeTelegram();
    await handleUpdate(press("req"), env, tg.client, NOW);
    await handleUpdate(text("Хрещатик 1, можу бути господарем"), env, tg.client, NOW);
    const forwarded = tg.calls.find((c) => c.method === "sendMessage" && c.params.chat_id === 999);
    expect(forwarded?.params.text).toContain("Хрещатик 1, можу бути господарем");
    expect(tg.last().text).toContain("Дякую!");
    // The next message is a normal search again.
    await handleUpdate(text("ревуцького"), env, tg.client, NOW);
    expect(tg.buttons()).toEqual(["s:1"]);
  });

  it("limits sensor requests to 3 a day", async () => {
    const tg = fakeTelegram();
    for (let i = 0; i < 5; i++) {
      await handleUpdate(press("req"), env, tg.client, NOW);
      await handleUpdate(text(`Адреса ${i}`), env, tg.client, NOW);
    }
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM building_requests").first<{ n: number }>();
    expect(row?.n).toBe(3);
  });

  it("rate-limits a chat that sends too many updates", async () => {
    const tg = fakeTelegram();
    for (let i = 0; i < 31; i++) await handleUpdate(press("my"), env, tg.client, NOW);
    expect(tg.calls.at(-1)).toMatchObject({ method: "answerCallbackQuery", params: { text: "Забагато запитів. Спробуйте за хвилину." } });
  });

  it("ignores group chats", async () => {
    const tg = fakeTelegram();
    await handleUpdate(text("/start", -500, "group"), env, tg.client, NOW);
    expect(tg.calls).toEqual([]);
  });

  it("marks users who block the bot, and unmarks them when they return", async () => {
    const tg = fakeTelegram();
    await handleUpdate(text("/start"), env, tg.client, NOW);
    await handleUpdate(
      { update_id: nextId++, my_chat_member: { chat: { id: CHAT, type: "private" }, new_chat_member: { status: "kicked" } } },
      env, tg.client, NOW,
    );
    const blocked = () => env.DB.prepare("SELECT blocked FROM users WHERE telegram_chat_id = ?").bind(CHAT).first("blocked");
    expect(await blocked()).toBe(1);
    await handleUpdate(text("/my"), env, tg.client, NOW);
    expect(await blocked()).toBe(0);
  });

  it("marks a user blocked when Telegram answers 403", async () => {
    const tg = fakeTelegram((m) => (m === "sendMessage" ? { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } : undefined));
    await handleUpdate(text("/start"), env, tg.client, NOW);
    expect(await env.DB.prepare("SELECT blocked FROM users WHERE telegram_chat_id = ?").bind(CHAT).first("blocked")).toBe(1);
  });
});

describe("POST /tg/webhook", () => {
  const groupUpdate = JSON.stringify(text("/start", -500, "group")); // needs no Telegram call
  const post = (headers: Record<string, string>, body = groupUpdate) =>
    exports.default.fetch(`${BASE}/tg/webhook`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("rejects requests without the secret token", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ "x-telegram-bot-api-secret-token": "wrong" })).status).toBe(401);
  });

  it("accepts requests with the secret token", async () => {
    const res = await post({ "x-telegram-bot-api-secret-token": "test-webhook-secret" });
    expect(res.status).toBe(200);
  });

  it("rejects malformed bodies", async () => {
    expect((await post({ "x-telegram-bot-api-secret-token": "test-webhook-secret" }, "not json")).status).toBe(400);
  });
});
