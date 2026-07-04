const crypto = require("crypto");
const { decryptContent, decryptSecret, encryptContent } = require("../security/encryption");
const { getPrismaClient } = require("./prismaClient");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVACY_LEVELS = new Set(["public", "internal", "confidential", "regulated"]);
const TENANT_CACHE_TTL_MS = 5 * 60_000;
const tenantCache = new Map();

function isUuid(value) {
  return UUID_RE.test(String(value || ""));
}

function assertUser(context) {
  if (!context?.isAuthenticated || !isUuid(context.userId)) {
    throw new Error("Supabase login is required for database-backed private data");
  }
}

function normalizePrivacyLevel(value) {
  return PRIVACY_LEVELS.has(value) ? value : "internal";
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function toDateOnly(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function credentialToState(row) {
  const status = row.health || "unknown";
  const labels = {
    ok: "健康",
    warn: "预警",
    bad: "异常",
    unknown: "未检测"
  };
  return {
    id: row.id,
    orgId: row.orgId,
    provider: row.provider,
    name: row.name,
    preview: row.preview,
    fingerprint: row.fingerprintHash,
    keyVersion: row.keyVersion,
    encrypted: true,
    health: {
      status,
      label: labels[status] || labels.unknown,
      detail: row.healthDetail || "等待健康检测"
    },
    balanceUsd: row.balanceUsd == null ? null : Number(row.balanceUsd),
    lastCheckedAt: toIso(row.lastCheckedAt),
    createdAt: toIso(row.createdAt)
  };
}

function providerFamily(provider) {
  const normalized = String(provider || "").toLowerCase();
  if (normalized.includes("openai")) return "openai";
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "anthropic";
  if (normalized.includes("gemini") || normalized.includes("google")) return "gemini";
  if (normalized.includes("deepseek")) return "deepseek";
  return normalized.trim();
}

function providerMatchesCredential(credentialProvider, targetProvider) {
  const credentialFamily = providerFamily(credentialProvider);
  const targetFamily = providerFamily(targetProvider);
  return Boolean(credentialFamily && targetFamily && credentialFamily === targetFamily);
}

function auditToState(row) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    id: row.id,
    action: row.action,
    actor: row.actor?.email || metadata.actor || "system",
    detail: metadata.detail || row.target || "",
    createdAt: toIso(row.createdAt)
  };
}

function messageContext(tenant, row) {
  return {
    orgId: tenant.orgId,
    userId: tenant.userId,
    conversationId: row.conversationId,
    messageId: row.id,
    role: row.role,
    modelId: row.modelId || "none"
  };
}

function encryptedContentFields(tenant, conversationId, message, content, shouldStoreContent = true) {
  if (!shouldStoreContent) {
    return {
      contentPreview: "[正文未保存]"
    };
  }

  const envelope = encryptContent(content, messageContext(tenant, { ...message, conversationId }));
  return {
    contentCipher: envelope.ciphertext,
    contentIv: envelope.iv,
    contentAuthTag: envelope.authTag,
    contentPreview: ""
  };
}

function decryptMessageContent(tenant, row) {
  if (!row.contentCipher || !row.contentIv || !row.contentAuthTag) {
    return row.contentPreview || "";
  }

  try {
    return decryptContent(
      {
        algorithm: "AES-256-GCM",
        ciphertext: row.contentCipher,
        iv: row.contentIv,
        authTag: row.contentAuthTag
      },
      messageContext(tenant, row)
    );
  } catch {
    return row.contentPreview || "[内容无法解密]";
  }
}

function providerStatusFromRequest(row) {
  if (!row) return undefined;
  if (row.errorCode === "policy_blocked") return "blocked";
  if (row.errorCode === "simulated") return "simulated";
  if (row.errorCode || (row.statusCode && Number(row.statusCode) >= 400)) return "error";
  if (row.statusCode && Number(row.statusCode) >= 200 && Number(row.statusCode) < 300) return "live";
  return undefined;
}

function messageToState(tenant, row, extra = {}) {
  return {
    id: row.id,
    role: row.role,
    modelId: row.modelId,
    modelName: row.modelId || "",
    provider: row.provider,
    content: decryptMessageContent(tenant, row),
    tokenCount: row.tokenCount || 0,
    createdAt: toIso(row.createdAt),
    ...(extra.providerStatus ? { providerStatus: extra.providerStatus } : {})
  };
}

