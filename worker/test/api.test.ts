import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://svitlo.test";

describe("public API", () => {
  it("answers the health check", async () => {
    const res = await exports.default.fetch(`${BASE}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("lists the pilot building with no data yet", async () => {
    const res = await exports.default.fetch(`${BASE}/api/v1/buildings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { buildings: { slug: string; status: string }[] };
    expect(body.buildings).toEqual([
      expect.objectContaining({ slug: "revutskogo-54a", status: "no_data" }),
    ]);
  });

  it("returns 404 for unknown routes and other methods", async () => {
    expect((await exports.default.fetch(`${BASE}/nope`)).status).toBe(404);
    const post = await exports.default.fetch(`${BASE}/api/v1/buildings`, { method: "POST" });
    expect(post.status).toBe(404);
  });
});

describe("schema", () => {
  it("rejects an unknown status", async () => {
    await expect(
      env.DB.prepare("UPDATE buildings SET status = 'maybe' WHERE slug = 'revutskogo-54a'").run(),
    ).rejects.toThrow(/CHECK constraint/);
  });

  it("allows only one sensor per building", async () => {
    const insert = env.DB.prepare(
      "INSERT INTO sensors (id, building_id, key_encrypted) VALUES (?, 1, 'x')",
    );
    await insert.bind("s1").run();
    await expect(insert.bind("s2").run()).rejects.toThrow(/UNIQUE/);
  });

  it("removes a user's subscriptions when the user is deleted (/delete_me)", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (telegram_chat_id) VALUES (42)"),
      env.DB.prepare("INSERT INTO subscriptions (chat_id, building_id) VALUES (42, 1)"),
      env.DB.prepare("DELETE FROM users WHERE telegram_chat_id = 42"),
    ]);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
