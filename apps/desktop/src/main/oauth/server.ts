import express from "express";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { AppDatabase } from "../db";

// Minimal OAuth 2.1 + PKCE + Dynamic Client Registration server.
//
// ChatGPT's MCP connector protocol requires a remote MCP server to sit
// behind OAuth -- there's no "local stdio, no auth" mode like Claude
// Desktop. This is not multi-tenant auth: there's exactly one user (whoever
// controls this Mac), so "authorization" is just a single click-through
// consent page, not a real login. See ../../../README.md for the
// ChatGPT-side connector setup this pairs with.
//
// NOTE: this endpoint set is unverified against a live ChatGPT Developer
// Mode connector -- see README "Phase 4" for what's been tested vs. not.

const CODE_TTL_MS = 5 * 60 * 1000; // 5 min, per OAuth best practice for auth codes
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== "S256") return false; // "plain" is not acceptable for OAuth 2.1
  const computed = base64url(createHash("sha256").update(verifier).digest());
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface OAuthOptions {
  /** Public base URL of this server once tunneled, e.g. https://schedule.yourdomain.com */
  issuer: () => string;
}

export function mountOAuthServer(app: express.Express, db: AppDatabase, opts: OAuthOptions) {
  const router = express.Router();
  router.use(express.json());
  router.use(express.urlencoded({ extended: true }));

  // RFC 8414 authorization server metadata -- lets ChatGPT discover the
  // other endpoints from just the issuer URL.
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    const issuer = opts.issuer();
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  // RFC 9728 protected-resource metadata, pointing at this same issuer.
  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    const issuer = opts.issuer();
    res.json({ resource: `${issuer}/mcp`, authorization_servers: [issuer] });
  });

  // Dynamic Client Registration (RFC 7591) -- ChatGPT self-registers on first connect.
  router.post("/oauth/register", (req, res) => {
    const { client_name, redirect_uris } = req.body ?? {};
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
      return;
    }
    const client_id = randomUUID();
    db.createOAuthClient({ client_id, client_name, redirect_uris });
    res.status(201).json({
      client_id,
      client_name,
      redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // Authorization endpoint -- single-user consent screen (no password; this
  // Mac IS the account). Real HTML page rather than an auto-redirect so a
  // stray/forged link can't silently mint a code without the user seeing it.
  router.get("/oauth/authorize", (req, res) => {
    const { client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query as Record<string, string>;
    const client = client_id ? db.getOAuthClient(client_id) : null;
    if (!client || !redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).send("Unknown client or redirect_uri");
      return;
    }
    if (!code_challenge || code_challenge_method !== "S256") {
      res.status(400).send("PKCE (S256) is required");
      return;
    }

    const approveUrl = `/oauth/approve?${new URLSearchParams({
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state: state ?? "",
    })}`;

    res.send(`<!doctype html>
<html><body style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 80px auto; text-align: center;">
  <h2>Connect ${escapeHtml(client.client_name ?? "this app")} to your BCBA Route Planner?</h2>
  <p>It will be able to read and edit your clients, sessions, and schedule.</p>
  <form method="POST" action="${approveUrl}">
    <button type="submit" style="padding: 10px 24px; font-size: 15px;">Allow access</button>
  </form>
</body></html>`);
  });

  router.post("/oauth/approve", (req, res) => {
    const { client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query as Record<string, string>;
    const client = db.getOAuthClient(client_id);
    if (!client || !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).send("Unknown client or redirect_uri");
      return;
    }
    const code = base64url(randomBytes(32));
    db.createOAuthCode({
      code,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    });
    const redirect = new URL(redirect_uri);
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", state);
    res.redirect(redirect.toString());
  });

  // Token endpoint -- authorization_code (with PKCE) and refresh_token grants.
  router.post("/oauth/token", (req, res) => {
    const { grant_type } = req.body ?? {};

    if (grant_type === "authorization_code") {
      const { code, redirect_uri, client_id, code_verifier } = req.body ?? {};
      const stored = code ? db.consumeOAuthCode(code) : null;
      if (
        !stored ||
        stored.used === 1 ||
        stored.client_id !== client_id ||
        stored.redirect_uri !== redirect_uri ||
        new Date(stored.expires_at).getTime() < Date.now() ||
        !code_verifier ||
        !verifyPkce(code_verifier, stored.code_challenge, stored.code_challenge_method)
      ) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      res.json(issueToken(db, client_id));
      return;
    }

    if (grant_type === "refresh_token") {
      const { refresh_token } = req.body ?? {};
      const stored = refresh_token ? db.getOAuthTokenByRefreshToken(refresh_token) : null;
      if (!stored) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      db.deleteOAuthToken(stored.access_token);
      res.json(issueToken(db, stored.client_id));
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  app.use(router);
}

function issueToken(db: AppDatabase, clientId: string) {
  const access_token = base64url(randomBytes(32));
  const refresh_token = base64url(randomBytes(32));
  db.createOAuthToken({
    access_token,
    refresh_token,
    client_id: clientId,
    expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString(),
  });
  return { access_token, refresh_token, token_type: "Bearer", expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) };
}

/** Express middleware: require a valid, unexpired bearer token. Mount in front of the /mcp route. */
export function requireBearerAuth(db: AppDatabase, opts: OAuthOptions) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const header = req.header("authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    const token = match ? db.getOAuthTokenByAccessToken(match[1]) : null;
    if (!token || new Date(token.expires_at).getTime() < Date.now()) {
      res
        .status(401)
        .set("WWW-Authenticate", `Bearer resource_metadata="${opts.issuer()}/.well-known/oauth-protected-resource"`)
        .json({ error: "invalid_token" });
      return;
    }
    next();
  };
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