function conversationToState(tenant, row) {
  const requests = (row.requests || []).slice().sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  let requestIndex = 0;
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    title: row.title,
    privacyLevel: row.privacyLevel,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    messages: (row.messages || [])
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map((message) => {
        if (message.role !== "assistant") return messageToState(tenant, message);
        const matchedIndex = requests.findIndex((request, index) => index >= requestIndex && request.modelId === message.modelId);
        const request = matchedIndex >= 0 ? requests[matchedIndex] : requests[requestIndex];
        if (matchedIndex >= 0) requestIndex = matchedIndex + 1;
        else requestIndex += 1;
        return messageToState(tenant, message, {
          providerStatus: providerStatusFromRequest(request)
        });
      })
  };
}

function usageToState(row) {
  return {
    id: row.id,
    orgId: row.orgId,
    requestId: row.requestId,
    date: toDateOnly(row.date),
    provider: row.provider,
    modelId: row.modelId,
    modelName: row.modelId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    costUsd: Number(row.costUsd || 0),
    costCny: row.costCny == null ? null : Number(row.costCny),
    source: "chat",
    conversationId: row.request?.conversationId || null,
    createdAt: toIso(row.createdAt)
  };
}

function settingsToState(row, fallback = {}) {
  const stored = row?.settings && typeof row.settings === "object" ? row.settings : {};
  return {
    ...fallback,
    ...stored,
    fxRate: Number(stored.fxRate ?? fallback.fxRate ?? 7.25),
    budgetUsd: Number(stored.budgetUsd ?? fallback.budgetUsd ?? 300)
  };
}

function promptToState(row) {
  return {
    id: row.sourceId || row.id,
    dbId: row.id,
    sourceId: row.sourceId,
    title: row.title,
    category: row.category,
    body: row.body,
    official: Boolean(row.official),
    favorite: Boolean(row.favorite),
    shared: Boolean(row.shared),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

function mergePrompts(officialPrompts = [], rows = []) {
  const bySourceId = new Map();
  const custom = [];

  for (const row of rows) {
    const prompt = promptToState(row);
    if (prompt.sourceId) {
      bySourceId.set(prompt.sourceId, prompt);
    } else {
      custom.push(prompt);
    }
  }

  const official = officialPrompts.map((prompt) => ({
    ...prompt,
    ...(bySourceId.get(prompt.id) || {}),
    id: prompt.id,
    sourceId: bySourceId.get(prompt.id)?.sourceId || prompt.id,
    official: true
  }));

  return [
    ...custom.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
    ...official
  ];
}

async function ensureTenant(context) {
  assertUser(context);
  const cacheKey = `${context.userId}:${context.email || ""}`;
  const cached = tenantCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.tenant;

  const prisma = getPrismaClient();
  const email = context.email || `${context.userId}@local.modelhub`;
  const slug = `user-${context.userId.replace(/-/g, "").slice(0, 18)}`;

  const profile = await prisma.profile.upsert({
    where: { id: context.userId },
    update: { email },
    create: {
      id: context.userId,
      email
    }
  });

  const org = await prisma.organization.upsert({
    where: { slug },
    update: {},
    create: {
      name: profile.email ? `${profile.email} 的空间` : "个人空间",
      slug
    }
  });

  await prisma.organizationMember.upsert({
    where: {
      orgId_userId: {
        orgId: org.id,
        userId: profile.id
      }
    },
    update: {},
    create: {
      orgId: org.id,
      userId: profile.id,
      role: "owner"
    }
  });

  const tenant = {
    userId: profile.id,
    orgId: org.id,
    email: profile.email
  };
  tenantCache.set(cacheKey, {
    tenant,
    expiresAt: Date.now() + TENANT_CACHE_TTL_MS
  });
  return tenant;
}

async function listCredentials(context) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const rows = await prisma.apiCredential.findMany({
    where: {
      orgId: tenant.orgId,
      revokedAt: null
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      orgId: true,
      provider: true,
      name: true,
      preview: true,
      fingerprintHash: true,
      keyVersion: true,
      health: true,
      healthDetail: true,
      balanceUsd: true,
      lastCheckedAt: true,
      createdAt: true
    }
  });
  return rows.map(credentialToState);
}

async function getCredentialSecretForProvider(context, provider) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const rows = await prisma.apiCredential.findMany({
    where: {
      orgId: tenant.orgId,
      revokedAt: null
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      provider: true,
      createdById: true,
      encryptedSecret: true,
      iv: true,
      authTag: true,
      aadHash: true
    }
  });
  const row = rows.find((credential) => providerMatchesCredential(credential.provider, provider));
  if (!row) return "";

  return decryptSecret(
    {
      algorithm: "AES-256-GCM",
      ciphertext: row.encryptedSecret,
      iv: row.iv,
      authTag: row.authTag,
      aadHash: row.aadHash
    },
    {
      orgId: tenant.orgId,
      userId: row.createdById || tenant.userId,
      provider: row.provider,
      credentialId: row.id
    }
  );
}

