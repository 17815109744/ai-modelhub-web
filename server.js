const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadEnv } = require("./src/config/loadEnv");

loadEnv();

const { getConfig } = require("./src/config");
const {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
  previewSecret,
  redactSensitive
} = require("./src/security/encryption");
const { classifyPrivacy, redactText } = require("./src/security/privacy");
const { resolveRequestContext } = require("./src/middleware/requestContext");
const { checkRateLimit } = require("./src/storage/rateLimit");
const { getStore } = require("./src/storage");
const { callProvider } = require("./src/providers/router");

const config = getConfig();
const store = getStore();
const PORT = config.port;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const MODELS = [
  {
    id: "gpt-4.1",
    provider: "OpenAI",
    name: "GPT-4.1",
    latencyMs: 820,
    inputPerMillion: 2.0,
    outputPerMillion: 8.0,
    style: "结构清晰、工程落地"
  },
  {
    id: "claude-sonnet",
    provider: "Claude",
    name: "Claude Sonnet",
    latencyMs: 940,
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    style: "推理细腻、长文稳健"
  },
  {
    id: "gemini-2.5-flash",
    provider: "Gemini",
    name: "Gemini 2.5 Flash",
    latencyMs: 760,
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    style: "检索友好、多模态优先"
  },
  {
    id: "deepseek-chat",
    provider: "DeepSeek",
    name: "DeepSeek Chat",
    latencyMs: 680,
    inputPerMillion: 0.27,
    outputPerMillion: 1.1,
    style: "性价比高、中文自然"
  },
  {
    id: process.env.OLLAMA_MODEL || "qwen2.5:3b",
    provider: "Local",
    name: "Qwen2.5 3B",
    latencyMs: 420,
    inputPerMillion: 0,
    outputPerMillion: 0,
    style: "本地免费，数据不出电脑"
  }
];

const OFFICIAL_PROMPTS = [
  {
    id: "prompt_product_architect",
    title: "产品架构专家",
    category: "研发",
    official: true,
    favorite: false,
    body: "你是一名资深 AI 产品架构师。请先拆解目标、约束、用户角色与核心路径，再输出信息架构、API 边界、数据模型和风险清单。"
  },
  {
    id: "prompt_research_analyst",
    title: "投研摘要专家",
    category: "数据",
    official: true,
    favorite: false,
    body: "你是一名审慎的投资研究分析师。请从事实、推断、风险、待验证信息四类组织答案，并明确置信度。"
  },
  {
    id: "prompt_legal_checker",
    title: "合同风险审阅",
    category: "法务",
    official: true,
    favorite: false,
    body: "你是一名企业合同审阅顾问。请识别付款、责任、终止、保密、知识产权和争议解决条款中的风险，并给出修改建议。"
  },
  {
    id: "prompt_growth_writer",
    title: "增长文案编辑",
    category: "运营",
    official: true,
    favorite: false,
    body: "你是一名 B2B 增长文案编辑。请把输入内容改写为清晰、有证据、有行动号召的版本，避免夸张承诺。"
  },
  {
    id: "prompt_code_reviewer",
    title: "代码审查助手",
    category: "研发",
    official: true,
    favorite: false,
    body: "你是一名严谨的高级工程师。请优先指出 bug、回归风险、安全问题和缺失测试，并用文件位置和复现路径说明。"
  }
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const runningJobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

function todayOffset(daysAgo) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function stableNumber(seed, min, max) {
  const digest = crypto.createHash("sha256").update(seed).digest();
  const value = digest.readUInt32BE(0) / 0xffffffff;
  return min + value * (max - min);
}

function estimateTokens(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return 0;
  const cjk = (normalized.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (normalized.replace(/[\u4e00-\u9fff]/g, " ").match(/[A-Za-z0-9_]+/g) || []).length;
  return Math.max(1, Math.ceil(cjk * 0.72 + words * 1.25));
}

function calculateCost(model, inputTokens, outputTokens) {
  const input = (inputTokens / 1_000_000) * model.inputPerMillion;
  const output = (outputTokens / 1_000_000) * model.outputPerMillion;
  return Number((input + output).toFixed(6));
}

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    writeDb(seedDb());
  }
}

