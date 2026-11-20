// Today's usage against the Cloudflare free-plan daily limits (they reset at
// 00:00 UTC), read from the GraphQL Analytics API with a read-only token
// (Account Analytics: Read). Shown in the admin panel; the cron job alerts the
// admin at 70% (plan, Phase 6).

import type { TelegramClient } from "./telegram/client.ts";

export const FREE_LIMITS = {
  workerRequests: 100_000,
  d1RowsRead: 5_000_000,
  d1RowsWritten: 100_000,
  queueOperations: 10_000,
} as const;
export type Metric = keyof typeof FREE_LIMITS;

export const ALERT_SHARE = 0.7;

export const METRIC_LABELS: Record<Metric, string> = {
  workerRequests: "Запити до Worker",
  d1RowsRead: "D1: прочитані рядки",
  d1RowsWritten: "D1: записані рядки",
  queueOperations: "Операції черги",
};

export interface Usage {
  /** UTC day these numbers are for (YYYY-MM-DD). */
  date: string;
  values: Record<Metric, number>;
}

export type GraphqlFetcher = (body: string, token: string) => Promise<unknown>;

const defaultFetcher: GraphqlFetcher = async (body, token) => {
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body,
  });
  return res.json();
};

const QUERY = `query Usage($account: string!, $start: Time!, $end: Time!, $date: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workers: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { requests }
      }
      d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date }) {
        sum { rowsRead rowsWritten }
      }
      queues: queueMessageOperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { billableOperations }
      }
    }
  }
}`;

type Row = { sum?: Record<string, number | null> };
const total = (rows: Row[] | undefined, field: string) =>
  (rows ?? []).reduce((acc, r) => acc + (Number(r.sum?.[field]) || 0), 0);

/** Today's usage so far (UTC day). Throws with Cloudflare's message on errors. */
export async function fetchUsage(token: string, accountId: string, nowMs = Date.now(), fetcher = defaultFetcher): Promise<Usage> {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const body = JSON.stringify({
    query: QUERY,
    variables: { account: accountId, start: `${date}T00:00:00Z`, end: new Date(nowMs).toISOString(), date },
  });
  const result = (await fetcher(body, token)) as {
    data?: { viewer?: { accounts?: { workers?: Row[]; d1?: Row[]; queues?: Row[] }[] } };
    errors?: { message: string }[] | null;
  };
  if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join("; "));
  const account = result.data?.viewer?.accounts?.[0];
  if (!account) throw new Error("no data for this account (check the token's account and permission)");
  return {
    date,
    values: {
      workerRequests: total(account.workers, "requests"),
      d1RowsRead: total(account.d1, "rowsRead"),
      d1RowsWritten: total(account.d1, "rowsWritten"),
      queueOperations: total(account.queues, "billableOperations"),
    },
  };
}

export function shares(usage: Usage): { metric: Metric; used: number; limit: number; share: number }[] {
  return (Object.keys(FREE_LIMITS) as Metric[]).map((metric) => {
    const limit = FREE_LIMITS[metric];
    const used = usage.values[metric];
    return { metric, used, limit, share: used / limit };
  });
}

/**
 * Sends the admin one Telegram message per metric and UTC day once it passes
 * 70% of its free limit. Returns the metrics alerted now.
 */
export async function usageAlerts(
  env: Env,
  tg: TelegramClient,
  nowMs = Date.now(),
  fetcher = defaultFetcher,
): Promise<Metric[]> {
  const admin = Number(env.ADMIN_CHAT_ID);
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !Number.isSafeInteger(admin) || admin === 0) return [];
  const usage = await fetchUsage(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, nowMs, fetcher);
  const over = shares(usage).filter((s) => s.share >= ALERT_SHARE);
  if (over.length === 0) return [];

  const keys = over.map((s) => `usage_alert:${usage.date}:${s.metric}`);
  const { results } = await env.DB.prepare(
    `SELECT key FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`,
  )
    .bind(...keys)
    .all<{ key: string }>();
  const done = new Set(results.map((r) => r.key));
  const fresh = over.filter((s, i) => !done.has(keys[i]!));
  if (fresh.length === 0) return [];

  const lines = fresh.map((s) => `• ${METRIC_LABELS[s.metric]}: ${s.used.toLocaleString("uk-UA")} з ${s.limit.toLocaleString("uk-UA")} (${Math.round(s.share * 100)}%)`);
  await tg.call("sendMessage", {
    chat_id: admin,
    text: `⚠️ Використано понад 70% безкоштовного ліміту Cloudflare на сьогодні:\n${lines.join("\n")}\n\nЛіміти скидаються о 00:00 UTC (02:00 за Києвом). Якщо ліміт вичерпається, сервіс зупиниться до скидання; перехід на Workers Paid знімає ліміти без змін у коді.`,
  });
  await env.DB.batch(
    fresh.map((s) =>
      env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(`usage_alert:${usage.date}:${s.metric}`, String(s.used)),
    ),
  );
  // Old alert markers are not needed after a day.
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'usage_alert:%' AND key < ?").bind(`usage_alert:${usage.date}`).run();
  return fresh.map((s) => s.metric);
}
