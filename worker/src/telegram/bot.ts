// Telegram bot: one handler per update. The bot acts only on its own commands
// and buttons; every button's data is checked against the database before use.
// Only private chats are served. Stored per user: chat ID, language, quiet
// hours and subscriptions (plus sensor requests); /delete_me removes it all.

import { button, type Keyboard, type TelegramClient } from "./client.ts";
import { normalize, searchBuildings } from "./search.ts";
import {
  districtName, QUIET_PRESETS, quietLabel, shortAddress, statusLine, T,
  type BuildingView, type Lang, type QuietPreset,
} from "./text.ts";

export const MAX_SUBSCRIPTIONS = 20;
export const MAX_REQUEST_CHARS = 200;
export const MAX_REQUESTS_PER_DAY = 3;
const MAX_QUERY_CHARS = 64;

interface TgUser { id: number; language_code?: string }
interface TgChat { id: number; type: string }
interface TgMessage { message_id: number; chat: TgChat; from?: TgUser; text?: string }
interface TgCallback { id: string; from: TgUser; message?: TgMessage; data?: string }
interface TgChatMemberUpdate { chat: TgChat; new_chat_member: { status: string } }
export interface Update {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
  my_chat_member?: TgChatMemberUpdate;
}

interface UserRow {
  telegram_chat_id: number;
  language: Lang;
  quiet_from: number | null;
  quiet_to: number | null;
  blocked: number;
  pending: "request" | null;
}

interface Building extends BuildingView {
  id: number;
  slug: string;
  district: string;
}

interface Ctx {
  env: Env;
  tg: TelegramClient;
  chatId: number;
  user: UserRow;
  lang: Lang;
  now: number;
  /** Set for button presses: the message to update in place. */
  messageId?: number;
}

const BUILDING_COLUMNS = "b.id, b.slug, b.address_uk, b.address_en, b.district, b.status, b.status_since, b.maintenance";
const SLUG = /^[a-z0-9-]{1,64}$/;
const DISTRICT = /^[a-z]{1,32}$/;

const t = (ctx: Ctx) => T[ctx.lang];
const nowS = () => Math.floor(Date.now() / 1000);
const langFrom = (code?: string): Lang => (code?.startsWith("en") ? "en" : "uk");

// ---------- sending ----------

