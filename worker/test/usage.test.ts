import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAdminApi, type AdminEnv } from "../src/admin/api.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
import { fetchUsage, shares, usageAlerts, type GraphqlFetcher } from "../src/usage.ts";

const NOW = Date.UTC(2026, 10, 20, 15, 0);

function graphql(values: { requests: number; rowsRead: number; rowsWritten: number; ops: number }, errors?: string): GraphqlFetcher {
  return async (body) => {
    const { variables } = JSON.parse(body);
    expect(variables).toMatchObject({ account: "acc", date: "2026-11-20", start: "2026-11-20T00:00:00Z" });
    if (errors) return { data: null, errors: [{ message: errors }] };
    return {
      data: {
        viewer: {
          accounts: [{
            // Split over several rows, as the API returns per script / per database.
            workers: [{ sum: { requests: values.requests - 10 } }, { sum: { requests: 10 } }],
            d1: [{ sum: { rowsRead: values.rowsRead, rowsWritten: values.rowsWritten } }],
            queues: [{ sum: { billableOperations: values.ops } }],
          }],
        },
      },
      errors: null,
    };
  };
}

function fakeTelegram() {
  const texts: string[] = [];
  const tg: TelegramClient = { async call<T>(_m: string, p: Record<string, unknown>) { texts.push(String(p.text)); return { ok: true, result: {} as T }; } };
  return { tg, texts };
}

describe("usage", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM settings");
  });

  it("sums today's usage and compares it with the free limits", async () => {
    const usage = await fetchUsage("t", "acc", NOW, graphql({ requests: 45_000, rowsRead: 1_000_000, rowsWritten: 15_000, ops: 300 }));
    expect(usage.values).toEqual({ workerRequests: 45_000, d1RowsRead: 1_000_000, d1RowsWritten: 15_000, queueOperations: 300 });
    expect(shares(usage).map((s) => s.share)).toEqual([0.45, 0.2, 0.15, 0.03]);
  });

  it("reports Cloudflare's error message", async () => {
    await expect(fetchUsage("t", "acc", NOW, graphql({ requests: 0, rowsRead: 0, rowsWritten: 0, ops: 0 }, "not authorized"))).rejects.toThrow("not authorized");
  });

  it("alerts the admin once per metric per day at 70%", async () => {
    const e = { ...env, CF_API_TOKEN: "t", CF_ACCOUNT_ID: "acc" };
    const { tg, texts } = fakeTelegram();
    const busy = graphql({ requests: 71_000, rowsRead: 10, rowsWritten: 10, ops: 10 });
    expect(await usageAlerts(e, tg, NOW, busy)).toEqual(["workerRequests"]);
    expect(texts[0]).toContain("Запити до Worker: 71");
    expect(texts[0]).toContain("(71%)");
    expect(await usageAlerts(e, tg, NOW, busy)).toEqual([]); // already told today

    const worse = graphql({ requests: 80_000, rowsRead: 10, rowsWritten: 75_000, ops: 10 });
    expect(await usageAlerts(e, tg, NOW, worse)).toEqual(["d1RowsWritten"]);
    expect(texts).toHaveLength(2);
  });

  it("stays quiet below 70% and when not configured", async () => {
    const { tg, texts } = fakeTelegram();
    const quiet = graphql({ requests: 10, rowsRead: 10, rowsWritten: 10, ops: 10 });
    expect(await usageAlerts({ ...env, CF_API_TOKEN: "t", CF_ACCOUNT_ID: "acc" }, tg, NOW, quiet)).toEqual([]);
    expect(await usageAlerts({ ...env, CF_API_TOKEN: "", CF_ACCOUNT_ID: "" }, tg, NOW, quiet)).toEqual([]);
    expect(texts).toEqual([]);
  });

  it("admin usage endpoint says when no token is configured", async () => {
    const adminEnv = { DB: env.DB, MASTER_KEY: env.MASTER_KEY, ASSETS: {} as Fetcher, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", ADMIN_EMAILS: "" } as AdminEnv;
    const res = await handleAdminApi(new Request("https://svitlo-admin.yanasworks.com/api/usage"), adminEnv, "admin@example.com");
    expect(await res.json()).toEqual({ configured: false });
  });
});
