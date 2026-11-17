import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { batteryAlerts } from "../src/alerts.ts";
import { verifyAccessJwt, type AccessConfig, type JwksFetcher } from "../src/admin/access.ts";
import { handleAdminApi, type AdminEnv } from "../src/admin/api.ts";
import admin, { authenticate } from "../src/admin/index.ts";
import { decryptSensorKey, fromBase64, toBase64 } from "../src/crypto.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
import { resetState } from "./helpers.ts";

const NOW = 1_794_900_000;
const CONFIG: AccessConfig = { teamDomain: "svitlo.cloudflareaccess.com", aud: "aud-tag-123", emails: ["admin@example.com"] };

let keyPair: CryptoKeyPair;
let jwks: { keys: (JsonWebKey & { kid: string })[] };

const b64url = (data: Uint8Array | string) =>
  toBase64(typeof data === "string" ? new TextEncoder().encode(data) : data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }) {
  const payload = {
    iss: `https://${CONFIG.teamDomain}`, aud: [CONFIG.aud], email: "admin@example.com",
    iat: NOW - 10, nbf: NOW - 10, exp: NOW + 3600, ...claims,
  };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(data)));
  return `${data}.${b64url(sig)}`;
}

let fetches = 0;
const fetcher: JwksFetcher = async () => {
  fetches++;
  return jwks;
};

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  jwks = { keys: [{ ...pub, kid: "k1" }] };
});

