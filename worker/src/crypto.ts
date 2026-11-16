// Web Crypto helpers shared by the Worker and the Node scripts in scripts/.

type Bytes = Uint8Array<ArrayBuffer>;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Bytes {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parses lowercase or uppercase hex; returns null for anything else. */
export function fromHex(hex: string): Bytes | null {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A new random 256-bit sensor key. */
export function randomKey(): Bytes {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function importMasterKey(masterKeyB64: string): Promise<CryptoKey> {
  const raw = fromBase64(masterKeyB64);
  if (raw.length !== 32) throw new Error("MASTER_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts a sensor key for storage in D1: base64(iv[12] || AES-GCM ciphertext). */
export async function encryptSensorKey(masterKeyB64: string, sensorKey: Bytes): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const master = await importMasterKey(masterKeyB64);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, master, sensorKey));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64(out);
}

export async function decryptSensorKey(masterKeyB64: string, stored: string): Promise<Bytes> {
  const data = fromBase64(stored);
  const master = await importMasterKey(masterKeyB64);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: data.subarray(0, 12) },
    master,
    data.subarray(12),
  );
  return new Uint8Array(plain);
}

export function importHmacKey(raw: Bytes, usages: ("sign" | "verify")[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

/** HMAC-SHA256 of the exact body bytes, as lowercase hex. This is what a sensor sends. */
export async function signBody(sensorKey: Bytes, body: string): Promise<string> {
  const key = await importHmacKey(sensorKey, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return toHex(new Uint8Array(mac));
}
