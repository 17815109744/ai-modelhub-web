const { getConfig } = require("../config");

const memoryBuckets = new Map();

async function upstashCommand(command) {
  const config = getConfig();
  if (!config.upstash.url || !config.upstash.token) return null;
  const response = await fetch(`${config.upstash.url.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.upstash.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(command)
  });
  if (!response.ok) {
    throw new Error(`Upstash command failed: ${response.status}`);
  }
  return response.json();
}

async function checkRateLimit({ key, limit = 60, windowSeconds = 60 }) {
  const redisKey = `ratelimit:${key}`;
  const remote = await upstashCommand([
    ["INCR", redisKey],
    ["EXPIRE", redisKey, String(windowSeconds), "NX"]
  ]);
  if (remote) {
    const count = Number(remote.result?.[0]?.result || remote[0]?.result || 0);
    return { allowed: count <= limit, count, limit, backend: "upstash" };
  }

  const now = Date.now();
  const bucket = memoryBuckets.get(redisKey) || { count: 0, resetAt: now + windowSeconds * 1000 };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + windowSeconds * 1000;
  }
  bucket.count += 1;
  memoryBuckets.set(redisKey, bucket);
  return {
    allowed: bucket.count <= limit,
    count: bucket.count,
    limit,
    resetAt: bucket.resetAt,
    backend: "memory"
  };
}

module.exports = {
  checkRateLimit
};
