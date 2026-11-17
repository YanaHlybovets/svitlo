// Alert fan-out (ADR 0006). On a status change, the subscribers of that
// building are split into queue messages of up to 40 chats. The consumer sends
// at most 40 Telegram messages per run (free plan: 50 outgoing requests), about
// 25 a second (Telegram allows about 30), silently during quiet hours.

import type { TelegramClient } from "./telegram/client.ts";
import { alertText, clock, kyivMinutes, shortAddress, type Lang } from "./telegram/text.ts";

export const CHATS_PER_MESSAGE = 40;
export const SEND_INTERVAL_MS = 40; // ≈25 messages a second
export const MAX_ATTEMPTS = 5;
export const STALE_AFTER_S = 15 * 60; // an alert this late would mislead more than help

export interface Recipient {
  id: number;
  lang: Lang;
  qf: number | null; // quiet hours from (minutes after midnight, Kyiv)
  qt: number | null;
}

export interface AlertMessage {
  /** Dedupe key: "<event id>:<part>", plus ".<attempt>" for re-queued remainders. */
  key: string;
  attempt: number;
  createdAt: number;
  building: { address_uk: string; address_en: string };
  status: "on" | "off";
  at: number;
  prevDuration: number | null;
  recipients: Recipient[];
}

export interface StatusChange {
  eventId: number;
  buildingId: number;
  slug: string;
  address_uk: string;
  address_en: string;
  status: "on" | "off" | "no_data";
  previous: "on" | "off" | "no_data";
  at: number;
  notify: boolean;
  prevDuration: number | null;
}