async function getCredentialSecretById(context, credentialId) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const row = await prisma.apiCredential.findFirst({
    where: {
      id: credentialId,
      orgId: tenant.orgId,
      revokedAt: null
    },
    select: {
      id: true,
      provider: true,
      name: true,
      createdById: true,
      encryptedSecret: true,
      iv: true,
      authTag: true,
      aadHash: true
    }
  });
  if (!row) return null;

  const apiKey = decryptSecret(
    {
      algorithm: "AES-256-GCM",
      ciphertext: row.encryptedSecret,
      iv: row.iv,
      authTag: row.authTag,
      aadHash: row.aadHash
    },
    {
      orgId: tenant.orgId,
      userId: row.createdById || tenant.userId,
      provider: row.provider,
      credentialId: row.id
    }
  );
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    apiKey
  };
}

async function createCredential(context, input) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const row = await prisma.apiCredential.create({
    data: {
      id: input.id,
      orgId: tenant.orgId,
      createdById: tenant.userId,
      provider: input.provider,
      name: input.name,
      preview: input.preview,
      fingerprintHash: input.fingerprintHash,
      encryptedSecret: input.encryptedSecret,
      iv: input.iv,
      authTag: input.authTag,
      aadHash: input.aadHash,
      keyVersion: input.keyVersion
    }
  });
  return credentialToState(row);
}

async function updateCredentialHealth(context, credentialId, input) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const updated = await prisma.apiCredential.updateMany({
    where: {
      id: credentialId,
      orgId: tenant.orgId,
      revokedAt: null
    },
    data: {
      health: input.health?.status || "unknown",
      healthDetail: input.health?.detail || null,
      balanceUsd: input.balanceUsd == null ? null : input.balanceUsd,
      lastCheckedAt: input.lastCheckedAt ? new Date(input.lastCheckedAt) : new Date()
    }
  });
  if (!updated.count) return null;
  const row = await prisma.apiCredential.findFirst({
    where: {
      id: credentialId,
      orgId: tenant.orgId,
      revokedAt: null
    }
  });
  return row ? credentialToState(row) : null;
}

async function revokeCredential(context, credentialId) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const existing = await prisma.apiCredential.findFirst({
    where: {
      id: credentialId,
      orgId: tenant.orgId,
      revokedAt: null
    }
  });
  if (!existing) return null;
  await prisma.apiCredential.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() }
  });
  return credentialToState(existing);
}

async function findConversationRow(prisma, tenant, conversationId) {
  if (isUuid(conversationId)) {
    const row = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        orgId: tenant.orgId,
        userId: tenant.userId
      },
      include: {
        messages: {
          orderBy: { createdAt: "asc" }
        },
        requests: {
          orderBy: { createdAt: "asc" }
        }
      }
    });
    if (row) return row;
  }

  return prisma.conversation.findFirst({
    where: {
      orgId: tenant.orgId,
      userId: tenant.userId
    },
    orderBy: { updatedAt: "desc" },
    include: {
      messages: {
        orderBy: { createdAt: "asc" }
      },
      requests: {
        orderBy: { createdAt: "asc" }
      }
    }
  });
}

async function createDefaultConversation(prisma, tenant, input = {}) {
  return prisma.conversation.create({
    data: {
      orgId: tenant.orgId,
      userId: tenant.userId,
      title: input.title || "新会话",
      privacyLevel: normalizePrivacyLevel(input.privacyLevel)
    },
    include: {
      messages: {
        orderBy: { createdAt: "asc" }
      },
      requests: {
        orderBy: { createdAt: "asc" }
      }
    }
  });
}

async function getOrCreateConversation(context, conversationId, input = {}) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  if (input.forceNew) {
    const created = await createDefaultConversation(prisma, tenant, input);
    return conversationToState(tenant, created);
  }
  const row = await findConversationRow(prisma, tenant, conversationId);
  if (row) return conversationToState(tenant, row);
  const created = await createDefaultConversation(prisma, tenant, input);
  return conversationToState(tenant, created);
}

async function listConversations(context, limit = 20) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  let rows = await prisma.conversation.findMany({
    where: {
      orgId: tenant.orgId,
      userId: tenant.userId
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: 120
      },
      requests: {
        orderBy: { createdAt: "desc" },
        take: 120
      }
    }
  });

  return rows.map((row) => conversationToState(tenant, row));
}

