const crypto = require("crypto");
const { getConfig, getCredentialMasterKey } = require("../config");

const ALGORITHM = "AES-256-GCM";

function buildAad(context = {}) {
  return [
    context.orgId || "local-org",
    context.userId || "local-user",
    context.provider || "unknown-provider",
    context.credentialId || "unknown-credential"
  ].join(":");
}

function buildContentAad(context = {}) {
  return [
    "modelhub-content-v1",
    context.orgId || "local-org",
    context.userId || "local-user",
    context.conversationId || "unknown-conversation",
    context.messageId || "unknown-message",
    context.role || "unknown-role",
    context.modelId || "none"
  ].join(":");
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function fingerprintSecret(secret) {
  return crypto
    .createHmac("sha256", getCredentialMasterKey())
    .update(String(secret || ""))
    .digest("hex")
    .slice(0, 24);
}

function previewSecret(secret) {
  const clean = String(secret || "").trim();
  if (clean.length <= 8) return "****";
  return `${clean.slice(0, 4)}****${clean.slice(-4)}`;
}

function encryptSecret(secret, context = {}) {
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(buildAad(context), "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", getCredentialMasterKey(), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    envelope: "modelhub-secret-v1",
    algorithm: ALGORITHM,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    aadHash: hash(aad.toString("utf8")),
    keyVersion: getConfig().credentialKeyVersion
  };
}

function encryptContent(content, context = {}) {
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(buildContentAad(context), "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", getCredentialMasterKey(), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(String(content || ""), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    envelope: "modelhub-content-v1",
    algorithm: ALGORITHM,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion: getConfig().credentialKeyVersion
  };
}

function decryptSecret(envelope, context = {}) {
  if (!envelope || envelope.algorithm !== ALGORITHM) {
    throw new Error("Unsupported secret envelope");
  }
  const aad = Buffer.from(buildAad(context), "utf8");
  if (envelope.aadHash && envelope.aadHash !== hash(aad.toString("utf8"))) {
    throw new Error("Secret context does not match AAD");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getCredentialMasterKey(),
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function decryptContent(envelope, context = {}) {
  if (!envelope || envelope.algorithm !== ALGORITHM) {
    throw new Error("Unsupported content envelope");
  }
  const aad = Buffer.from(buildContentAad(context), "utf8");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getCredentialMasterKey(),
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function redactSensitive(value) {
  return String(value || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-****")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ****")
    .replace(/AIza[0-9A-Za-z_-]{12,}/g, "AIza****")
    .replace(/ANTHROPIC_API_KEY=[^\s]+/g, "ANTHROPIC_API_KEY=****");
}

module.exports = {
  encryptSecret,
  decryptSecret,
  encryptContent,
  decryptContent,
  fingerprintSecret,
  previewSecret,
  redactSensitive
};
