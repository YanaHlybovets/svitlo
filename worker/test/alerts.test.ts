import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { deliver, isQuiet, SEND_INTERVAL_MS, STALE_AFTER_S, type AlertMessage } from "../src/alerts.ts";
import { signBody } from "../src/crypto.ts";
import { runStatus } from "../src/cron.ts";
import { handleReport } from "../src/report.ts";
import type { TelegramClient, TgResult } from "../src/telegram/client.ts";
import { addSensor, BASE, nowS, recordReport, reportBody, resetState } from "./helpers.ts";

function fakeQueue() {
  const sent: { body: AlertMessage; delay?: number }[] = [];
  const queue = {
    async send(body: AlertMessage, options?: { delaySeconds?: number }) {
      sent.push({ body, delay: options?.delaySeconds });
    },
    async sendBatch(messages: { body: AlertMessage }[]) {
      for (const m of messages) sent.push({ body: m.body });
    },
  } as unknown as Queue<AlertMessage>;
  return { queue, sent };
}

function fakeTelegram(reply?: (chatId: number) => TgResult | undefined) {
  const calls: Record<string, unknown>[] = [];
  const tg: TelegramClient = {
    async call<T>(_method: string, params: Record<string, unknown>) {
      calls.push(params);
      return (reply?.(params.chat_id as number) ?? { ok: true, result: {} }) as TgResult<T>;
    },
  };
  return { tg, calls };
}

async function addSubscribers(n: number, start = 5000, extra = "") {
  const statements = [];
  for (let i = 0; i < n; i++) {
    const id = start + i;
    statements.push(
      env.DB.prepare(`INSERT INTO users (telegram_chat_id, language${extra ? ", blocked" : ""}) VALUES (?, ?${extra ? ", 1" : ""})`)
        .bind(id, i % 2 === 0 ? "uk" : "en"),
      env.DB.prepare("INSERT INTO subscriptions (chat_id, building_id) VALUES (?, 1)").bind(id),
    );
  }
  await env.DB.batch(statements);
}

/** The pilot building ON since an hour ago, with a fresh sensor. */
async function buildingOn(t: number) {
  await addSensor();
  await recordReport("on", t - 3600, t - 50);
  await runStatus(env, { now: t - 50, queue: fakeQueue().queue, tg: fakeTelegram().tg });
}

beforeEach(async () => {
  await resetState();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM alert_batches"),
    env.DB.prepare("DELETE FROM subscriptions"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("UPDATE buildings SET rev = NULL"),
  ]);
});

describe("quiet hours", () => {
  // 2026-11-16 23:30 Kyiv = 21:30 UTC; 12:00 Kyiv = 10:00 UTC
  const lateEvening = Date.UTC(2026, 10, 16, 21, 30) / 1000;
  const noon = Date.UTC(2026, 10, 16, 10, 0) / 1000;
  it("wraps past midnight", () => {
    expect(isQuiet(23 * 60, 8 * 60, lateEvening)).toBe(true);
    expect(isQuiet(23 * 60, 8 * 60, noon)).toBe(false);
    expect(isQuiet(0, 7 * 60, lateEvening)).toBe(false);
    expect(isQuiet(null, null, lateEvening)).toBe(false);
  });
});