async function appendChatTurn(context, input) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const providedConversation =
    input.conversation && input.conversation.id === input.conversationId ? input.conversation : null;
  const conversation = providedConversation || (await findConversationRow(prisma, tenant, input.conversationId));
  if (!conversation) {
    throw new Error("Conversation not found");
  }

  const privacyLevel = normalizePrivacyLevel(input.privacyLevel);
  const shouldStoreContent = input.storeMessageContent !== false;
  const startedAt = new Date();

  const userMessageId = crypto.randomUUID();
  const messageRows = [
    {
      id: userMessageId,
      conversationId: conversation.id,
      role: "user",
      tokenCount: input.userTokenCount || 0,
      createdAt: startedAt,
      ...encryptedContentFields(
        tenant,
        conversation.id,
        {
          id: userMessageId,
          role: "user",
          modelId: null
        },
        input.userContent,
        shouldStoreContent
      )
    }
  ];
  const requestRows = [];
  const usageRows = [];
  const providerStatusByMessageId = new Map();

  for (const [index, message] of (input.assistantMessages || []).entries()) {
    const requestId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const createdAt = new Date(startedAt.getTime() + index + 1);
    const inputTokens = Number(message.inputTokens || 0);
    const outputTokens = Number(message.outputTokens || 0);
    const totalTokens = inputTokens + outputTokens;
    const costUsd = Number(message.costUsd || 0);

    requestRows.push({
      id: requestId,
      orgId: tenant.orgId,
      conversationId: conversation.id,
      provider: message.provider,
      modelId: message.modelId,
      privacyLevel,
      statusCode: message.providerStatus === "live" || message.providerStatus === "simulated" ? 200 : null,
      errorCode:
        message.providerStatus === "blocked"
          ? "policy_blocked"
          : message.providerStatus === "error"
            ? "provider_error"
            : message.providerStatus === "simulated"
              ? "simulated"
              : null,
      inputTokens,
      outputTokens,
      costUsd
    });
    providerStatusByMessageId.set(assistantMessageId, message.providerStatus);

    usageRows.push({
      orgId: tenant.orgId,
      requestId,
      date: new Date(`${message.date || toDateOnly(startedAt)}T00:00:00.000Z`),
      provider: message.provider,
      modelId: message.modelId,
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd
    });

    messageRows.push({
      id: assistantMessageId,
      conversationId: conversation.id,
      role: "assistant",
      modelId: message.modelId,
      provider: message.provider,
      tokenCount: outputTokens,
      createdAt,
      ...encryptedContentFields(
        tenant,
        conversation.id,
        {
          id: assistantMessageId,
          role: "assistant",
          modelId: message.modelId
        },
        message.content,
        shouldStoreContent
      )
    });
  }

  const operations = [
    prisma.message.createMany({ data: messageRows })
  ];
  if (requestRows.length) operations.push(prisma.modelRequest.createMany({ data: requestRows }));
  if (usageRows.length) operations.push(prisma.usageRecord.createMany({ data: usageRows }));
  operations.push(
    prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        title: input.title || conversation.title,
        privacyLevel
      }
    })
  );

  const results = await prisma.$transaction(operations);
  const updatedConversation = results[results.length - 1];
  const nextConversation = conversationToState(tenant, {
    ...updatedConversation,
    messages: []
  });
  nextConversation.messages = messageRows.map((row) =>
    messageToState(tenant, row, {
      providerStatus: providerStatusByMessageId.get(row.id)
    })
  );
  return nextConversation;
}

async function clearConversation(context, conversationId) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const conversation = await findConversationRow(prisma, tenant, conversationId);
  if (!conversation) return null;

  await prisma.message.deleteMany({
    where: {
      conversationId: conversation.id
    }
  });

  const row = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
    include: {
      messages: {
        orderBy: { createdAt: "asc" }
      }
    }
  });
  return conversationToState(tenant, row);
}

async function listUsageRecords(context, limit = 500) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const rows = await prisma.usageRecord.findMany({
    where: {
      orgId: tenant.orgId
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: {
      request: {
        select: {
          conversationId: true
        }
      }
    }
  });
  return rows.map(usageToState);
}

async function getSettings(context, fallback = {}) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const row = await prisma.organizationSettings.findUnique({
    where: { orgId: tenant.orgId }
  });
  return settingsToState(row, fallback);
}

