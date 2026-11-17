// svitlo-admin Worker: https://svitlo-admin.yanasworks.com, behind Cloudflare
// Access. Every request (UI files too) needs a valid Access token for an
// allowed email; otherwise 403.

import { verifyAccessJwt } from "./access.ts";
import { handleAdminApi, type AdminEnv } from "./api.ts";

export async function authenticate(request: Request, env: AdminEnv): Promise<string | null> {
  const { hostname } = new URL(request.url);
  if (env.DEV_NO_ACCESS === "1" && (hostname === "localhost" || hostname === "127.0.0.1")) return "dev@localhost";
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  return verifyAccessJwt(token, {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD,
    emails: env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const email = await authenticate(request, env);
    if (email === null) return new Response("Forbidden", { status: 403 });
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return handleAdminApi(request, env, email);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<AdminEnv>;