const nowS = () => Math.floor(Date.now() / 1000);
const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True if `now` falls within the quiet hours (which may wrap past midnight). */
export function isQuiet(from: number | null, to: number | null, now: number): boolean {
  if (from === null || to === null || from === to) return false;
  const m = kyivMinutes(now);
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** Puts the alerts for these status changes on the queue. Returns how many queue messages were sent. */
export async function enqueueAlerts(env: Env, changes: StatusChange[], queue: Queue<AlertMessage>, now = nowS()): Promise<number> {
  let total = 0;
  for (const c of changes) {
    if (!c.notify || c.status === "no_data") continue;
    const { results } = await env.DB.prepare(
      `SELECT u.telegram_chat_id AS id, u.language AS lang, u.quiet_from AS qf, u.quiet_to AS qt
         FROM subscriptions s JOIN users u ON u.telegram_chat_id = s.chat_id
        WHERE s.building_id = ? AND u.blocked = 0
        ORDER BY u.telegram_chat_id`,
    )
      .bind(c.buildingId)
      .all<Recipient>();

    const messages: { body: AlertMessage }[] = [];
    for (let i = 0; i < results.length; i += CHATS_PER_MESSAGE) {
      messages.push({
        body: {
          key: `${c.eventId}:${i / CHATS_PER_MESSAGE}`,
          attempt: 0,
          createdAt: now,
          building: { address_uk: c.address_uk, address_en: c.address_en },
          status: c.status,
          at: c.at,
          prevDuration: c.prevDuration,
          recipients: results.slice(i, i + CHATS_PER_MESSAGE),
        },
      });
    }
    for (let i = 0; i < messages.length; i += 100) await queue.sendBatch(messages.slice(i, i + 100));
    total += messages.length;
  }
  return total;
}

/** Private messages to the admin about sensors going silent or coming back. */
export async function notifyAdmin(env: Env, changes: StatusChange[], tg: TelegramClient, now = nowS()): Promise<void> {
  const admin = Number(env.ADMIN_CHAT_ID);
  if (!Number.isSafeInteger(admin) || admin === 0) return;
  for (const c of changes) {
    const addr = shortAddress(c, "uk");
    let text: string | null = null;
    if (c.status === "no_data") text = `❔ ${addr}: датчик не на зв’язку з ${clock(c.at, now)}. Перевірте живлення й мобільний зв’язок.`;
    else if (c.previous === "no_data") text = `✅ ${addr}: датчик знову на зв’язку.`;
    if (text) await tg.call("sendMessage", { chat_id: admin, text });
  }
}

export interface DeliverDeps {
  tg: TelegramClient;
  queue: Queue<AlertMessage>;
  sleep?: (ms: number) => Promise<void>;
  now?: number;
}

/** Sends one queue message's alerts. Safe to run twice for the same message. */
export async function deliver(m: AlertMessage, env: Env, deps: DeliverDeps): Promise<void> {
  const { tg, queue, sleep = sleepMs, now = nowS() } = deps;
  const done = env.DB.prepare("INSERT OR IGNORE INTO alert_batches (id) VALUES (?)").bind(m.key);
  if (await env.DB.prepare("SELECT 1 AS x FROM alert_batches WHERE id = ?").bind(m.key).first()) return;
  if (now - m.createdAt > STALE_AFTER_S) {
    console.warn(JSON.stringify({ msg: "alert_stale_dropped", key: m.key }));
    await done.run();
    return;
  }

  const blocked: number[] = [];
  for (const [i, r] of m.recipients.entries()) {
    if (i > 0) await sleep(SEND_INTERVAL_MS);
    const res = await tg.call("sendMessage", {
      chat_id: r.id,
      text: alertText(m.building, m.status, m.at, m.prevDuration, r.lang, now),
      disable_notification: isQuiet(r.qf, r.qt, now),
    });
    if (res.ok) continue;

    if (res.error_code === 403 || (res.error_code === 400 && /chat not found|user is deactivated/i.test(res.description))) {
      blocked.push(r.id);
      continue;
    }
    if (res.error_code === 429 || res.error_code >= 500 || res.error_code === 0) {
      // Too many requests or Telegram trouble: send the rest later, as a new message.
      const rest = m.recipients.slice(i);
      if (m.attempt + 1 < MAX_ATTEMPTS) {
        const wait = res.parameters?.retry_after ?? 10 * (m.attempt + 1);
        await queue.send(
          { ...m, key: `${m.key}.${m.attempt + 1}`, attempt: m.attempt + 1, recipients: rest },
          { delaySeconds: Math.min(Math.max(Math.ceil(wait), 1), 600) },
        );
      } else {
        console.error(JSON.stringify({ msg: "alert_gave_up", key: m.key, left: rest.length, code: res.error_code }));
      }
      break;
    }
    console.error(JSON.stringify({ msg: "alert_send_failed", key: m.key, code: res.error_code, description: res.description }));
  }

  await env.DB.batch([
    ...blocked.map((id) => env.DB.prepare("UPDATE users SET blocked = 1 WHERE telegram_chat_id = ?").bind(id)),
    done,
  ]);
}

export const LOW_BATTERY_MV = 3400;
export const BATTERY_OK_MV = 3700;

/** Tells the admin once when a sensor's battery runs low; re-arms when it recovers. */
export async function batteryAlerts(env: Env, tg: TelegramClient): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.battery_mv, s.low_battery_alerted, b.address_uk, b.address_en
       FROM sensors s JOIN buildings b ON b.id = s.building_id
      WHERE s.enabled = 1 AND s.battery_mv IS NOT NULL
        AND ((s.battery_mv < ? AND s.low_battery_alerted = 0) OR (s.battery_mv >= ? AND s.low_battery_alerted = 1))`,
  )
    .bind(LOW_BATTERY_MV, BATTERY_OK_MV)
    .all<{ id: string; battery_mv: number; low_battery_alerted: number; address_uk: string; address_en: string }>();

  const admin = Number(env.ADMIN_CHAT_ID);
  let sent = 0;
  for (const r of results) {
    const low = r.low_battery_alerted === 0;
    if (low && Number.isSafeInteger(admin) && admin !== 0) {
      await tg.call("sendMessage", {
        chat_id: admin,
        text: `🔋 ${shortAddress(r, "uk")}: низький заряд батареї датчика (${r.battery_mv} мВ). Перевірте, чи живиться розетка.`,
      });
      sent++;
    }
    await env.DB.prepare("UPDATE sensors SET low_battery_alerted = ? WHERE id = ?").bind(low ? 1 : 0, r.id).run();
  }
  return sent;
}