describe("enqueueing alerts", () => {
  it("splits subscribers into messages of 40 and skips blocked users", async () => {
    const t = nowS();
    await buildingOn(t);
    await addSubscribers(85);
    await addSubscribers(3, 9000, "blocked");
    const { queue, sent } = fakeQueue();

    await recordReport("off", t - 40, t);
    const changes = await runStatus(env, { now: t, queue, tg: fakeTelegram().tg });

    expect(changes).toMatchObject([{ status: "off", notify: true }]);
    expect(sent.map((s) => s.body.recipients.length)).toEqual([40, 40, 5]);
    const eventId = changes[0]?.eventId;
    expect(sent.map((s) => s.body.key)).toEqual([`${eventId}:0`, `${eventId}:1`, `${eventId}:2`]);
    const everyone = sent.flatMap((s) => s.body.recipients.map((r) => r.id));
    expect(everyone).not.toContain(9000);
    expect(sent[0]?.body.recipients[1]).toEqual({ id: 5001, lang: "en", qf: null, qt: null });
  });

  it("sends nothing for a sensor's first status or during maintenance", async () => {
    const t = nowS();
    await addSubscribers(2);
    await addSensor();
    const { queue, sent } = fakeQueue();
    await recordReport("on", t - 3600, t - 50);
    await runStatus(env, { now: t - 50, queue, tg: fakeTelegram().tg }); // first status
    await env.DB.exec("UPDATE buildings SET maintenance = 1");
    await recordReport("off", t - 40, t);
    await runStatus(env, { now: t, queue, tg: fakeTelegram().tg });
    expect(sent).toEqual([]);
  });

  it("records a change once even when two evaluations run at the same time", async () => {
    const t = nowS();
    await buildingOn(t);
    await addSubscribers(3);
    const { queue, sent } = fakeQueue();
    await recordReport("off", t - 40, t);
    const tg = fakeTelegram().tg;
    const [a, b] = await Promise.all([runStatus(env, { now: t, queue, tg }), runStatus(env, { now: t, queue, tg })]);
    expect(a.length + b.length).toBe(1);
    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE status = 'off'").first("n");
    expect(events).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe("admin alerts", () => {
  it("tells the admin when a sensor goes silent and when it is back", async () => {
    const t = nowS();
    await buildingOn(t);
    const { tg, calls } = fakeTelegram();
    await runStatus(env, { now: t + 200, queue: fakeQueue().queue, tg }); // silent for over 3 min
    expect(calls).toMatchObject([{ chat_id: 999 }]);
    expect(calls[0]?.text).toContain("датчик не на зв’язку");

    await recordReport("on", t - 3600, t + 260);
    await runStatus(env, { now: t + 260, queue: fakeQueue().queue, tg });
    expect(calls[1]?.text).toContain("датчик знову на зв’язку");
  });
});

describe("delivering alerts", () => {
  const message = (recipients: AlertMessage["recipients"], overrides: Partial<AlertMessage> = {}): AlertMessage => ({
    key: "7:0", attempt: 0, createdAt: nowS(),
    building: { address_uk: "вул. Ревуцького, 54а", address_en: "Revutskoho St, 54a" },
    status: "off", at: nowS() - 30, prevDuration: 3600, recipients, ...overrides,
  });
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);

  it("sends each recipient their language, paced, silently in quiet hours", async () => {
    sleeps.length = 0;
    const { tg, calls } = fakeTelegram();
    const allDay = [0, 1439] as const; // always quiet
    await deliver(message([
      { id: 1, lang: "uk", qf: null, qt: null },
      { id: 2, lang: "en", qf: allDay[0], qt: allDay[1] },
    ]), env, { tg, queue: fakeQueue().queue, sleep });
    expect(calls).toMatchObject([
      { chat_id: 1, disable_notification: false },
      { chat_id: 2, disable_notification: true },
    ]);
    expect(calls[0]?.text).toMatch(/^🪫 Ревуцького 54а: світло зникло о \d{2}:\d{2} \(було 1 год\)$/);
    expect(calls[1]?.text).toMatch(/^🪫 Revutskoho St 54a: power went off at/);
    expect(sleeps).toEqual([SEND_INTERVAL_MS]);
  });

  it("never sends the same batch twice", async () => {
    const { tg, calls } = fakeTelegram();
    const m = message([{ id: 1, lang: "uk", qf: null, qt: null }]);
    await deliver(m, env, { tg, queue: fakeQueue().queue, sleep });
    await deliver(m, env, { tg, queue: fakeQueue().queue, sleep });
    expect(calls).toHaveLength(1);
  });

  it("marks users who blocked the bot and carries on", async () => {
    await env.DB.batch([1, 2].map((id) => env.DB.prepare("INSERT INTO users (telegram_chat_id) VALUES (?)").bind(id)));
    const { tg, calls } = fakeTelegram((chat) => (chat === 1 ? { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } : undefined));
    await deliver(message([{ id: 1, lang: "uk", qf: null, qt: null }, { id: 2, lang: "uk", qf: null, qt: null }]), env, { tg, queue: fakeQueue().queue, sleep });
    expect(calls).toHaveLength(2);
    expect(await env.DB.prepare("SELECT blocked FROM users WHERE telegram_chat_id = 1").first("blocked")).toBe(1);
    expect(await env.DB.prepare("SELECT blocked FROM users WHERE telegram_chat_id = 2").first("blocked")).toBe(0);
  });

  it("on 429, re-queues the rest after retry_after and stops", async () => {
    const { tg, calls } = fakeTelegram((chat) => (chat === 2 ? { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } } : undefined));
    const { queue, sent } = fakeQueue();
    const r = (id: number) => ({ id, lang: "uk" as const, qf: null, qt: null });
    await deliver(message([r(1), r(2), r(3)]), env, { tg, queue, sleep });
    expect(calls.map((c) => c.chat_id)).toEqual([1, 2]);
    expect(sent).toMatchObject([{ delay: 7, body: { key: "7:0.1", attempt: 1, recipients: [r(2), r(3)] } }]);
  });

  it("drops alerts that are too old to be useful", async () => {
    const { tg, calls } = fakeTelegram();
    await deliver(message([{ id: 1, lang: "uk", qf: null, qt: null }], { createdAt: nowS() - STALE_AFTER_S - 1 }), env, { tg, queue: fakeQueue().queue, sleep });
    expect(calls).toEqual([]);
  });
});

describe("fast path", () => {
  async function report(overrides: Record<string, unknown>) {
    if (!sensorKey) throw new Error("add a sensor first");
    const raw = reportBody(overrides);
    const ctx = createExecutionContext();
    const res = await handleReport(
      new Request(`${BASE}/api/v1/report`, { method: "POST", headers: { "x-signature": await signBody(sensorKey, raw) }, body: raw }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res.status;
  }
  let sensorKey: Uint8Array<ArrayBuffer> | undefined;
  const status = () => env.DB.prepare("SELECT status FROM buildings WHERE id = 1").first("status");

  it("switches to OFF as soon as the confirming report arrives, without waiting for the cron", async () => {
    const t = nowS();
    sensorKey = await addSensor();
    await recordReport("on", t - 3600, t - 50);
    await runStatus(env, { now: t - 50, queue: fakeQueue().queue, tg: fakeTelegram().tg });
    expect(await status()).toBe("on");

    expect(await report({ grid: "off", since: t - 40, ts: t - 40 })).toBe(204); // first "off": not confirmed yet
    expect(await status()).toBe("on");
    expect(await report({ grid: "off", since: t - 40, ts: t })).toBe(204); // 40 s later: confirmed
    expect(await status()).toBe("off");
  });
});
