const { getConfig } = require("../config");

const SUPABASE_TOKEN_CACHE_TTL_MS = 60_000;
const supabaseTokenCache = new Map();

function getHeader(req, name) {
  return req.headers[String(name).toLowerCase()];
}

function parseJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function validateSupabaseToken(token) {
  const config = getConfig();
  if (!config.supabaseUrl || !config.supabaseAnonKey || !token) return null;
  const cached = supabaseTokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: config.supabaseAnonKey,
      authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    supabaseTokenCache.delete(token);
    return null;
  }
  const user = await response.json();
  supabaseTokenCache.set(token, {
    user,
    expiresAt: Date.now() + SUPABASE_TOKEN_CACHE_TTL_MS
  });
  return user;
}

async function resolveRequestContext(req) {
  const config = getConfig();
  const auth = getHeader(req, "authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  let claims = parseJwtPayload(bearer);
  let supabaseUser = null;

  if (bearer && config.supabaseUrl && config.supabaseAnonKey) {
    supabaseUser = await validateSupabaseToken(bearer);
    if (!supabaseUser && config.nodeEnv === "production") {
      throw new Error("Invalid or expired auth token");
    }
  }

  if (supabaseUser) {
    claims = {
      sub: supabaseUser.id,
      email: supabaseUser.email,
      ...claims
    };
  }

  const userId = getHeader(req, "x-user-id") || claims?.sub || "local-user";
  const orgId = getHeader(req, "x-org-id") || claims?.org_id || "local-org";
  const email = getHeader(req, "x-user-email") || claims?.email || "local@example.com";
  const privacyMode = getHeader(req, "x-privacy-mode") || config.privacyDefaultMode;

  return {
    userId,
    orgId,
    email,
    privacyMode,
    isAuthenticated: Boolean(supabaseUser || bearer || getHeader(req, "x-user-id")),
    authProvider: supabaseUser ? "supabase" : bearer ? "jwt" : "local"
  };
}

function scopeByOrg(context, extra = {}) {
  return {
    ...extra,
    orgId: context.orgId
  };
}

module.exports = {
  resolveRequestContext,
  scopeByOrg
};
