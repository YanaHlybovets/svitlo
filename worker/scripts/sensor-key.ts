// Creates or rotates a building's sensor key (until the admin panel exists).
//
//   node scripts/sensor-key.ts add <building-slug> [--remote]
//   node scripts/sensor-key.ts rotate <building-slug> [--remote]
//
// The key is printed once and saved to .sensors/<sensor-id>.json (git-ignored)
// for flashing and for the fake sensor. D1 stores it only encrypted.
// Local: MASTER_KEY is read from .dev.vars. --remote: set MASTER_KEY in the
// environment to the same value as the Worker secret.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { encryptSensorKey, randomKey, toBase64 } from "../src/crypto.ts";

const workerDir = new URL("..", import.meta.url);
const [command, slug, ...flags] = process.argv.slice(2);
const remote = flags.includes("--remote");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if ((command !== "add" && command !== "rotate") || !slug) {
  fail("Usage: node scripts/sensor-key.ts add|rotate <building-slug> [--remote]");
}
// Both values are validated here, so they are safe to put into the SQL below
// (wrangler d1 execute does not take bound parameters).
if (!/^[a-z0-9-]{1,48}$/.test(slug)) fail(`Invalid building slug: ${slug}`);

function masterKey(): string {
  if (process.env.MASTER_KEY) return process.env.MASTER_KEY;
  if (remote) fail("For --remote, set MASTER_KEY in the environment.");
  const vars = readFileSync(new URL(".dev.vars", workerDir), "utf8");
  const match = vars.match(/^MASTER_KEY\s*=\s*"?([A-Za-z0-9+/=]+)"?\s*$/m);
  return match?.[1] ?? fail("MASTER_KEY not found in worker/.dev.vars");
}

const sensorId = `s-${slug}`;
const key = randomKey();
const stored = await encryptSensorKey(masterKey(), key);
if (!/^[A-Za-z0-9+/=]+$/.test(stored)) fail("Unexpected encrypted key format");

const sql =
  command === "add"
    ? `INSERT INTO sensors (id, building_id, key_encrypted)
       SELECT '${sensorId}', id, '${stored}' FROM buildings WHERE slug = '${slug}'
       RETURNING id;`
    : `UPDATE sensors SET key_encrypted = '${stored}' WHERE id = '${sensorId}' RETURNING id;`;

let output: string;
try {
  output = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "svitlo-db", remote ? "--remote" : "--local", "--json", "--command", sql],
    { cwd: workerDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (error) {
  const e = error as { stdout?: string; stderr?: string };
  if (`${e.stdout}${e.stderr}`.includes("UNIQUE constraint failed")) {
    fail(`Building "${slug}" already has a sensor. Use "rotate" to issue a new key.`);
  }
  fail(`wrangler failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
}
// RETURNING gives back the affected row; local D1 does not report a change count.
const rows = (JSON.parse(output) as { results?: unknown[] }[])[0]?.results ?? [];
if (rows.length !== 1) {
  fail(command === "add" ? `No building with slug "${slug}".` : `Sensor ${sensorId} does not exist yet; use "add".`);
}

const keyB64 = toBase64(key);
mkdirSync(new URL(".sensors/", workerDir), { recursive: true });
writeFileSync(
  new URL(`.sensors/${sensorId}.json`, workerDir),
  JSON.stringify({ sensor_id: sensorId, key: keyB64 }, null, 2) + "\n",
  { mode: 0o600 },
);

console.log(`${command === "add" ? "Added" : "Rotated"} ${sensorId} (${remote ? "remote" : "local"} D1)`);
console.log(`Sensor key (shown once, flash it into the device): ${keyB64}`);
console.log(`Saved to worker/.sensors/${sensorId}.json (git-ignored)`);
