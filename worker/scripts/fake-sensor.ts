// A software stand-in for the ESP32 sensor. It signs reports exactly like the
// firmware will.
//
//   node scripts/fake-sensor.ts <sensor-id> [--url http://localhost:8787] [--remote]
//       --remote: the production key and https://svitlo.yanasworks.com
//       Interactive: o = grid on, f = grid off, w = Wi-Fi down/up, q = quit.
//       Reports every 60 s, at once on a change, and again 30 s after it.
//   node scripts/fake-sensor.ts <sensor-id> once on|off [--for <seconds>]
//       One report. --for says the state began that many seconds ago.
//   node scripts/fake-sensor.ts <sensor-id> attack
//       Sends a valid report, then a replay, a bad signature and a stale one.
//
// The key is read from worker/.sensors/<sensor-id>.json (made by sensor-key.ts).

import { readFileSync, writeFileSync } from "node:fs";
import { fromBase64, signBody } from "../src/crypto.ts";

type Grid = "on" | "off";

const args = process.argv.slice(2);
const remoteFlag = args.indexOf("--remote");
const remote = remoteFlag >= 0 && args.splice(remoteFlag, 1).length > 0;
const urlFlag = args.indexOf("--url");
const baseUrl = urlFlag >= 0 ? args.splice(urlFlag, 2)[1] : remote ? "https://svitlo.yanasworks.com" : "http://localhost:8787";
const forFlag = args.indexOf("--for");
const forSeconds = forFlag >= 0 ? Number(args.splice(forFlag, 2)[1]) : 0;
const [sensorId, mode = "run", modeArg] = args;
if (!sensorId) {
  console.error("Usage: node scripts/fake-sensor.ts <sensor-id> [run | once on|off [--for S] | attack] [--remote] [--url URL]");
  process.exit(1);
}

const file = new URL(`../.sensors/${remote ? "remote/" : ""}${sensorId}.json`, import.meta.url);
const saved = JSON.parse(readFileSync(file, "utf8")) as { sensor_id: string; key: string; last_ts?: number };
const key = fromBase64(saved.key);
const endpoint = `${baseUrl}/api/v1/report`;

let grid: Grid = "on";
let since = nowS();
// Remembered between runs, so two quick runs never reuse a timestamp (the server rejects that as a replay).
let lastTs = saved.last_ts ?? 0;
let wifiDown = false;

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

/** Like the firmware: ts must always increase, even within one second. */
function nextTs(): number {
  lastTs = Math.max(nowS(), lastTs + 1);
  writeFileSync(file, JSON.stringify({ ...saved, last_ts: lastTs }, null, 2) + "\n", { mode: 0o600 });
  return lastTs;
}

function makeBody(ts = nextTs()): string {
  return JSON.stringify({
    sensor_id: sensorId,
    grid,
    since,
    ts,
    battery_mv: grid === "on" ? 4150 : 3900,
    wifi_rssi: -55 - Math.floor(Math.random() * 15),
    fw: "fake-0.1.0",
  });
}

async function post(body: string, signature?: string): Promise<number> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": signature ?? (await signBody(key, body)) },
    body,
  });
  return res.status;
}

async function report(reason: string): Promise<void> {
  const time = new Date().toLocaleTimeString("uk-UA");
  if (wifiDown) {
    console.log(`${time}  ${reason}: Wi-Fi down, not sent (grid ${grid})`);
    return;
  }
  try {
    const code = await post(makeBody());
    console.log(`${time}  ${reason}: grid ${grid} -> HTTP ${code}`);
  } catch (error) {
    console.log(`${time}  ${reason}: ${(error as Error).message}`);
  }
}

if (mode === "once") {
  if (modeArg !== "on" && modeArg !== "off") throw new Error("once needs on or off");
  grid = modeArg;
  since = nowS() - forSeconds;
  await report(forSeconds ? `once (state began ${forSeconds} s ago)` : "once");
} else if (mode === "attack") {
  const check = (name: string, got: number, want: number) =>
    console.log(`${got === want ? "PASS" : "FAIL"}  ${name}: HTTP ${got} (expected ${want})`);
  since = nowS() - 600; // the grid state began 10 min ago
  const body = makeBody();
  check("valid report", await post(body), 204);
  check("replay of the same report", await post(body), 401);
  check("wrong signature", await post(makeBody(), "00".repeat(32)), 401);
  check("stale timestamp (5 min old)", await post(makeBody(nowS() - 300)), 401);
} else if (mode === "run") {
  let confirm: ReturnType<typeof setTimeout> | undefined;
  const setGrid = (next: Grid) => {
    if (next === grid) return;
    grid = next;
    since = nowS();
    void report("change");
    clearTimeout(confirm);
    confirm = setTimeout(() => void report("confirm"), 30_000);
  };

  console.log(`Fake sensor ${sensorId} -> ${endpoint}`);
  console.log("Keys: o = grid on, f = grid off, w = Wi-Fi down/up, q = quit");
  await report("start");
  setInterval(() => void report("periodic"), 60_000);

  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (k: string) => {
    if (k === "o") setGrid("on");
    else if (k === "f") setGrid("off");
    else if (k === "w") {
      wifiDown = !wifiDown;
      console.log(wifiDown ? "Wi-Fi is now DOWN" : "Wi-Fi is back");
      if (!wifiDown) void report("reconnect");
    } else if (k === "q" || k === "\u0003") process.exit(0);
  });
} else {
  console.error(`Unknown mode: ${mode}`);
  process.exit(1);
}
