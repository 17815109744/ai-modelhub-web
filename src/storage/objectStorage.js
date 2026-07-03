const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getConfig } = require("../config");

const LOCAL_UPLOAD_DIR = path.join(process.cwd(), "data", "uploads");

function createStorageKey({ orgId, filename }) {
  const safeName = String(filename || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return `${orgId || "local-org"}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;
}

async function putObjectLocal({ key, body }) {
  const filePath = path.join(LOCAL_UPLOAD_DIR, key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
  return {
    provider: "local",
    key,
    url: ""
  };
}

async function putObjectR2({ key, body, contentType }) {
  const config = getConfig();
  if (!config.r2.accountId || !config.r2.bucket || !config.r2.accessKeyId || !config.r2.secretAccessKey) {
    throw new Error("R2 is not configured");
  }
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey
    }
  });
  await client.send(new PutObjectCommand({
    Bucket: config.r2.bucket,
    Key: key,
    Body: body,
    ContentType: contentType || "application/octet-stream"
  }));
  return {
    provider: "r2",
    key,
    url: config.r2.publicBaseUrl ? `${config.r2.publicBaseUrl.replace(/\/$/, "")}/${key}` : ""
  };
}

async function putObject({ orgId, filename, body, contentType }) {
  const config = getConfig();
  const key = createStorageKey({ orgId, filename });
  if (config.r2.bucket && config.r2.accountId) {
    return putObjectR2({ key, body, contentType });
  }
  return putObjectLocal({ key, body });
}

module.exports = {
  putObject,
  createStorageKey
};
