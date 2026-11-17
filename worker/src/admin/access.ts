// Verifies the Cloudflare Access login token (Cf-Access-Jwt-Assertion) on every
// admin request. Access already blocks unauthenticated visitors at the edge;
// this check means the admin Worker trusts nothing it hasn't verified itself.

export interface AccessConfig {
  /** e.g. "yourteam.cloudflareaccess.com" */
  teamDomain: string;
  /** The Access application's Audience (AUD) tag. */
  aud: string;
  /** Allowed emails, lowercase. */
  emails: string[];
}

interface Jwk extends JsonWebKey {
  kid: string;
}
export type JwksFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

const defaultFetcher: JwksFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`certs: HTTP ${res.status}`);
  return (await res.json()) as { keys: Jwk[] };
};

let cache: { url: string; at: number; keys: Jwk[] } | null = null;
const CACHE_S = 3600;

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = (s: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function keysFor(url: string, now: number, fetcher: JwksFetcher, refresh: boolean): Promise<Jwk[]> {
  if (!refresh && cache?.url === url && now - cache.at < CACHE_S) return cache.keys;
  const { keys } = await fetcher(url);
  cache = { url, at: now, keys };
  return keys;
}

/** Returns the verified email, or null. Never throws for a bad token. */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  now = Math.floor(Date.now() / 1000),
  fetcher: JwksFetcher = defaultFetcher,
): Promise<string | null> {
  try {
    if (!config.teamDomain || !config.aud || config.emails.length === 0) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h = "", p = "", s = ""] = parts;
    const header = b64urlJson(h);
    const payload = b64urlJson(p);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

    const certs = `https://${config.teamDomain}/cdn-cgi/access/certs`;
    let jwk = (await keysFor(certs, now, fetcher, false)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await keysFor(certs, now, fetcher, true)).find((k) => k.kid === header.kid); // keys rotate
    if (!jwk) return null;

    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
    if (!valid) return null;

    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== `https://${config.teamDomain}`) return null;
    if (!aud.includes(config.aud)) return null;
    if (typeof payload.exp !== "number" || payload.exp <= now) return null;
    if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    return config.emails.includes(email) ? email : null;
  } catch {
    return null;
  }
}