describe("Cloudflare Access token", () => {
  it("accepts a valid token for an allowed email", async () => {
    expect(await verifyAccessJwt(await token(), CONFIG, NOW, fetcher)).toBe("admin@example.com");
  });

  it.each([
    ["wrong audience", { aud: ["other"] }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["expired", { exp: NOW - 1 }],
    ["not valid yet", { nbf: NOW + 3600 }],
    ["an email that isn't allowed", { email: "someone@example.com" }],
  ])("rejects %s", async (_name, claims) => {
    expect(await verifyAccessJwt(await token(claims), CONFIG, NOW, fetcher)).toBeNull();
  });

  it("rejects tampered, unsigned and malformed tokens", async () => {
    const good = await token();
    const [h, , s] = good.split(".");
    const forged = `${h}.${b64url(JSON.stringify({ iss: `https://${CONFIG.teamDomain}`, aud: [CONFIG.aud], email: "admin@example.com", exp: NOW + 3600 }))}.${s}`;
    expect(await verifyAccessJwt(forged, CONFIG, NOW, fetcher)).toBeNull();
    expect(await verifyAccessJwt(await token({}, { alg: "none", kid: "k1" }), CONFIG, NOW, fetcher)).toBeNull();
    expect(await verifyAccessJwt("not.a.jwt", CONFIG, NOW, fetcher)).toBeNull();
    expect(await verifyAccessJwt("", CONFIG, NOW, fetcher)).toBeNull();
  });

  it("refetches the keys once when the key ID is unknown (key rotation)", async () => {
    const before = fetches;
    expect(await verifyAccessJwt(await token({}, { alg: "RS256", kid: "k2" }), CONFIG, NOW, fetcher)).toBeNull();
    expect(fetches - before).toBe(1);
  });

  it("rejects everything while Access isn't configured", async () => {
    expect(await verifyAccessJwt(await token(), { ...CONFIG, aud: "" }, NOW, fetcher)).toBeNull();
  });
});

const adminEnv = (overrides: Partial<AdminEnv> = {}): AdminEnv => ({
  DB: env.DB,
  MASTER_KEY: env.MASTER_KEY,
  ASSETS: { fetch: async () => new Response("<html>admin ui</html>") } as unknown as Fetcher,
  ACCESS_TEAM_DOMAIN: CONFIG.teamDomain,
  ACCESS_AUD: CONFIG.aud,
  ADMIN_EMAILS: "admin@example.com",
  ...overrides,
});

describe("admin Worker", () => {
  it("refuses every request without an Access token, UI included", async () => {
    for (const path of ["/", "/admin.js", "/api/overview"]) {
      const res = await admin.fetch(new Request(`https://svitlo-admin.yanasworks.com${path}`), adminEnv());
      expect(res.status).toBe(403);
    }
  });

  it("allows the local bypass only on localhost and only with the flag", async () => {
    const local = new Request("http://localhost:8788/api/me");
    expect(await authenticate(local, adminEnv({ DEV_NO_ACCESS: "1" }))).toBe("dev@localhost");
    expect(await authenticate(local, adminEnv())).toBeNull();
    expect(await authenticate(new Request("https://svitlo-admin.yanasworks.com/api/me"), adminEnv({ DEV_NO_ACCESS: "1" }))).toBeNull();
  });
});

describe("admin API", () => {
  const ORIGIN = "https://svitlo-admin.yanasworks.com";
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-svitlo-admin": "1", origin: ORIGIN }) =>
    handleAdminApi(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      adminEnv(),
      "admin@example.com",
    );
  const auditActions = async () =>
    (await env.DB.prepare("SELECT action FROM audit_log ORDER BY id").all<{ action: string }>()).results.map((r) => r.action);

  beforeEach(async () => {
    await resetState();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM audit_log"),
      env.DB.prepare("DELETE FROM building_requests"),
      env.DB.prepare("DELETE FROM subscriptions"),
      env.DB.prepare("DELETE FROM users"),
      env.DB.prepare("DELETE FROM buildings WHERE id > 1"),
      env.DB.prepare("UPDATE buildings SET active = 1"),
    ]);
  });

  it("shows an overview", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (telegram_chat_id, blocked) VALUES (1, 0), (2, 1)"),
      env.DB.prepare("INSERT INTO subscriptions (chat_id, building_id) VALUES (1, 1), (2, 1)"),
      env.DB.prepare("INSERT INTO building_requests (chat_id, text) VALUES (1, 'Бажана 10')"),
    ]);
    const data = (await (await call("GET", "/api/overview")).json()) as Record<string, unknown>;
    expect(data).toMatchObject({
      buildings: [{ slug: "revutskogo-54a", subscribers: 2, sensor_id: null }],
      users: { total: 2, blocked: 1 },
      subscriptions: 2,
      requests: [{ text: "Бажана 10" }],
    });
  });

  it("adds a building, validates input and logs the action", async () => {
    const ok = { slug: "bazhana-10", address_uk: "просп. Миколи Бажана, 10", address_en: "Mykoly Bazhana Ave, 10", district: "darnytskyi" };
    expect((await call("POST", "/api/buildings", ok)).status).toBe(201);
    expect((await call("POST", "/api/buildings", ok)).status).toBe(409);
    expect((await call("POST", "/api/buildings", { ...ok, slug: "Bad Slug" })).status).toBe(400);
    expect((await call("POST", "/api/buildings", { ...ok, slug: "x2", district: "atlantis" })).status).toBe(400);
    expect((await call("POST", "/api/buildings", { ...ok, slug: "x3", address_uk: "" })).status).toBe(400);
    expect(await auditActions()).toEqual(["building.add"]);
  });

  it("creates a sensor key shown once, stored only encrypted, and rotates it", async () => {
    const first = (await (await call("POST", "/api/buildings/1/sensor_key")).json()) as { sensor_id: string; key: string };
    expect(first.sensor_id).toBe("s-revutskogo-54a");
    const stored = await env.DB.prepare("SELECT key_encrypted FROM sensors WHERE id = ?").bind(first.sensor_id).first<{ key_encrypted: string }>();
    expect(stored?.key_encrypted).not.toContain(first.key);
    expect(toBase64(await decryptSensorKey(env.MASTER_KEY, stored!.key_encrypted))).toBe(first.key);
    expect(fromBase64(first.key)).toHaveLength(32);

    const second = (await (await call("POST", "/api/buildings/1/sensor_key")).json()) as { key: string };
    expect(second.key).not.toBe(first.key);
    expect(await auditActions()).toEqual(["sensor.create", "sensor.rotate_key"]);
  });

  it("switches maintenance, visibility and the sensor", async () => {
    await call("POST", "/api/buildings/1/sensor_key");
    expect((await call("POST", "/api/buildings/1/maintenance", { value: true })).status).toBe(200);
    expect((await call("POST", "/api/buildings/1/active", { value: false })).status).toBe(200);
    expect((await call("POST", "/api/buildings/1/sensor_enabled", { value: false })).status).toBe(200);
    expect((await call("POST", "/api/buildings/1/maintenance", { value: "yes" })).status).toBe(400);
    expect((await call("POST", "/api/buildings/999/maintenance", { value: true })).status).toBe(404);
    const row = await env.DB.prepare("SELECT b.maintenance, b.active, s.enabled FROM buildings b JOIN sensors s ON s.building_id = b.id WHERE b.id = 1").first();
    expect(row).toEqual({ maintenance: 1, active: 0, enabled: 0 });
    expect(await auditActions()).toEqual(["sensor.create", "maintenance.on", "active.off", "sensor_enabled.off"]);
  });

  it("closes a request", async () => {
    await env.DB.prepare("INSERT INTO users (telegram_chat_id) VALUES (1)").run();
    const { meta } = await env.DB.prepare("INSERT INTO building_requests (chat_id, text) VALUES (1, 'Бажана 10')").run();
    expect((await call("DELETE", `/api/requests/${meta.last_row_id}`)).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM building_requests").first("n")).toBe(0);
    expect(await auditActions()).toEqual(["request.close"]);
  });

  it("blocks changes from other sites (CSRF)", async () => {
    const add = { slug: "x", address_uk: "a", address_en: "a", district: "darnytskyi" };
    expect((await call("POST", "/api/buildings", add, {})).status).toBe(403);
    expect((await call("POST", "/api/buildings", add, { "x-svitlo-admin": "1", origin: "https://evil.example" })).status).toBe(403);
    expect(await auditActions()).toEqual([]);
  });
});

describe("low battery alerts", () => {
  beforeEach(resetState);

  it("tells the admin once, and again only after the battery recovered", async () => {
    await env.DB.prepare("INSERT INTO sensors (id, building_id, key_encrypted, battery_mv) VALUES ('s-revutskogo-54a', 1, 'x', 3350)").run();
    const sent: string[] = [];
    const tg: TelegramClient = {
      async call<T>(_m: string, p: Record<string, unknown>) {
        sent.push(String(p.text));
        return { ok: true, result: {} as T };
      },
    };
    expect(await batteryAlerts(env, tg)).toBe(1);
    expect(sent[0]).toContain("низький заряд батареї датчика (3350 мВ)");
    expect(await batteryAlerts(env, tg)).toBe(0);
    await env.DB.exec("UPDATE sensors SET battery_mv = 4100");
    expect(await batteryAlerts(env, tg)).toBe(0); // re-armed silently
    await env.DB.exec("UPDATE sensors SET battery_mv = 3300");
    expect(await batteryAlerts(env, tg)).toBe(1);
  });
});