async function send(ctx: Ctx, text: string, keyboard?: Keyboard): Promise<void> {
  const res = await ctx.tg.call("sendMessage", {
    chat_id: ctx.chatId,
    text,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
  if (!res.ok && res.error_code === 403) await markBlocked(ctx.env, ctx.chatId);
}

/** Updates the pressed message in place, or sends a new one. */
async function show(ctx: Ctx, text: string, keyboard?: Keyboard): Promise<void> {
  if (ctx.messageId === undefined) return send(ctx, text, keyboard);
  const res = await ctx.tg.call("editMessageText", {
    chat_id: ctx.chatId,
    message_id: ctx.messageId,
    text,
    reply_markup: { inline_keyboard: keyboard ?? [] },
  });
  if (!res.ok && !res.description.includes("message is not modified")) await send(ctx, text, keyboard);
}

async function markBlocked(env: Env, chatId: number): Promise<void> {
  await env.DB.prepare("UPDATE users SET blocked = 1 WHERE telegram_chat_id = ?").bind(chatId).run();
}

// ---------- entry point ----------

export async function handleUpdate(update: Update, env: Env, tg: TelegramClient, now = nowS()): Promise<void> {
  const member = update.my_chat_member;
  if (member) {
    if (member.chat.type !== "private") return;
    const blocked = member.new_chat_member.status === "kicked" ? 1 : 0;
    await env.DB.prepare("UPDATE users SET blocked = ? WHERE telegram_chat_id = ?").bind(blocked, member.chat.id).run();
    return;
  }

  const message = update.message;
  const callback = update.callback_query;
  const chat = message?.chat ?? callback?.message?.chat;
  const from = message?.from ?? callback?.from;
  if (!chat || !from || chat.type !== "private") return;

  const { success } = await env.BOT_LIMITER.limit({ key: String(chat.id) });
  if (!success) {
    if (callback) await tg.call("answerCallbackQuery", { callback_query_id: callback.id, text: T[langFrom(from.language_code)].slowDown });
    return;
  }

  const user = await ensureUser(env, chat.id, from.language_code);
  const ctx: Ctx = { env, tg, chatId: chat.id, user, lang: user.language, now };

  if (callback) {
    const toast = await onButton({ ...ctx, messageId: callback.message?.message_id }, callback.data ?? "");
    await tg.call("answerCallbackQuery", { callback_query_id: callback.id, ...(toast ? { text: toast } : {}) });
    return;
  }
  if (message?.text) await onText(ctx, message.text.trim());
}

async function ensureUser(env: Env, chatId: number, languageCode?: string): Promise<UserRow> {
  const [, selected] = await env.DB.batch<UserRow>([
    env.DB.prepare("INSERT OR IGNORE INTO users (telegram_chat_id, language) VALUES (?, ?)").bind(chatId, langFrom(languageCode)),
    env.DB.prepare(
      "SELECT telegram_chat_id, language, quiet_from, quiet_to, blocked, pending FROM users WHERE telegram_chat_id = ?",
    ).bind(chatId),
  ]);
  const user = selected?.results[0];
  if (!user) throw new Error("user row missing after insert");
  if (user.blocked === 1) {
    await env.DB.prepare("UPDATE users SET blocked = 0 WHERE telegram_chat_id = ?").bind(chatId).run();
    user.blocked = 0;
  }
  return user;
}

// ---------- text messages ----------

async function onText(ctx: Ctx, text: string): Promise<void> {
  if (text.startsWith("/")) {
    const [first = "", ...rest] = text.split(/\s+/);
    const command = first.split("@")[0]?.toLowerCase();
    const arg = rest.join(" ");
    if (ctx.user.pending !== null) await setPending(ctx, null);

    switch (command) {
      case "/start":
        return arg.startsWith("b_") ? subscribeBySlug(ctx, arg.slice(2)) : welcome(ctx);
      case "/add":
        return askAddress(ctx);
      case "/my":
        return showMine(ctx);
      case "/status":
        return showStatus(ctx);
      case "/settings":
        return showSettings(ctx);
      case "/delete_me":
        return show(ctx, t(ctx).deleteAsk, [[button(t(ctx).deleteYes, "del:yes")], [button(t(ctx).cancel, "del:no")]]);
      default:
        return send(ctx, t(ctx).help);
    }
  }
  if (ctx.user.pending === "request") return saveRequest(ctx, text);
  return search(ctx, text);
}

function welcome(ctx: Ctx): Promise<void> {
  return send(ctx, t(ctx).welcome, mainKeyboard(ctx));
}

function mainKeyboard(ctx: Ctx): Keyboard {
  return [[button(t(ctx).addAddress, "add")], [button(t(ctx).myAddresses, "my"), button(t(ctx).settings, "settings")]];
}

// ---------- finding buildings ----------

async function activeBuildings(env: Env): Promise<Building[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${BUILDING_COLUMNS} FROM buildings b WHERE b.active = 1 ORDER BY b.address_uk`,
  ).all<Building>();
  return results;
}

async function askAddress(ctx: Ctx): Promise<void> {
  const buildings = await activeBuildings(ctx.env);
  if (buildings.length === 0) return show(ctx, t(ctx).noBuildings, [[button(t(ctx).wantSensor, "req")]]);
  const districts = [...new Set(buildings.map((b) => b.district))];
  const keyboard: Keyboard = districts.map((d) => [button(districtName(d, ctx.lang), `d:${d}`)]);
  keyboard.push([button(t(ctx).wantSensor, "req")]);
  return show(ctx, t(ctx).askAddress, keyboard);
}

function buildingButtons(ctx: Ctx, buildings: Building[]): Keyboard {
  return buildings.map((b) => [button(shortAddress(b, ctx.lang), `s:${b.id}`)]);
}

async function search(ctx: Ctx, text: string): Promise<void> {
  const query = text.slice(0, MAX_QUERY_CHARS);
  if (normalize(query).join("").length < 2) return send(ctx, t(ctx).tooShort);
  const hits = searchBuildings(await activeBuildings(ctx.env), query);
  if (hits.length === 0) {
    return send(ctx, t(ctx).notFound, [[button(t(ctx).wantSensor, "req")], [button(t(ctx).byDistrict, "add")]]);
  }
  return send(ctx, t(ctx).found, buildingButtons(ctx, hits));
}

async function showDistrict(ctx: Ctx, district: string): Promise<void> {
  const buildings = (await activeBuildings(ctx.env)).filter((b) => b.district === district);
  if (buildings.length === 0) return askAddress(ctx);
  return show(ctx, `${districtName(district, ctx.lang)}\n\n${t(ctx).chooseBuilding}`, buildingButtons(ctx, buildings));
}

// ---------- subscriptions ----------

async function subscribe(ctx: Ctx, buildingId: number): Promise<void> {
  const db = ctx.env.DB;
  const [building, existing, count] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT ${BUILDING_COLUMNS} FROM buildings b WHERE b.id = ? AND b.active = 1`).bind(buildingId),
    db.prepare("SELECT 1 AS x FROM subscriptions WHERE chat_id = ? AND building_id = ?").bind(ctx.chatId, buildingId),
    db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE chat_id = ?").bind(ctx.chatId),
  ]);
  const b = building?.results[0] as Building | undefined;
  if (!b) return show(ctx, t(ctx).unknownBuilding);

  const after = [[button(t(ctx).addAddress, "add")], [button(t(ctx).myAddresses, "my")]];
  const line = statusLine(b, ctx.lang, ctx.now);
  if ((existing?.results.length ?? 0) > 0) return show(ctx, `${t(ctx).alreadySubscribed}\n\n${line}`, after);
  if (Number(count?.results[0]?.n ?? 0) >= MAX_SUBSCRIPTIONS) return show(ctx, t(ctx).tooMany, [[button(t(ctx).myAddresses, "my")]]);

  await db.prepare("INSERT OR IGNORE INTO subscriptions (chat_id, building_id) VALUES (?, ?)").bind(ctx.chatId, buildingId).run();
  return show(ctx, `${t(ctx).subscribed}\n\n${line}`, after);
}

