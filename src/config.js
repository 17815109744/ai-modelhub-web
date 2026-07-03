const crypto = require("crypto");

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function getConfig() {
  return {
    nodeEnv: process.env.NODE_ENV || "development",
    port: Number(process.env.PORT || 5173),
    dataBackend: process.env.DATA_BACKEND || "local",
    databaseUrl: process.env.DATABASE_URL || "",
    directUrl: process.env.DIRECT_URL || "",
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    authJwksUrl: process.env.AUTH_JWKS_URL || "",
    authJwtIssuer: process.env.AUTH_JWT_ISSUER || "",
    authJwtAudience: process.env.AUTH_JWT_AUDIENCE || "authenticated",
    credentialMasterKey: process.env.CREDENTIAL_MASTER_KEY || "",
    credentialKeyVersion: process.env.CREDENTIAL_KEY_VERSION || "v1",
    privacyDefaultMode: process.env.PRIVACY_DEFAULT_MODE || "strict",
    storeMessageContent: boolEnv("STORE_MESSAGE_CONTENT", true),
    logBodyContent: boolEnv("LOG_BODY_CONTENT", false),
    r2: {
      accountId: process.env.R2_ACCOUNT_ID || "",
      accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
      bucket: process.env.R2_BUCKET || "",
      publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || ""
    },
    upstash: {
      url: process.env.UPSTASH_REDIS_REST_URL || "",
      token: process.env.UPSTASH_REDIS_REST_TOKEN || ""
    }
  };
}

function requireProductionSecret(name, value) {
  if ((process.env.NODE_ENV || "development") === "production" && !value) {
    throw new Error(`${name} is required in production`);
  }
}

function decodeKey(value) {
  if (!value) return null;
  const trimmed = value.trim();
  const base64 = Buffer.from(trimmed, "base64");
  if (base64.length === 32) return base64;
  const hex = Buffer.from(trimmed, "hex");
  if (hex.length === 32) return hex;
  throw new Error("CREDENTIAL_MASTER_KEY must be 32 bytes as base64 or hex");
}

let warnedDevKey = false;

function getCredentialMasterKey() {
  const config = getConfig();
  requireProductionSecret("CREDENTIAL_MASTER_KEY", config.credentialMasterKey);
  const decoded = decodeKey(config.credentialMasterKey);
  if (decoded) return decoded;

  if (!warnedDevKey) {
    warnedDevKey = true;
    console.warn("CREDENTIAL_MASTER_KEY is not set; using an insecure development-only key.");
  }
  return crypto.createHash("sha256").update("modelhub-local-development-key").digest();
}

module.exports = {
  getConfig,
  getCredentialMasterKey
};