async function saveSettings(context, input, fallback = {}) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const next = settingsToState({ settings: input }, fallback);
  const row = await prisma.organizationSettings.upsert({
    where: { orgId: tenant.orgId },
    update: { settings: next },
    create: {
      orgId: tenant.orgId,
      settings: next
    }
  });
  return settingsToState(row, fallback);
}

async function listPrompts(context, officialPrompts = []) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const rows = await prisma.promptTemplate.findMany({
    where: {
      OR: [
        { orgId: tenant.orgId },
        { orgId: null, official: true, shared: true }
      ]
    },
    orderBy: [
      { updatedAt: "desc" },
      { createdAt: "desc" }
    ]
  });
  return mergePrompts(officialPrompts, rows);
}

async function createPrompt(context, input) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const row = await prisma.promptTemplate.create({
    data: {
      orgId: tenant.orgId,
      createdById: tenant.userId,
      title: input.title,
      category: input.category || "自定义",
      body: input.body,
      official: false,
      favorite: Boolean(input.favorite),
      shared: Boolean(input.shared)
    }
  });
  return promptToState(row);
}

async function updatePrompt(context, promptId, input, officialPrompts = []) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const official = officialPrompts.find((prompt) => prompt.id === promptId);

  if (official) {
    const row = await prisma.promptTemplate.upsert({
      where: {
        orgId_sourceId: {
          orgId: tenant.orgId,
          sourceId: official.id
        }
      },
      update: {
        title: input.title ?? official.title,
        category: input.category ?? official.category,
        body: input.body ?? official.body,
        favorite: input.favorite == null ? undefined : Boolean(input.favorite),
        shared: input.shared == null ? undefined : Boolean(input.shared)
      },
      create: {
        orgId: tenant.orgId,
        createdById: tenant.userId,
        sourceId: official.id,
        title: input.title ?? official.title,
        category: input.category ?? official.category,
        body: input.body ?? official.body,
        official: true,
        favorite: input.favorite == null ? Boolean(official.favorite) : Boolean(input.favorite),
        shared: Boolean(input.shared)
      }
    });
    return { ...promptToState(row), id: official.id, official: true };
  }

  const updated = await prisma.promptTemplate.updateMany({
    where: {
      id: promptId,
      orgId: tenant.orgId
    },
    data: {
      title: input.title,
      category: input.category,
      body: input.body,
      favorite: input.favorite == null ? undefined : Boolean(input.favorite),
      shared: input.shared == null ? undefined : Boolean(input.shared)
    }
  });
  if (!updated.count) return null;
  const row = await prisma.promptTemplate.findFirst({
    where: {
      id: promptId,
      orgId: tenant.orgId
    }
  });
  return row ? promptToState(row) : null;
}

async function importPrompts(context, prompts = []) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const rows = [];

  for (const prompt of prompts.filter((item) => item?.title && item?.body)) {
    const row = await prisma.promptTemplate.create({
      data: {
        orgId: tenant.orgId,
        createdById: tenant.userId,
        title: prompt.title,
        category: prompt.category || "导入",
        body: prompt.body,
        official: false,
        favorite: Boolean(prompt.favorite),
        shared: Boolean(prompt.shared)
      }
    });
    rows.push(row);
  }

  return rows.map(promptToState);
}

async function listAuditLogs(context, limit = 80) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const rows = await prisma.auditLog.findMany({
    where: { orgId: tenant.orgId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      actor: {
        select: { email: true }
      }
    }
  });
  return rows.map(auditToState);
}

async function writeAudit(context, input) {
  const tenant = await ensureTenant(context);
  const prisma = getPrismaClient();
  const row = await prisma.auditLog.create({
    data: {
      orgId: tenant.orgId,
      actorId: tenant.userId,
      action: input.action,
      target: input.target || null,
      metadata: {
        ...(input.metadata || {}),
        actor: tenant.email,
        detail: input.detail || input.metadata?.detail || input.target || ""
      }
    },
    include: {
      actor: {
        select: { email: true }
      }
    }
  });
  return auditToState(row);
}

async function checkDatabaseHealth() {
  const prisma = getPrismaClient();
  await prisma.$queryRaw`select 1`;
  return {
    ok: true
  };
}

module.exports = {
  checkDatabaseHealth,
  ensureTenant,
  listCredentials,
  getCredentialSecretForProvider,
  getCredentialSecretById,
  createCredential,
  updateCredentialHealth,
  revokeCredential,
  getOrCreateConversation,
  listConversations,
  appendChatTurn,
  clearConversation,
  listUsageRecords,
  getSettings,
  saveSettings,
  listPrompts,
  createPrompt,
  updatePrompt,
  importPrompts,
  listAuditLogs,
  writeAudit
};