function seedDb() {
  const usage = [];
  for (let day = 6; day >= 0; day -= 1) {
    for (const model of MODELS.slice(0, 4)) {
      const inputTokens = Math.round(stableNumber(`${model.id}:${day}:in`, 1200, 9800));
      const outputTokens = Math.round(stableNumber(`${model.id}:${day}:out`, 800, 7400));
      usage.push({
        id: id("usage"),
        date: todayOffset(day),
        modelId: model.id,
        modelName: model.name,
        provider: model.provider,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd: calculateCost(model, inputTokens, outputTokens),
        source: "seed"
      });
    }
  }

  return {
    version: 1,
    createdAt: nowIso(),
    settings: {
      fxRate: 7.25,
      budgetUsd: 300,
      safetyEnabled: true,
      safetyWords: ["隐私", "密码", "内部财报"]
    },
    keys: [],
    conversations: [
      {
        id: "conv_default",
        title: "企业知识库方案",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        messages: []
      }
    ],
    usage,
    prompts: OFFICIAL_PROMPTS,
    knowledgeBases: [
      {
        id: "kb_default",
        name: "默认知识库",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        documents: []
      }
    ],
    jobs: [],
    auditLogs: [
      {
        id: id("audit"),
        action: "系统初始化",
        actor: "admin@example.com",
        detail: "创建本地演示工作台",
        createdAt: nowIso()
      }
    ]
  };
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

function addAudit(db, action, detail, actor = "admin@example.com") {
  db.auditLogs.unshift({
    id: id("audit"),
    action,
    actor,
    detail,
    createdAt: nowIso()
  });
  db.auditLogs = db.auditLogs.slice(0, 80);
}

function encryptApiKey(apiKey, context) {
  return encryptSecret(apiKey, context);
}

function previewKey(apiKey) {
  return previewSecret(apiKey);
}

function sanitizeKey(record) {
  return {
    id: record.id,
    orgId: record.orgId || "local-org",
    provider: record.provider,
    name: record.name,
    preview: record.preview,
    fingerprint: record.fingerprint,
    keyVersion: record.keyVersion || record.encryptedKey?.keyVersion,
    encrypted: Boolean(record.encryptedKey),
    health: record.health,
    balanceUsd: record.balanceUsd,
    lastCheckedAt: record.lastCheckedAt,
    createdAt: record.createdAt
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

function credentialEnvelope(record) {
  if (record.encryptedSecret && record.iv && record.authTag) {
    return {
      algorithm: "AES-256-GCM",
      ciphertext: record.encryptedSecret,
      iv: record.iv,
      authTag: record.authTag,
      aadHash: record.aadHash
    };
  }
  return record.encryptedKey || null;
}

function decryptLocalCredential(record, context) {
  const envelope = credentialEnvelope(record);
  if (!envelope?.ciphertext || !envelope?.iv || !envelope?.authTag) return "";
  return decryptSecret(envelope, {
    orgId: record.orgId || context.orgId,
    userId: record.createdById || context.userId,
    provider: record.provider,
    credentialId: record.id
  });
}

async function resolveProviderApiKey(model, context, db, cache = new Map()) {
  const family = providerFamily(model?.provider);
  if (!family || family === "local") return "";
  if (cache.has(family)) return cache.get(family);

  let apiKey = "";
  if (store.backend === "prisma") {
    if (hasDatabaseIdentity(context) && typeof store.getCredentialSecretForProvider === "function") {
      try {
        apiKey = await store.getCredentialSecretForProvider(context, model.provider);
      } catch (error) {
        console.warn(`Failed to load saved ${model.provider} API key`, redactSensitive(error.message || error));
      }
    }
  } else {
    const credential = (db?.keys || []).find((key) => providerMatchesCredential(key.provider, model.provider));
    if (credential) {
      try {
        apiKey = decryptLocalCredential(credential, context);
      } catch (error) {
        console.warn(`Failed to decrypt saved ${model.provider} API key`, redactSensitive(error.message || error));
      }
    }
  }

  cache.set(family, apiKey);
  return apiKey;
}

function sanitizeState(db) {
  return {
    models: MODELS,
    backend: {
      dataBackend: config.dataBackend,
      privacyDefaultMode: config.privacyDefaultMode,
      storeMessageContent: config.storeMessageContent,
      r2Configured: Boolean(config.r2.bucket && config.r2.accountId),
      redisConfigured: Boolean(config.upstash.url && config.upstash.token)
    },
    settings: db.settings,
    keys: db.keys.map(sanitizeKey),
    conversations: db.conversations,
    usage: db.usage,
    prompts: db.prompts,
    knowledgeBases: db.knowledgeBases,
    jobs: db.jobs,
    auditLogs: db.auditLogs
  };
}

function modelNameFor(modelId) {
  return MODELS.find((model) => model.id === modelId)?.name || modelId || "";
}

function localOllamaModel() {
  return MODELS.find((model) => isLocalProvider(model)) || MODELS[MODELS.length - 1];
}

function isLocalModelRequest(modelId) {
  const value = String(modelId || "").toLowerCase();
  return Boolean(
    value &&
      (value.includes("ollama") ||
        value.includes("llama") ||
        value.startsWith("qwen") ||
        value.startsWith("mistral") ||
        value.startsWith("gemma") ||
        value.startsWith("phi") ||
        value.includes(":"))
  );
}

function resolveSelectedModels(modelIds) {
  const requestedIds = Array.isArray(modelIds) && modelIds.length ? modelIds : ["gpt-4.1"];
  const selected = [];

  requestedIds.forEach((modelId) => {
    const model = MODELS.find((item) => item.id === modelId)
      || (isLocalModelRequest(modelId) ? localOllamaModel() : null);
    if (model && !selected.some((item) => item.id === model.id)) selected.push(model);
  });

  if (!selected.length) selected.push(MODELS[0]);
  return selected;
}

const PROVIDER_SYSTEM_PROMPT = [
  "你是这个产品里的 AI 助手。",
  "默认使用简体中文回答，除非用户明确要求其他语言。",
  "最后一条用户消息永远优先于历史上下文。",
  "历史上下文只在用户明确要求继续、引用上文、基于前文处理时使用。",
  "不要把无关的旧测试、旧编号、旧选项、旧错误解释带入当前回答。",
  "除非用户明确询问你是什么模型、模型名称或服务商，否则不要主动介绍自己的模型身份。",
  "遇到数学、常识、技术、写作等普通问题时，直接回答问题本身。",
  "如果用户只是问候、测试 API 或发送很短的试探消息，请直接、简短、友好地回应当前消息。",
  "不要向用户解释你看到了系统提示，也不要编造不存在的菜单或选项。"
].join("\n");

const POLLUTED_ASSISTANT_PATTERNS = [
  /select an option 1/i,
  /imagined menu/i,
  /please forget about the "1"/i,
  /the "\?\?\?\?"/i,
  /you're still very confused/i,
  /try to reset completely/i,
  /common reasons people might just type "1"/i,
  /我会用\s*[^。\n]+的方式处理：先锁定目标，再把方案拆成可执行模块/i,
  /建议分成数据接入、模型路由、权限审计、成本监控四层推进/i,
  /Provider call failed; using local fallback/i,
  /Apologies for that previous error/i,
  /technical issue and couldn't process your request/i,
  /question marks were just garbled output/i,
  /[?？]{8,}/,
  /you've typed "1" again/i,
  /what you'd like me to do with just the number "1"/i,
  /I'm still not sure what you'd like me to do/i,
  /我是一个大型语言模型.*Google/i,
  /我的名字是 Gemini/i,
  /i am a large language model.*google/i
];

function isPollutedAssistantMessage(message) {
  const content = String(message?.content || "");
  return (
    message?.role === "assistant" &&
    (String(message.providerStatus || "").toLowerCase() === "simulated" ||
      POLLUTED_ASSISTANT_PATTERNS.some((pattern) => pattern.test(content)))
  );
}

function isKnownOffTopicAssistantMessage(previousUserMessage, assistantMessage) {
  if (assistantMessage?.role !== "assistant" || previousUserMessage?.role !== "user") return false;
  const question = String(previousUserMessage.content || "");
  const answer = String(assistantMessage.content || "");
  if (/马斯克|musk/i.test(question) && !/马斯克|埃隆|musk|tesla|特斯拉|spacex|space\s*x|paypal|x\s*\(/i.test(answer)) {
    return true;
  }
  if (/蒋介石|蔣介石|chiang/i.test(question) && !/蒋介石|蔣介石|介石|chiang|国民党|中华民国/i.test(answer)) {
    return true;
  }
  if (/我是谁|who\s+am\s+i/i.test(question) && /API|接口|智能家居|智能办公/i.test(answer)) {
    return true;
  }
  if (!/api|接口|安全|application programming interface/i.test(question) && /^API\s*安全是保护应用程序编程接口/.test(answer)) {
    return true;
  }
  return false;
}

function normalizeKnownProviderErrorMessage(message) {
  if (message?.role !== "assistant") return message;
  const content = String(message.content || "");
  if (!/当前模型 ID 不可用/.test(content)) return message;

  const detail = content.match(/错误详情：([\s\S]*)/)?.[1]?.trim() || content;
  if (isProviderQuotaError(content)) {
    return {
      ...message,
      content: `API 额度不足或触发限流，请稍后再试，或更换可用密钥。\n\n错误详情：${detail}`
    };
  }
  if (isProviderBusyError(content)) {
    return {
      ...message,
      content: `服务商当前繁忙或模型负载过高，这不是模型 ID 写错。请稍后重试，或临时切换到本地 Qwen2.5。\n\n错误详情：${detail}`
    };
  }
  return message;
}

function sanitizeConversationForUi(conversation) {
  if (!conversation?.messages?.length) return conversation;
  const messages = [];
  for (const message of conversation.messages) {
    const normalizedMessage = normalizeKnownProviderErrorMessage(message);
    const previousMessage = messages[messages.length - 1];
    if (isPollutedAssistantMessage(normalizedMessage)) continue;
    if (isKnownOffTopicAssistantMessage(previousMessage, normalizedMessage)) continue;
    messages.push(normalizedMessage);
  }
  return {
    ...conversation,
    messages
  };
}

function shouldStartFreshForProvider(question) {
  const compact = String(question || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!compact) return true;
  return [
    "你好",
    "您好",
    "hi",
    "hello",
    "hey",
    "测试",
    "test",
    "在吗",
    "api测试",
    "测试api"
  ].includes(compact);
}

function shouldUseProviderHistory(question) {
  if (shouldStartFreshForProvider(question)) return false;
  return /继续|接着|刚才|上面|前面|上一|上文|前文|历史|基于|按照刚|根据上|总结一下|详细一点|展开说|continue|previous|above|context|earlier/i.test(
    String(question || "")
  );
}

function buildProviderMessages(conversation, model, providerInput, originalQuestion) {
  const messages = [{ role: "system", content: PROVIDER_SYSTEM_PROMPT }];
  if (shouldUseProviderHistory(originalQuestion)) {
    const priorMessages = (conversation.messages || [])
      .filter((message) => !isPollutedAssistantMessage(message))
      .filter((message) => {
        if (message.role === "user") return true;
        if (message.role !== "assistant") return false;
        return !message.modelId || message.modelId === model.id;
      })
      .slice(-6)
      .map((message) => ({ role: message.role, content: message.content || "" }))
      .filter((message) => String(message.content || "").trim());
    messages.push(...priorMessages);
  }
  messages.push({ role: "user", content: providerInput });
  return messages;
}

function decorateConversationModels(conversation) {
  const cleanConversation = sanitizeConversationForUi(conversation);
  return {
    ...cleanConversation,
    messages: (cleanConversation.messages || []).map((message) => ({
      ...message,
      modelName: !message.modelName || message.modelName === message.modelId ? modelNameFor(message.modelId) : message.modelName
    }))
  };
}

function decorateUsageModels(row) {
  return {
    ...row,
    modelName: row.modelName && row.modelName !== row.modelId ? row.modelName : modelNameFor(row.modelId)
  };
}

function hasDatabaseIdentity(context) {
  return Boolean(
    context?.isAuthenticated &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(context.userId || ""))
  );
}

async function buildState(context, db = readDb()) {
  const state = sanitizeState(db);
  if (store.backend !== "prisma") return state;

  state.keys = [];
  state.auditLogs = [];
  state.conversations = [];
  state.usage = [];
  state.backend.privateDataBackend = "prisma";
  state.backend.privateDataAuthenticated = hasDatabaseIdentity(context);

  if (!hasDatabaseIdentity(context)) return state;

  await store.ensureTenant(context);
  const keys = await store.listCredentials(context);
  const auditLogs = await store.listAuditLogs(context);
  const conversations = await store.listConversations(context);
  const usage = await store.listUsageRecords(context);
  const settings = await store.getSettings(context, state.settings);
  const prompts = await store.listPrompts(context, state.prompts);
  state.keys = keys;
  state.auditLogs = auditLogs;
  state.conversations = conversations.map(decorateConversationModels);
  state.usage = usage.map(decorateUsageModels);
  state.settings = settings;
  state.prompts = prompts;
  return state;
}

function healthForKey(key) {
  const lowered = `${key.name} ${key.provider}`.toLowerCase();
  const score = stableNumber(`${key.id}:${key.provider}`, 0, 100);
  let status = "ok";
  let label = "健康";
  let detail = "密钥可用，余额正常";

  if (lowered.includes("expired") || lowered.includes("过期") || score < 10) {
    status = "bad";
    label = "异常";
    detail = "检测到过期或鉴权失败";
  } else if (score < 28) {
    status = "warn";
    label = "预警";
    detail = "余额偏低或接口响应较慢";
  }

  return {
    status,
    label,
    detail,
    latencyMs: Math.round(stableNumber(`${key.id}:latency`, 120, 1600)),
    checkedAt: nowIso()
  };
}

function checkKey(db, key) {
  const health = healthForKey(key);
  key.health = health;
  key.balanceUsd = Number(stableNumber(`${key.id}:balance`, health.status === "bad" ? 0 : 12, health.status === "warn" ? 38 : 680).toFixed(2));
  key.lastCheckedAt = health.checkedAt;
  addAudit(db, "密钥健康检测", `${key.provider} / ${key.name}: ${health.label}`);
  return sanitizeKey(key);
}

function modelForCredentialProvider(provider) {
  return MODELS.find((model) => providerMatchesCredential(model.provider, provider)) || null;
}

function isProviderAuthError(detail) {
  return /api key not valid|invalid api key|unauthorized|permission_denied|401|403/i.test(detail);
}

function isProviderQuotaError(detail) {
  return /quota|billing|insufficient|exceeded|429|rate limit|resource exhausted|too many requests|free_tier_requests/i.test(detail);
}

function isProviderBusyError(detail) {
  return /high demand|overloaded|temporarily unavailable|try again later|service unavailable|server busy|capacity|\b503\b/i.test(detail);
}

function isProviderModelError(detail) {
  return /model[s/]?.*(not found|not supported|does not exist|invalid|unknown)|not found.*model|not supported.*model/i.test(detail);
}

function isProviderNetworkError(detail) {
  return /fetch failed|timed out|timeout|network|econnreset|socket hang up|connection.*closed|基础连接已经关闭|发送时发生错误/i.test(detail);
}

function healthFromProviderError(error, latencyMs) {
  const checkedAt = nowIso();
  const detail = redactSensitive(error?.message || "Unknown provider error");
  if (isProviderAuthError(detail)) {
    return {
      status: "bad",
      label: "密钥无效",
      detail: `真实检测失败：API Key 无效或权限不足。${detail}`,
      latencyMs,
      checkedAt
    };
  }
  if (isProviderQuotaError(detail)) {
    return {
      status: "warn",
      label: "额度异常",
      detail: `真实检测失败：额度不足或触发限流。${detail}`,
      latencyMs,
      checkedAt
    };
  }
  if (isProviderBusyError(detail)) {
    return {
      status: "warn",
      label: "服务繁忙",
      detail: `真实检测失败：服务商当前繁忙或模型负载过高，请稍后重试。${detail}`,
      latencyMs,
      checkedAt
    };
  }
  if (isProviderModelError(detail)) {
    return {
      status: "warn",
      label: "模型不可用",
      detail: `真实检测失败：当前模型不可用或服务商不支持。${detail}`,
      latencyMs,
      checkedAt
    };
  }
  return {
    status: "bad",
    label: "连接失败",
    detail: `真实检测失败：${detail}`,
    latencyMs,
    checkedAt
  };
}

async function checkProviderCredential(key, apiKey) {
  const startedAt = Date.now();
  const checkedAt = nowIso();
  if (!apiKey) {
    return {
      status: "bad",
      label: "未读取",
      detail: "无法读取这条密钥，请重新添加。",
      latencyMs: 0,
      checkedAt
    };
  }

  const model = modelForCredentialProvider(key.provider);
  if (!model || providerFamily(key.provider) === "deepseek") {
    return {
      status: "warn",
      label: "未接入",
      detail: `${key.provider} 已保存，但当前项目还没有接入这个服务商的真实调用器。`,
      latencyMs: 0,
      checkedAt
    };
  }

  try {
    const result = await callProvider({
      model,
      privacyLevel: "public",
      apiKey,
      input: "请只回复 OK。",
      messages: [
        { role: "system", content: "你是 API 连通性检测程序。只回复 OK。" },
        { role: "user", content: "请只回复 OK。" }
      ]
    });
    const latencyMs = Date.now() - startedAt;
    if (result.blocked) {
      return {
        status: "bad",
        label: "策略拦截",
        detail: result.text || "隐私策略阻止了这次检测。",
        latencyMs,
        checkedAt: nowIso()
      };
    }
    if (result.skipped) {
      return {
        status: result.missingKey ? "bad" : "warn",
        label: result.missingKey ? "未配置" : "未接入",
        detail: result.text || "服务商调用器未返回检测结果。",
        latencyMs,
        checkedAt: nowIso()
      };
    }
    if (!String(result.text || "").trim()) {
      return {
        status: "warn",
        label: "空响应",
        detail: "服务商已响应，但没有返回文本。聊天时可能触发安全拦截或模型空输出。",
        latencyMs,
        checkedAt: nowIso()
      };
    }
    return {
      status: "ok",
      label: "可用",
      detail: `真实检测通过，${model.name} 已返回响应。`,
      latencyMs,
      checkedAt: nowIso()
    };
  } catch (error) {
    return healthFromProviderError(error, Date.now() - startedAt);
  }
}

async function checkLocalKey(db, key, context) {
  const apiKey = decryptLocalCredential(key, context);
  const health = await checkProviderCredential(key, apiKey);
  key.health = health;
  key.balanceUsd = null;
  key.lastCheckedAt = health.checkedAt;
  addAudit(db, "密钥健康检测", `${key.provider} / ${key.name}: ${health.label}`);
  return sanitizeKey(key);
}

function isLocalProvider(model) {
  const provider = String(model?.provider || "").toLowerCase();
  return provider.includes("local") || provider.includes("ollama") || provider.includes("self-hosted");
}

function providerUserError(error) {
  const detail = redactSensitive(error?.message || "Unknown provider error");
  let hint = "模型调用失败，请检查 API Key 配置后重试。";
  if (isProviderAuthError(detail)) {
    hint = "API Key 无效或没有权限，请重新生成并保存密钥。";
  } else if (isProviderQuotaError(detail)) {
    hint = "API 额度不足或触发限流，请稍后再试，或更换可用密钥。";
  } else if (isProviderBusyError(detail)) {
    hint = "服务商当前繁忙或模型负载过高，这不是模型 ID 写错。请稍后重试，或临时切换到本地 Qwen2.5。";
  } else if (isProviderModelError(detail)) {
    hint = "当前模型 ID 不可用，请切换模型或检查服务商支持的模型名称。";
  } else if (isProviderNetworkError(detail)) {
    hint = "网络连接服务商超时，请检查代理/网络，或稍后重试。";
  }
  return `${hint}\n\n错误详情：${detail}`;
}

function providerFailureAnswer(model, error) {
  if (isLocalProvider(model)) {
    const modelId = model?.id || process.env.OLLAMA_MODEL || "qwen2.5:3b";
    return [
      "本地 Ollama 模型还没准备好。",
      "",
      "请先确认 Ollama 已安装并正在运行，然后在终端执行：",
      `ollama pull ${modelId}`,
      "",
      "完成后重新发送这条问题即可。"
    ].join("\n");
  }

  return providerUserError(error);
}

function summarizeUsage(usage) {
  return usage.reduce(
    (acc, row) => {
      acc.tokens += row.totalTokens;
      acc.costUsd += row.costUsd;
      return acc;
    },
    { tokens: 0, costUsd: 0 }
  );
}

function textToChunks(text, size = 650) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks = [];
  for (let index = 0; index < clean.length; index += size) {
    chunks.push(clean.slice(index, index + size));
  }
  return chunks;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[\u4e00-\u9fff]|[a-z0-9_]+/g) || [];
}

function scoreChunk(question, chunk) {
  const q = new Set(tokenize(question));
  if (!q.size) return 0;
  let score = 0;
  for (const token of tokenize(chunk.text)) {
    if (q.has(token)) score += token.length > 1 ? 2 : 1;
  }
  return score;
}

function createDocumentRecord(input) {
  const name = input.name || input.url || "未命名文档";
  const rawText = input.text || input.url || name;
  const chunks = textToChunks(rawText);
  const fallback = chunks.length ? chunks : [`${name} 已进入解析队列，生产环境可接入 PDF/Word parser 和向量数据库。`];

  return {
    id: id("doc"),
    name,
    type: input.type || "text/plain",
    size: Number(input.size || rawText.length || 0),
    sourceUrl: input.url || "",
    status: "ready",
    progress: 100,
    chunkCount: fallback.length,
    chunks: fallback.map((text, index) => ({
      id: id("chunk"),
      index,
      text,
      tokens: estimateTokens(text)
    })),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function parseCsv(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((line, index) => ({ id: index + 1, input: line.split(",").join(" | ") }));
}

function buildBatchRows(body) {
  if (Array.isArray(body.rows) && body.rows.length) {
    return body.rows.slice(0, 80).map((row, index) => ({
      id: index + 1,
      input: typeof row === "string" ? row : JSON.stringify(row)
    }));
  }
  if (body.fileText) return parseCsv(body.fileText);
  return [
    { id: 1, input: "客户反馈：部署速度快，但希望增加预算提醒。" },
    { id: 2, input: "销售线索：大型制造业客户关注私有化和审计日志。" },
    { id: 3, input: "支持工单：用户想把 CSV 批量翻译为英文。" }
  ];
}

function processRow(job, row) {
  const prefix = {
    "摘要": "摘要",
    "翻译": "Translation",
    "分类": "分类",
    "信息抽取": "抽取"
  }[job.type] || "结果";

  if (job.type === "分类") {
    const label = /预算|成本|价格/.test(row.input) ? "成本关注" : /审计|权限|私有/.test(row.input) ? "企业安全" : "通用需求";
    return `${prefix}: ${label}`;
  }
  if (job.type === "翻译") {
    return `${prefix}: ${row.input.slice(0, 80)} (translated draft)`;
  }
  if (job.type === "信息抽取") {
    return `${prefix}: 主题=${row.input.slice(0, 18)}; 动作=跟进; 优先级=中`;
  }
  return `${prefix}: ${row.input.slice(0, 46)}${row.input.length > 46 ? "..." : ""}`;
}

function startJob(jobId) {
  if (runningJobs.has(jobId)) return;
  const timer = setInterval(() => {
    const db = readDb();
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job || job.status === "completed" || job.status === "failed") {
      clearInterval(timer);
      runningJobs.delete(jobId);
      return;
    }

    const next = job.results.find((row) => row.status !== "completed");
    if (next) {
      next.status = "completed";
      next.result = processRow(job, next);
    }
    const completed = job.results.filter((row) => row.status === "completed").length;
    job.progress = Math.round((completed / job.results.length) * 100);
    job.status = completed === job.results.length ? "completed" : "running";
    job.updatedAt = nowIso();

    if (job.status === "completed") {
      addAudit(db, "批量任务完成", `${job.type} / ${job.modelName} / ${job.results.length} 行`);
      clearInterval(timer);
      runningJobs.delete(jobId);
    }
    writeDb(db);
  }, 700);
  runningJobs.set(jobId, timer);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("JSON 格式无效"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const publicFiles = new Set([
    "/index.html",
    "/auth.html",
    "/styles.css",
    "/app.js",
    "/auth.js",
    "/liquid-glass-modules.js"
  ]);
  const assetExt = path.extname(requested).toLowerCase();
  const allowedAsset =
    requested.startsWith("/assets/") &&
    [".png", ".jpg", ".jpeg", ".svg", ".webp", ".ico"].includes(assetExt);

  if (!publicFiles.has(requested) && !allowedAsset) {
    sendError(res, 404, "文件不存在");
    return;
  }

  const filePath = path.normalize(path.join(ROOT, requested));
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : `${ROOT}${path.sep}`;

  if (filePath !== ROOT && !filePath.startsWith(rootPrefix)) {
    sendError(res, 403, "禁止访问");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendError(res, 404, "文件不存在");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method || "GET";
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (method === "GET" && (url.pathname === "/api/health" || url.pathname === "/api/status")) {
      return sendJson(res, 200, {
        status: "running",
        service: "modelhub-backend",
        dataBackend: config.dataBackend,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
      });
    }

    const requestContext = await resolveRequestContext(req);

    if (method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, 200, await buildState(requestContext));
    }

    if (method === "GET" && url.pathname === "/api/security/status") {
      return sendJson(res, 200, {
        dataBackend: config.dataBackend,
        privacyDefaultMode: config.privacyDefaultMode,
        storeMessageContent: config.storeMessageContent,
        credentialEncryption: {
          algorithm: "AES-256-GCM",
          keyVersion: config.credentialKeyVersion,
          masterKeyConfigured: Boolean(config.credentialMasterKey)
        },
        supabaseConfigured: Boolean(config.supabaseUrl && config.supabaseAnonKey),
        supabase: {
          configured: Boolean(config.supabaseUrl && config.supabaseAnonKey),
          url: config.supabaseUrl,
          anonKey: config.supabaseAnonKey,
          jwksUrl: config.authJwksUrl,
          issuer: config.authJwtIssuer,
          audience: config.authJwtAudience
        },
        r2Configured: Boolean(config.r2.bucket && config.r2.accountId),
        redisConfigured: Boolean(config.upstash.url && config.upstash.token)
      });
    }

    if (method === "POST" && url.pathname === "/api/keys") {
      const body = await readBody(req);
      if (!body.provider || !body.name || !body.apiKey) {
        return sendError(res, 400, "Provider, name, and API key are required");
      }
      if (store.backend === "prisma") {
        if (!hasDatabaseIdentity(requestContext)) {
          return sendError(res, 401, "Please sign in before saving API keys");
        }
        const tenant = await store.ensureTenant(requestContext);
        const credentialId = crypto.randomUUID();
        const encryptedKey = encryptApiKey(body.apiKey, {
          orgId: tenant.orgId,
          userId: tenant.userId,
          provider: body.provider,
          credentialId
        });
        const key = await store.createCredential(requestContext, {
          id: credentialId,
          provider: body.provider,
          name: body.name,
          preview: previewKey(body.apiKey),
          fingerprintHash: fingerprintSecret(body.apiKey),
          encryptedSecret: encryptedKey.ciphertext,
          iv: encryptedKey.iv,
          authTag: encryptedKey.authTag,
          aadHash: encryptedKey.aadHash,
          keyVersion: encryptedKey.keyVersion
        });
        await store.writeAudit(requestContext, {
          action: "新增密钥",
          target: key.id,
          detail: `${key.provider} / ${key.name}`
        });
        return sendJson(res, 201, { key, state: await buildState(requestContext) });
      }
      const db = readDb();
      const credentialId = id("key");
      const encryptedKey = encryptApiKey(body.apiKey, {
        orgId: requestContext.orgId,
        userId: requestContext.userId,
        provider: body.provider,
        credentialId
      });
      const record = {
        id: credentialId,
        orgId: requestContext.orgId,
        createdById: requestContext.userId,
        provider: body.provider,
        name: body.name,
        preview: previewKey(body.apiKey),
        fingerprint: fingerprintSecret(body.apiKey),
        encryptedKey,
        encryptedSecret: encryptedKey.ciphertext,
        iv: encryptedKey.iv,
        authTag: encryptedKey.authTag,
        aadHash: encryptedKey.aadHash,
        keyVersion: encryptedKey.keyVersion,
        health: { status: "unknown", label: "Not checked", detail: "Waiting for health check" },
        balanceUsd: null,
        lastCheckedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      db.keys.unshift(record);
      addAudit(db, "新增密钥", `${record.provider} / ${record.name}`);
      writeDb(db);
      return sendJson(res, 201, { key: sanitizeKey(record), state: await buildState(requestContext, db) });
    }

    if (method === "POST" && parts[0] === "api" && parts[1] === "keys" && parts[3] === "check") {
      if (store.backend === "prisma") {
        const keys = hasDatabaseIdentity(requestContext) ? await store.listCredentials(requestContext) : [];
        const key = keys.find((item) => item.id === parts[2]);
        if (!key) return sendError(res, 404, "API key not found");
        const secret = await store.getCredentialSecretById(requestContext, key.id);
        const health = await checkProviderCredential(key, secret?.apiKey || "");
        const checked = await store.updateCredentialHealth(requestContext, key.id, {
          health,
          balanceUsd: null,
          lastCheckedAt: health.checkedAt
        });
        await store.writeAudit(requestContext, {
          action: "密钥健康检测",
          target: key.id,
          detail: `${key.provider} / ${key.name}: ${health.label}`
        });
        return sendJson(res, 200, { key: checked, state: await buildState(requestContext) });
      }
      const db = readDb();
      const key = db.keys.find((item) => item.id === parts[2]);
      if (!key) return sendError(res, 404, "密钥不存在");
      const checked = await checkLocalKey(db, key, requestContext);
      writeDb(db);
      return sendJson(res, 200, { key: checked, state: await buildState(requestContext, db) });
    }

    if (method === "POST" && url.pathname === "/api/keys/check-all") {
      if (store.backend === "prisma") {
        const keys = hasDatabaseIdentity(requestContext) ? await store.listCredentials(requestContext) : [];
        const checked = [];
        for (const key of keys) {
          const secret = await store.getCredentialSecretById(requestContext, key.id);
          const health = await checkProviderCredential(key, secret?.apiKey || "");
          const updated = await store.updateCredentialHealth(requestContext, key.id, {
            health,
            balanceUsd: null,
            lastCheckedAt: health.checkedAt
          });
          if (updated) checked.push(updated);
          await store.writeAudit(requestContext, {
            action: "密钥健康检测",
            target: key.id,
            detail: `${key.provider} / ${key.name}: ${health.label}`
          });
        }
        return sendJson(res, 200, { keys: checked, state: await buildState(requestContext) });
      }
      const db = readDb();
      const checked = [];
      for (const key of db.keys) {
        checked.push(await checkLocalKey(db, key, requestContext));
      }
      writeDb(db);
      return sendJson(res, 200, { keys: checked, state: await buildState(requestContext, db) });
    }

    if (method === "DELETE" && parts[0] === "api" && parts[1] === "keys" && parts[2]) {
      if (store.backend === "prisma") {
        const key = hasDatabaseIdentity(requestContext) ? await store.revokeCredential(requestContext, parts[2]) : null;
        if (!key) return sendError(res, 404, "API key not found");
        await store.writeAudit(requestContext, {
          action: "删除密钥",
          target: key.id,
          detail: `${key.provider} / ${key.name}`
        });
        return sendJson(res, 200, { state: await buildState(requestContext) });
      }
      const db = readDb();
      const key = db.keys.find((item) => item.id === parts[2]);
      db.keys = db.keys.filter((item) => item.id !== parts[2]);
      if (key) addAudit(db, "删除密钥", `${key.provider} / ${key.name}`);
      writeDb(db);
      return sendJson(res, 200, { state: await buildState(requestContext, db) });
    }

    if (method === "POST" && url.pathname === "/api/privacy/classify") {
      const body = await readBody(req);
      const text = String(body.text || "");
      const privacyLevel = classifyPrivacy(text, requestContext.privacyMode);
      const redacted = redactText(text);
      return sendJson(res, 200, {
        privacyLevel,
        redactedText: redacted.text,
        redactionCount: redacted.replacements.length,
        entityTypes: redacted.replacements.map((item) => item.type)
      });
    }

    if (method === "POST" && url.pathname === "/api/chat") {
      const body = await readBody(req);
      const question = String(body.message || "").trim();
      if (!question) return sendError(res, 400, "消息不能为空");
      const rateLimit = await checkRateLimit({
        key: `${requestContext.orgId}:${requestContext.userId}:chat`,
        limit: 40,
        windowSeconds: 60
      });
      if (!rateLimit.allowed) {
        return sendError(res, 429, "Rate limit exceeded");
      }
      const privacyLevel = classifyPrivacy(question, requestContext.privacyMode);
      const redacted = redactText(question);

      if (store.backend === "prisma") {
        if (!hasDatabaseIdentity(requestContext)) {
          return sendError(res, 401, "请先登录后再使用聊天");
        }
        const conversation = await store.getOrCreateConversation(requestContext, body.conversationId, {
          privacyLevel,
          title: String(body.conversationTitle || "").trim() || "新会话",
          forceNew: Boolean(body.forceNewConversation)
        });
        const selectedModels = resolveSelectedModels(body.modelIds);
        const historySize = conversation.messages.filter((msg) => msg.role === "user").length;
        const providerInput = redacted.replacements.length ? redacted.text : question;

        const providerApiKeyCache = new Map();
        const assistantMessages = await Promise.all(selectedModels.map(async (model) => {
          let answer = "";
          let providerStatus = "error";
          try {
            const providerResult = await callProvider({
              model,
              privacyLevel,
              input: providerInput,
              apiKey: await resolveProviderApiKey(model, requestContext, undefined, providerApiKeyCache),
              messages: buildProviderMessages(conversation, model, providerInput, question)
            });
            if (providerResult.blocked) {
              answer = providerResult.text;
              providerStatus = "blocked";
            } else if (providerResult.skipped) {
              if (providerResult.text) answer = providerResult.text;
              if (!answer) answer = `${model.provider} 当前没有可用的真实调用器，请先完成服务商接入。`;
              providerStatus = "error";
            } else if (providerResult.text) {
              answer = providerResult.text;
              providerStatus = "live";
            } else {
              answer = "模型已响应，但没有返回可显示的文本。请换一种问法，或检查该模型是否触发了安全拦截。";
              providerStatus = "error";
            }
          } catch (error) {
            providerStatus = "error";
            answer = providerFailureAnswer(model, error);
          }
          const inputTokens = estimateTokens(question) + Math.max(0, historySize * 80);
          const outputTokens = estimateTokens(answer);
          return {
            role: "assistant",
            modelId: model.id,
            modelName: model.name,
            provider: model.provider,
            content: answer,
            privacyLevel,
            providerStatus,
            inputTokens,
            outputTokens,
            costUsd: calculateCost(model, inputTokens, outputTokens),
            date: todayOffset(0)
          };
        }));

        const savedConversation = decorateConversationModels(await store.appendChatTurn(requestContext, {
          conversationId: conversation.id,
          conversation,
          title: historySize === 0 ? question.slice(0, 22) || conversation.title : undefined,
          privacyLevel,
          userContent: config.storeMessageContent ? question : redacted.text,
          userTokenCount: estimateTokens(question),
          assistantMessages,
          storeMessageContent: config.storeMessageContent
        }));

        store.writeAudit(requestContext, {
          action: "chat.request",
          target: savedConversation.id,
          detail: `${selectedModels.map((m) => m.name).join(", ")} / ${estimateTokens(question)} input tokens / privacy=${privacyLevel}`
        }).catch((error) => {
          console.warn("Failed to write chat audit log", error);
        });

        return sendJson(res, 200, {
          conversation: savedConversation,
          messages: savedConversation.messages.slice(-(assistantMessages.length + 1))
        });
      }

      const db = readDb();
      let conversation = !body.forceNewConversation
        ? db.conversations.find((item) => item.id === (body.conversationId || "conv_default"))
        : null;
      if (!conversation) {
        conversation = {
          id: id("conv"),
          title: String(body.conversationTitle || "").trim() || "新会话",
          orgId: requestContext.orgId,
          userId: requestContext.userId,
          privacyLevel,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          messages: []
        };
        db.conversations.unshift(conversation);
      }
      const selectedModels = resolveSelectedModels(body.modelIds);
      const historySize = conversation.messages.filter((msg) => msg.role === "user").length;
      const userMessage = {
        id: id("msg"),
        role: "user",
        orgId: requestContext.orgId,
        userId: requestContext.userId,
        privacyLevel,
        content: config.storeMessageContent ? question : redacted.text,
        redactionCount: redacted.replacements.length,
        createdAt: nowIso()
      };
      const providerInput = redacted.replacements.length ? redacted.text : question;
      const providerApiKeyCache = new Map();
      const assistantMessages = await Promise.all(selectedModels.map(async (model) => {
        let answer = "";
        let providerStatus = "error";
        try {
          const providerResult = await callProvider({
            model,
            privacyLevel,
            input: providerInput,
            apiKey: await resolveProviderApiKey(model, requestContext, db, providerApiKeyCache),
            messages: buildProviderMessages(conversation, model, providerInput, question)
          });
          if (providerResult.blocked) {
            answer = providerResult.text;
            providerStatus = "blocked";
          } else if (providerResult.skipped) {
            if (providerResult.text) answer = providerResult.text;
            if (!answer) answer = `${model.provider} 当前没有可用的真实调用器，请先完成服务商接入。`;
            providerStatus = "error";
          } else if (providerResult.text) {
            answer = providerResult.text;
            providerStatus = "live";
          } else {
            answer = "模型已响应，但没有返回可显示的文本。请换一种问法，或检查该模型是否触发了安全拦截。";
            providerStatus = "error";
          }
        } catch (error) {
          providerStatus = "error";
          answer = providerFailureAnswer(model, error);
        }
        const inputTokens = estimateTokens(question) + Math.max(0, historySize * 80);
        const outputTokens = estimateTokens(answer);
        const usage = {
          id: id("usage"),
          date: todayOffset(0),
          modelId: model.id,
          modelName: model.name,
          provider: model.provider,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          costUsd: calculateCost(model, inputTokens, outputTokens),
          source: "chat",
          orgId: requestContext.orgId,
          privacyLevel,
          providerStatus,
          conversationId: conversation.id
        };
        db.usage.push(usage);
        return {
          id: id("msg"),
          role: "assistant",
          modelId: model.id,
          modelName: model.name,
          provider: model.provider,
          content: answer,
          privacyLevel,
          providerStatus,
          usageId: usage.id,
          createdAt: nowIso()
        };
      }));

      conversation.messages.push(userMessage, ...assistantMessages);
      conversation.updatedAt = nowIso();
      if (historySize === 0) conversation.title = question.slice(0, 22) || conversation.title;
      addAudit(
        db,
        "chat.request",
        `${selectedModels.map((m) => m.name).join(", ")} / ${estimateTokens(question)} input tokens / privacy=${privacyLevel}`,
        requestContext.email
      );
      writeDb(db);
      return sendJson(res, 200, {
        conversation: decorateConversationModels(conversation),
        messages: [userMessage, ...assistantMessages]
      });
    }

    if (method === "DELETE" && parts[0] === "api" && parts[1] === "conversations" && parts[2]) {
      if (store.backend === "prisma") {
        if (!hasDatabaseIdentity(requestContext)) {
          return sendError(res, 401, "请先登录后再清空会话");
        }
        const conversation = await store.clearConversation(requestContext, parts[2]);
        if (!conversation) return sendError(res, 404, "Conversation not found");
        await store.writeAudit(requestContext, {
          action: "清空会话",
          target: conversation.id,
          detail: conversation.title
        });
        return sendJson(res, 200, { state: await buildState(requestContext) });
      }
      const db = readDb();
      const conversation = db.conversations.find((item) => item.id === parts[2]);
      if (conversation) {
        conversation.messages = [];
        conversation.updatedAt = nowIso();
        addAudit(db, "清空会话", conversation.title);
      }
      writeDb(db);
      return sendJson(res, 200, { state: await buildState(requestContext, db) });
    }

    if (method === "PUT" && url.pathname === "/api/settings") {
      const body = await readBody(req);
      if (store.backend === "prisma") {
        if (!hasDatabaseIdentity(requestContext)) {
          return sendError(res, 401, "Please sign in before saving settings");
        }
        const fallback = sanitizeState(readDb()).settings;
        const settings = await store.saveSettings(requestContext, body, fallback);
        await store.writeAudit(requestContext, {
          action: "settings.update",
          target: "organization_settings",
          detail: "Budget, exchange rate or security policy updated"
        });
        return sendJson(res, 200, { settings, state: await buildState(requestContext) });
      }
      const db = readDb();
      db.settings = {
        ...db.settings,
        ...body,
        fxRate: Number(body.fxRate ?? db.settings.fxRate),
        budgetUsd: Number(body.budgetUsd ?? db.settings.budgetUsd)
      };
      addAudit(db, "更新平台设置", "预算、汇率或安全策略已更新");
      writeDb(db);
      return sendJson(res, 200, { settings: db.settings, state: await buildState(requestContext, db) });
    }

    if (method === "POST" && url.pathname === "/api/prompts") {
      const body = await readBody(req);
      if (store.backend === "prisma") {
        if (!hasDatabaseIdentity(requestContext)) {
          return sendError(res, 401, "Please sign in before creating prompts");
        }
        if (!body.title || !body.body) {
          return sendError(res, 400, "Prompt title and body are required");
        }
        const prompt = await store.createPrompt(requestContext, body);
        await store.writeAudit(requestContext, {
          action: "prompt.create",
          target: prompt.dbId || prompt.id,
          detail: prompt.title
        });
        return sendJson(res, 201, { prompt, state: await buildState(requestContext) });
      }
      if (!body.title || !body.body) return sendError(res, 400, "标题和提示词内容不能为空");
      const db = readDb();
      const prompt = {
        id: id("prompt"),
        title: body.title,
        category: body.category || "自定义",
        body: body.body,
        official: false,
        favorite: Boolean(body.favorite),
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      db.prompts.unshift(prompt);
      addAudit(db, "创建提示词", prompt.title);
      writeDb(db);
      return sendJson(res, 201, { prompt, state: await buildState(requestContext, db) });
    }

    if (method === "PATCH" && parts[0] === "api" && parts[1] === "prompts" && parts[2]) {
      const body = await readBody(req);
      const favoriteOnly = Object.keys(body).length === 1 && Object.prototype.hasOwnProperty.call(body, "favorite");
      if (store.backend === "prisma") {
        if (!hasDatabaseIdentity(requestContext)) {
          return sendError(res, 401, "Please sign in before updating prompts");
        }
        const prompt = await store.updatePrompt(requestContext, parts[2], body, OFFICIAL_PROMPTS);
        if (!prompt) return sendError(res, 404, "Prompt not found");
        if (favoriteOnly) return sendJson(res, 200, { prompt });
        await store.writeAudit(requestContext, {
          action: "prompt.update",
          target: prompt.dbId || prompt.id,
          detail: prompt.title
        });
        return sendJson(res, 200, { prompt, state: await buildState(requestContext) });
      }
      const db = readDb();
      const prompt = db.prompts.find((item) => item.id === parts[2]);
      if (!prompt) return sendError(res, 404, "提示词不存在");
      Object.assign(prompt, body, { updatedAt: nowIso() });
      if (!favoriteOnly) addAudit(db, "更新提示词", prompt.title);
      writeDb(db);
      if (favoriteOnly) return sendJson(res, 200, { prompt });
      return sendJson(res, 200, { prompt, state: await buildState(requestContext, db) });
    }

    if (method === "POST" && url.pathname === "/api/prompts/import") {
      const body = await readBody(req);
      const prompts = Array.isArray(body.prompts) ? body.prompts : [];
      if (store.backend === "prisma") {
        if (!hasDatabaseIdentity(requestContext)) {
          return sendError(res, 401, "Please sign in before importing prompts");
        }
        const imported = await store.importPrompts(requestContext, prompts);
        await store.writeAudit(requestContext, {
          action: "prompt.import",
          target: "prompt_templates",
          detail: `${imported.length} templates`
        });
        return sendJson(res, 200, { imported, state: await buildState(requestContext) });
      }
      const db = readDb();
      const imported = prompts
        .filter((prompt) => prompt.title && prompt.body)
        .map((prompt) => ({
          id: id("prompt"),
          title: prompt.title,
          category: prompt.category || "导入",
          body: prompt.body,
          official: false,
          favorite: Boolean(prompt.favorite),
          createdAt: nowIso(),
          updatedAt: nowIso()
        }));
      db.prompts.unshift(...imported);
      addAudit(db, "导入提示词", `${imported.length} 个模板`);
      writeDb(db);
      return sendJson(res, 200, { imported, state: await buildState(requestContext, db) });
    }

    if (method === "POST" && url.pathname === "/api/knowledge/documents") {
      const body = await readBody(req);
      const db = readDb();
      const kb = db.knowledgeBases.find((item) => item.id === (body.knowledgeBaseId || "kb_default")) || db.knowledgeBases[0];
      const doc = createDocumentRecord(body);
      kb.documents.unshift(doc);
      kb.updatedAt = nowIso();
      addAudit(db, "知识库入库", `${kb.name} / ${doc.name} / ${doc.chunkCount} chunks`);
      writeDb(db);
      return sendJson(res, 201, { document: doc, state: await buildState(requestContext, db) });
    }

    if (method === "POST" && url.pathname === "/api/knowledge/bases") {
      const body = await readBody(req);
      const db = readDb();
      const kb = {
        id: id("kb"),
        name: body.name || `知识库 ${db.knowledgeBases.length + 1}`,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        documents: []
      };
      db.knowledgeBases.unshift(kb);
      addAudit(db, "新建知识库", kb.name);
      writeDb(db);
      return sendJson(res, 201, { knowledgeBase: kb, state: await buildState(requestContext, db) });
    }

    if (method === "POST" && url.pathname === "/api/knowledge/ask") {
      const body = await readBody(req);
      const question = String(body.question || "").trim();
      if (!question) return sendError(res, 400, "问题不能为空");
      const db = readDb();
      const chunks = db.knowledgeBases.flatMap((kb) =>
        kb.documents.flatMap((doc) => doc.chunks.map((chunk) => ({ ...chunk, docName: doc.name, kbName: kb.name })))
      );
      const ranked = chunks
        .map((chunk) => ({ ...chunk, score: scoreChunk(question, chunk) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      const answer = ranked.length && ranked[0].score > 0
        ? `基于知识库命中的 ${ranked.length} 个片段：\n\n${ranked
            .map((chunk, index) => `${index + 1}. 来源：${chunk.docName} / ${chunk.kbName}\n${chunk.text.slice(0, 220)}`)
            .join("\n\n")}\n\n建议：把上述证据片段交给目标模型生成最终答复，并在 UI 中保留来源引用。`
        : "当前知识库没有足够相关的片段。可以先上传更完整的 TXT/CSV/JSON，生产环境再接入 PDF/Word 解析与向量检索。";
      addAudit(db, "知识库问答", question.slice(0, 36));
      writeDb(db);
      return sendJson(res, 200, { answer, sources: ranked, state: await buildState(requestContext, db) });
    }

    if (method === "POST" && url.pathname === "/api/jobs") {
      const body = await readBody(req);
      const db = readDb();
      const model = MODELS.find((item) => item.id === body.modelId) || MODELS[0];
      const rows = buildBatchRows(body);
      const job = {
        id: id("job"),
        type: body.type || "摘要",
        instruction: body.instruction || "按任务类型处理每一行输入",
        modelId: model.id,
        modelName: model.name,
        status: "running",
        progress: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        results: rows.map((row) => ({
          id: row.id,
          input: row.input,
          result: "",
          status: "queued"
        }))
      };
      db.jobs.unshift(job);
      addAudit(db, "创建批量任务", `${job.type} / ${job.modelName} / ${job.results.length} 行`);
      writeDb(db);
      startJob(job.id);
      return sendJson(res, 201, { job, state: await buildState(requestContext, db) });
    }

    if (method === "POST" && url.pathname === "/api/audit") {
      const body = await readBody(req);
      if (store.backend === "prisma") {
        if (!hasDatabaseIdentity(requestContext)) {
          return sendError(res, 401, "Please sign in before writing audit logs");
        }
        await store.writeAudit(requestContext, {
          action: body.action || "手动审计事件",
          detail: body.detail || "管理员写入操作日志",
          metadata: {
            actor: body.actor || requestContext.email
          }
        });
        return sendJson(res, 201, { state: await buildState(requestContext) });
      }
      const db = readDb();
      addAudit(db, body.action || "手动审计事件", body.detail || "管理员写入操作日志", body.actor || "admin@example.com");
      writeDb(db);
      return sendJson(res, 201, { state: await buildState(requestContext, db) });
    }

    sendError(res, 404, "接口不存在");
  } catch (error) {
    const status = /auth|token/i.test(error.message || "") ? 401 : 500;
    sendError(res, status, redactSensitive(error.message || "Server error"));
  }
}

const server = http.createServer((req, res) => {
  if ((req.method || "GET") === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Id, X-Org-Id, X-User-Email, X-Privacy-Mode, apikey"
    });
    res.end();
    return;
  }

  if (req.url.startsWith("/api/")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    handleApi(req, res);
    return;
  }

  serveStatic(req, res);
});

ensureDb();
server.listen(PORT, () => {
  console.log(`ModelHub server running at http://localhost:${PORT}`);
  console.log(`Data backend: ${config.dataBackend}`);
  console.log(`Local database: ${DB_FILE}`);
});