async function subscribeBySlug(ctx: Ctx, slug: string): Promise<void> {
  const row = SLUG.test(slug)
    ? await ctx.env.DB.prepare("SELECT id FROM buildings WHERE slug = ? AND active = 1").bind(slug).first<{ id: number }>()
    : null;
  if (row === null) return send(ctx, t(ctx).notFound, [[button(t(ctx).wantSensor, "req")], [button(t(ctx).byDistrict, "add")]]);
  return subscribe(ctx, row.id);
}

async function myBuildings(ctx: Ctx): Promise<Building[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT ${BUILDING_COLUMNS} FROM subscriptions s JOIN buildings b ON b.id = s.building_id
      WHERE s.chat_id = ? AND b.active = 1 ORDER BY s.created_at, b.id`,
  )
    .bind(ctx.chatId)
    .all<Building>();
  return results;
}

async function showMine(ctx: Ctx): Promise<void> {
  const mine = await myBuildings(ctx);
  if (mine.length === 0) return show(ctx, t(ctx).noAddresses, [[button(t(ctx).addAddress, "add")]]);
  const lines = mine.map((b) => statusLine(b, ctx.lang, ctx.now)).join("\n");
  const keyboard: Keyboard = mine.map((b) => [button(`✖️ ${t(ctx).unsubscribe}: ${shortAddress(b, ctx.lang)}`, `u:${b.id}`)]);
  keyboard.push([button(t(ctx).addAddress, "add")]);
  return show(ctx, `${t(ctx).yourAddresses}\n\n${lines}`, keyboard);
}

async function showStatus(ctx: Ctx): Promise<void> {
  const mine = await myBuildings(ctx);
  if (mine.length === 0) return send(ctx, t(ctx).noAddresses, [[button(t(ctx).addAddress, "add")]]);
  return send(ctx, mine.map((b) => statusLine(b, ctx.lang, ctx.now)).join("\n"));
}

// ---------- settings ----------

function showSettings(ctx: Ctx): Promise<void> {
  const { quiet_from: from, quiet_to: to } = ctx.user;
  const mark = (on: boolean, label: string) => (on ? `✓ ${label}` : label);
  const preset = (Object.entries(QUIET_PRESETS) as [QuietPreset, readonly [number, number] | null][]).find(
    ([, v]) => (v === null ? from === null : v[0] === from && v[1] === to),
  )?.[0];
  const keyboard: Keyboard = [
    [button(mark(ctx.lang === "uk", "🇺🇦 Українська"), "lang:uk"), button(mark(ctx.lang === "en", "🇬🇧 English"), "lang:en")],
    [button(mark(preset === "off", t(ctx).quietOff), "q:off")],
    [
      button(mark(preset === "22-07", "🌙 22–07"), "q:22-07"),
      button(mark(preset === "23-08", "🌙 23–08"), "q:23-08"),
      button(mark(preset === "00-07", "🌙 00–07"), "q:00-07"),
    ],
  ];
  return show(ctx, t(ctx).settingsTitle(t(ctx).languageName, quietLabel(from, to, ctx.lang)), keyboard);
}

async function setLanguage(ctx: Ctx, lang: Lang): Promise<void> {
  await ctx.env.DB.prepare("UPDATE users SET language = ? WHERE telegram_chat_id = ?").bind(lang, ctx.chatId).run();
  ctx.lang = lang;
  ctx.user.language = lang;
  return showSettings(ctx);
}

async function setQuiet(ctx: Ctx, preset: QuietPreset): Promise<void> {
  const value = QUIET_PRESETS[preset];
  const [from, to] = value === null ? [null, null] : value;
  await ctx.env.DB.prepare("UPDATE users SET quiet_from = ?, quiet_to = ? WHERE telegram_chat_id = ?").bind(from, to, ctx.chatId).run();
  ctx.user.quiet_from = from;
  ctx.user.quiet_to = to;
  return showSettings(ctx);
}

// ---------- sensor requests ----------

async function setPending(ctx: Ctx, pending: UserRow["pending"]): Promise<void> {
  await ctx.env.DB.prepare("UPDATE users SET pending = ? WHERE telegram_chat_id = ?").bind(pending, ctx.chatId).run();
  ctx.user.pending = pending;
}

async function saveRequest(ctx: Ctx, text: string): Promise<void> {
  if (text.length > MAX_REQUEST_CHARS) return send(ctx, t(ctx).requestTooLong);
  await setPending(ctx, null);

  const recent = await ctx.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM building_requests WHERE chat_id = ? AND created_at > ?",
  )
    .bind(ctx.chatId, ctx.now - 86_400)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) < MAX_REQUESTS_PER_DAY) {
    await ctx.env.DB.prepare("INSERT INTO building_requests (chat_id, text, created_at) VALUES (?, ?, ?)")
      .bind(ctx.chatId, text, ctx.now)
      .run();
    const admin = Number(ctx.env.ADMIN_CHAT_ID);
    if (Number.isSafeInteger(admin) && admin !== 0) {
      await ctx.tg.call("sendMessage", { chat_id: admin, text: `📬 Запит на датчик (від ${ctx.chatId}):\n\n${text}` });
    }
  }
  return send(ctx, t(ctx).requestThanks, mainKeyboard(ctx));
}

// ---------- buttons ----------

/** Handles a button press. Returns a short toast to show, if any. */
async function onButton(ctx: Ctx, data: string): Promise<string | undefined> {
  if (ctx.user.pending !== null && data !== "req") await setPending(ctx, null);

  switch (data) {
    case "add":
      await askAddress(ctx);
      return;
    case "my":
      await showMine(ctx);
      return;
    case "settings":
      await showSettings(ctx);
      return;
    case "req":
      await setPending(ctx, "request");
      await send(ctx, t(ctx).askRequest, [[button(t(ctx).cancel, "x")]]);
      return;
    case "x":
      await show(ctx, t(ctx).cancelled);
      return;
    case "del:yes":
      await ctx.env.DB.prepare("DELETE FROM users WHERE telegram_chat_id = ?").bind(ctx.chatId).run();
      await show(ctx, t(ctx).deleted);
      return;
    case "del:no":
      await show(ctx, t(ctx).cancelled);
      return;
    case "lang:uk":
    case "lang:en":
      await setLanguage(ctx, data.slice(5) as Lang);
      return;
  }

  const [kind, value = ""] = data.split(":", 2);
  const id = /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : null;
  if (kind === "s" && id !== null) {
    await subscribe(ctx, id);
    return;
  }
  if (kind === "u" && id !== null) {
    await ctx.env.DB.prepare("DELETE FROM subscriptions WHERE chat_id = ? AND building_id = ?").bind(ctx.chatId, id).run();
    await showMine(ctx);
    return t(ctx).unsubscribed;
  }
  if (kind === "d" && DISTRICT.test(value)) {
    await showDistrict(ctx, value);
    return;
  }
  if (kind === "q" && value in QUIET_PRESETS) {
    await setQuiet(ctx, value as QuietPreset);
    return;
  }
  // Unknown or forged data: ignore.
  return;
}
