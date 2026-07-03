const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const app = {
  state: null,
  clientConfig: null,
  auth: {
    session: null,
    user: null
  },
  activeView: "overview",
  activeModelId: "gpt-4.1",
  selectedJobId: null,
  editingPromptId: null,
  jobPoller: null,
  favoritePendingIds: new Set(),
  toastTimer: null,
  modelTabMotionTimer: null,
  modelTabGlassAnimation: null,
  modelTabGlassFrame: null,
  modelTabGlassFallbackTimer: null,
  modelTabDrag: null,
  suppressNextModelClick: false,
  suppressModelClickTimer: null,
  navTabMotionTimer: null,
  navTabGlassFrame: null,
  navTabGlassFallbackTimer: null,
  viewRepaintTimers: [],
  stateRefreshTimer: null,
  pendingChatFiles: [],
  sharedChat: false
};

const AUTH_STORAGE_KEY = "modelhub.supabase.session";
const CHAT_DRAFT_KEY = "modelhub.chatDraft";
const CHAT_CONVERSATION_CACHE_KEY = "modelhub.chatConversationCache";
const CHAT_SCOPE_MAP_KEY = "modelhub.chatScopeMap";
const CHAT_SHARED_MODE_KEY = "modelhub.sharedChatMode";
const CHAT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CHAT_CACHE_MESSAGE_LIMIT = 120;
const MAX_CHAT_FILE_COUNT = 5;
const MAX_CHAT_FILE_TEXT_CHARS = 12000;
const MODEL_TAB_ANIMATION_MS = 626;
const MODEL_TAB_DRAG_SETTLE_MS = Math.round(MODEL_TAB_ANIMATION_MS * 0.5);
const MODEL_TAB_LENS_OUTSET = 8;
const MODEL_TAB_LENS_EXPANSION = MODEL_TAB_LENS_OUTSET * 2;
const NAV_TAB_ANIMATION_MS = 620;
const ACTIVE_VIEW_PANEL_SELECTOR = ".view.active:not(#view-overview) .panel";
const VIEW_REPAINT_DELAYS_MS = [80, Math.round(NAV_TAB_ANIMATION_MS * 0.6), NAV_TAB_ANIMATION_MS + 140, NAV_TAB_ANIMATION_MS + 520];
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
const BOOTSTRAP_MODELS = [
  { id: "gpt-4.1", provider: "OpenAI", name: "GPT-4.1", latencyMs: 820, inputPerMillion: 2, outputPerMillion: 8, style: "结构清晰、工程落地" },
  { id: "claude-sonnet", provider: "Claude", name: "Claude Sonnet", latencyMs: 940, inputPerMillion: 3, outputPerMillion: 15, style: "推理细腻、长文稳健" },
  { id: "gemini-2.5-flash", provider: "Gemini", name: "Gemini 2.5 Flash", latencyMs: 760, inputPerMillion: 0.3, outputPerMillion: 2.5, style: "免费层可测、响应轻快" },
  { id: "deepseek-chat", provider: "DeepSeek", name: "DeepSeek Chat", latencyMs: 680, inputPerMillion: 0.27, outputPerMillion: 1.1, style: "性价比高、中文自然" },
  { id: "qwen2.5:3b", provider: "Local", name: "Qwen2.5 3B", latencyMs: 420, inputPerMillion: 0, outputPerMillion: 0, style: "本地免费，数据不出电脑" }
];
const BOOTSTRAP_PROMPTS = [
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

function createBootstrapState() {
  const now = new Date().toISOString();
  return {
    models: BOOTSTRAP_MODELS,
    backend: {
      dataBackend: "loading",
      privacyDefaultMode: "internal",
      storeMessageContent: true,
      privateDataAuthenticated: false
    },
    settings: {
      fxRate: 7.25,
      budgetUsd: 300,
      safetyEnabled: true,
      safetyWords: ["隐私", "密码", "内部财报"],
      securityPolicies: {
        encryptedOnly: true,
        noSecretLogs: true,
        balanceAlerts: true
      },
      identity: {
        emailLogin: true,
        wechatLogin: false,
        teamSpace: true
      },
      billingPlan: "team"
    },
    keys: [],
    conversations: [
      {
        id: "conv_default",
        title: "新会话",
        createdAt: now,
        updatedAt: now,
        messages: []
      }
    ],
    usage: [],
    prompts: BOOTSTRAP_PROMPTS,
    knowledgeBases: [
      {
        id: "kb_default",
        name: "默认知识库",
        createdAt: now,
        updatedAt: now,
        documents: []
      }
    ],
    jobs: [],
    auditLogs: []
  };
}

const api = async (path, options = {}) => {
  const attachAuth = options.auth !== false;
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (attachAuth && !headers.Authorization) {
    const token = app.auth.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(path, {
    ...options,
    headers
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && attachAuth && !options._retried && app.auth.session?.refresh_token) {
    try {
      const refreshed = await refreshSupabaseSession();
      if (refreshed) {
        return api(path, { ...options, _retried: true });
      }
    } catch {
      clearAuthSession();
    }
  }
  if (!response.ok) {
    const error = new Error(payload.error || "请求失败");
    error.status = response.status;
    throw error;
  }
  return payload;
};

const formatUsd = (value) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(value || 0));

const formatCny = (value) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 }).format(Number(value || 0));

const formatNumber = (value) => new Intl.NumberFormat("zh-CN").format(Math.round(Number(value || 0)));

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const renderMessageText = (value) =>
  escapeHtml(String(value ?? "").replace(/\r\n/g, "\n").replace(/\n{2,}/g, "\n").trim()).replace(/\n/g, "<br>");

const relativeTime = (iso) => {
  if (!iso) return "从未";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
};

const estimateTokens = (text) => {
  const value = String(text || "").trim();
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (value.replace(/[\u4e00-\u9fff]/g, " ").match(/[A-Za-z0-9_]+/g) || []).length;
  return Math.ceil(cjk * 0.72 + words * 1.25);
};

function toast(message) {
  const node = $("#toast");
  if (!node) return;
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}

function setBusy(control, busy, busyText = "处理中") {
  if (!control) return;
  const preserveHtml = control.classList?.contains("favorite-toggle");
  if (busy) {
    if (preserveHtml) {
      control.dataset.originalHtml = control.innerHTML;
    } else {
      control.dataset.originalText = control.textContent;
    }
    control.classList.add("is-loading");
    control.setAttribute("aria-busy", "true");
    control.disabled = true;
    if (busyText && control.tagName === "BUTTON" && !preserveHtml) control.textContent = busyText;
    return;
  }
  control.classList.remove("is-loading");
  control.removeAttribute("aria-busy");
  control.disabled = false;
  if (control.dataset.originalHtml && control.tagName === "BUTTON") {
    control.innerHTML = control.dataset.originalHtml;
  } else if (control.dataset.originalText && control.tagName === "BUTTON") {
    control.textContent = control.dataset.originalText;
  }
  delete control.dataset.originalHtml;
  delete control.dataset.originalText;
}

async function runControl(control, busyText, task) {
  try {
    setBusy(control, true, busyText);
    return await task();
  } catch (error) {
    toast(error.message || "操作失败");
    return null;
  } finally {
    setBusy(control, false);
  }
}

function readStoredSession() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    return session?.access_token ? session : null;
  } catch {
    return null;
  }
}

function persistSession(session) {
  if (!session) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

function normalizeSession(session) {
  const source = session?.session?.access_token ? session.session : session;
  if (!source?.access_token) return null;
  return {
    access_token: source.access_token,
    refresh_token: source.refresh_token || "",
    expires_at: source.expires_at || (source.expires_in ? Math.floor(Date.now() / 1000) + Number(source.expires_in) : null),
    expires_in: source.expires_in || null,
    token_type: source.token_type || "bearer",
    user: source.user || null
  };
}

function setAuthSession(session) {
  const normalized = normalizeSession(session);
  app.auth.session = normalized;
  app.auth.user = normalized?.user || null;
  persistSession(normalized);
  renderAuthPanel();
}

function clearAuthSession() {
  clearCachedConversation();
  app.auth.session = null;
  app.auth.user = null;
  persistSession(null);
  renderAuthPanel();
}

function supabaseConfig() {
  return app.clientConfig?.supabase || null;
}

function authDisplayName() {
  return app.auth.user?.email || app.auth.user?.phone || app.auth.user?.id || "未登录";
}

function renderAuthPanel() {
  const status = $("#authStatusText");
  const hint = $("#authHint");
  const email = $("#authEmailInput");
  const signIn = $("#authSignInButton");
  const signUp = $("#authSignUpButton");
  const signOut = $("#authSignOutButton");
  const config = supabaseConfig();
  if (status) status.textContent = app.auth.user ? authDisplayName() : "未登录";
  if (hint) {
    hint.textContent = config?.configured
      ? app.auth.user
        ? "会话已保存，后续请求会自动携带 token。"
        : "可以直接注册或登录。"
      : "先在 .env 里填好 SUPABASE_URL 和 SUPABASE_ANON_KEY。";
  }
  if (email && !email.value && app.auth.user?.email) {
    email.value = app.auth.user.email;
  }
  if (signIn) signIn.disabled = !config?.configured;
  if (signUp) signUp.disabled = !config?.configured;
  if (signOut) {
    signOut.disabled = !app.auth.user;
  }
}

async function loadServerConfig() {
  const status = await api("/api/security/status", { auth: false });
  app.clientConfig = status;
  renderAuthPanel();
  return status;
}

async function supabaseAuthRequest(path, body) {
  const config = supabaseConfig();
  if (!config?.configured || !config.url || !config.anonKey) {
    throw new Error("Supabase 还没有配置好");
  }
  const response = await fetch(`${config.url}/auth/v1${path}`, {
    method: "POST",
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error_description || payload.msg || payload.error || "Supabase 请求失败");
  }
  return payload;
}

async function signInWithSupabase(email, password) {
  const payload = await supabaseAuthRequest("/token?grant_type=password", { email, password });
  setAuthSession(payload);
  return payload;
}

async function signUpWithSupabase(email, password) {
  const payload = await supabaseAuthRequest("/signup", { email, password });
  if (payload.access_token || payload.session?.access_token) {
    setAuthSession(payload.session || payload);
  }
  return payload;
}

async function refreshSupabaseSession() {
  const session = app.auth.session || readStoredSession();
  if (!session?.refresh_token) return null;
  const payload = await supabaseAuthRequest("/token?grant_type=refresh_token", {
    refresh_token: session.refresh_token
  });
  setAuthSession(payload);
  return payload;
}

async function signOutWithSupabase() {
  const session = app.auth.session || readStoredSession();
  if (!supabaseConfig()?.configured) {
    clearAuthSession();
    return;
  }
  if (session?.refresh_token) {
    try {
      await supabaseAuthRequest("/logout", { refresh_token: session.refresh_token });
    } catch {
      // 本地退出仍然继续清理
    }
  }
  clearAuthSession();
}

function authDisplayName() {
  return app.auth.user?.email || app.auth.user?.phone || app.auth.user?.id || "未登录";
}

function authPageHref(mode = "signin") {
  const returnTo = encodeURIComponent(`${window.location.pathname}${window.location.search}${window.location.hash}` || "/");
  return `/auth.html?mode=${mode}&returnTo=${returnTo}`;
}

function redirectToSignIn(draft = "") {
  const value = String(draft || "").trim();
  if (value) sessionStorage.setItem(CHAT_DRAFT_KEY, value);
  window.location.href = authPageHref("signin");
}

function restoreChatDraft() {
  const draft = sessionStorage.getItem(CHAT_DRAFT_KEY);
  const input = $("#chatInput");
  if (!draft || !input || input.value.trim()) return;
  input.value = draft;
  sessionStorage.removeItem(CHAT_DRAFT_KEY);
  const estimate = $("#estimatedTokens");
  if (estimate) estimate.textContent = `预计 ${estimateTokens(draft)} tokens`;
  input.focus();
}

function chatConversationCacheKey(scopeKey = activeConversationScopeKey()) {
  const userKey = app.auth.user?.id || app.auth.user?.email || app.auth.session?.user?.id || "guest";
  return `${CHAT_CONVERSATION_CACHE_KEY}:${userKey}:${scopeKey}`;
}

function chatScopeMapKey() {
  const userKey = app.auth.user?.id || app.auth.user?.email || app.auth.session?.user?.id || "guest";
  return `${CHAT_SCOPE_MAP_KEY}:${userKey}`;
}

function readChatScopeMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(chatScopeMapKey()) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeChatScopeMap(map) {
  try {
    localStorage.setItem(chatScopeMapKey(), JSON.stringify(map || {}));
  } catch {
    // Backend remains canonical if local storage is unavailable.
  }
}

function conversationTitleForScope(scopeKey = activeConversationScopeKey()) {
  if (scopeKey === "shared") return "共享聊天窗口";
  const modelId = scopeKey.startsWith("model:") ? scopeKey.slice(6) : app.activeModelId;
  const model = selectableModels().find((item) => item.id === modelId);
  return model?.name || "新会话";
}

function activeConversationScopeKey() {
  return app.sharedChat ? "shared" : `model:${normalizeActiveModelId()}`;
}

function conversationIdForScope(scopeKey = activeConversationScopeKey()) {
  return readChatScopeMap()[scopeKey] || null;
}

function saveConversationScope(scopeKey, conversationId) {
  if (!scopeKey || !conversationId || String(conversationId).startsWith("pending:")) return;
  const map = readChatScopeMap();
  map[scopeKey] = conversationId;
  writeChatScopeMap(map);
}

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

function isProviderQuotaErrorText(value) {
  return /quota|billing|insufficient|exceeded|429|rate limit|resource exhausted|too many requests|free_tier_requests/i.test(String(value || ""));
}

function isProviderBusyErrorText(value) {
  return /high demand|overloaded|temporarily unavailable|try again later|service unavailable|server busy|capacity|\b503\b/i.test(String(value || ""));
}

function normalizeKnownProviderErrorMessage(message) {
  if (message?.role !== "assistant") return message;
  const content = String(message.content || "");
  if (!/当前模型 ID 不可用/.test(content)) return message;

  const detail = content.match(/错误详情：([\s\S]*)/)?.[1]?.trim() || content;
  if (isProviderQuotaErrorText(content)) {
    return {
      ...message,
      content: `API 额度不足或触发限流，请稍后再试，或更换可用密钥。\n\n错误详情：${detail}`
    };
  }
  if (isProviderBusyErrorText(content)) {
    return {
      ...message,
      content: `服务商当前繁忙或模型负载过高，这不是模型 ID 写错。请稍后重试，或临时切换到本地 Qwen2.5。\n\n错误详情：${detail}`
    };
  }
  return message;
}

function sanitizeConversationMessages(conversation) {
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

function normalizeCachedConversationPayload(value) {
  const payload = typeof value === "string" ? JSON.parse(value) : value;
  const savedAt = Number(payload?.savedAt || 0);
  if (savedAt && Date.now() - savedAt > CHAT_CACHE_TTL_MS) return null;
  const conversation = payload?.conversation || payload;
  const cleanConversation = sanitizeConversationMessages(conversation);
  return Array.isArray(cleanConversation?.messages) && cleanConversation.messages.length ? cleanConversation : null;
}

function trimConversationForCache(conversation) {
  const cleanConversation = sanitizeConversationMessages(conversation);
  if (!cleanConversation?.messages?.length) return cleanConversation;
  return {
    ...cleanConversation,
    messages: cleanConversation.messages.slice(-CHAT_CACHE_MESSAGE_LIMIT)
  };
}

function readCachedConversation(scopeKey = activeConversationScopeKey()) {
  const key = chatConversationCacheKey(scopeKey);
  try {
    const sessionConversation = normalizeCachedConversationPayload(sessionStorage.getItem(key));
    if (sessionConversation) return sessionConversation;
  } catch {
    // Try the longer-lived cache below.
  }
  try {
    return normalizeCachedConversationPayload(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function cacheConversation(conversation, scopeKey = activeConversationScopeKey()) {
  const key = chatConversationCacheKey(scopeKey);
  try {
    if (!conversation?.messages?.length) {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
      return;
    }
    const payload = JSON.stringify({
      savedAt: Date.now(),
      conversation: trimConversationForCache(conversation)
    });
    sessionStorage.setItem(key, payload);
    localStorage.setItem(key, payload);
  } catch {
    // Ignore storage quota/private-mode failures; backend state remains canonical.
  }
}

function clearCachedConversation(scopeKey = activeConversationScopeKey()) {
  const key = chatConversationCacheKey(scopeKey);
  try {
    sessionStorage.removeItem(key);
    localStorage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}

function renderAuthPanel() {
  const identity = $("#accountIdentity");
  const status = $("#accountStatusLabel");
  const profileIdentity = $("#profileIdentity");
  const profileStatus = $("#profileStatusLabel");
  const meta = $("#accountMeta");
  const signIn = $("#accountSignInLink");
  const signUp = $("#accountSignUpLink");
  const signOut = $("#accountSignOutButton");
  const profileSignIn = $("#profileSignInLink");
  const profileSignUp = $("#profileSignUpLink");
  const profileSignOut = $("#profileSignOutButton");
  const actions = $("#accountActions");
  const config = supabaseConfig();
  const isConfigured = Boolean(config?.configured);
  const isSignedIn = Boolean(app.auth.user);

  if (identity) {
    identity.textContent = isSignedIn ? authDisplayName() : "未登录";
  }
  if (profileIdentity) {
    profileIdentity.textContent = isSignedIn ? authDisplayName() : "未登录";
  }

  if (status) {
    if (!isConfigured) {
      status.textContent = "Supabase 未配置";
    } else if (!isSignedIn) {
      status.textContent = "访客模式";
    } else if (app.auth.user?.email_confirmed_at) {
      status.textContent = "账号已验证";
    } else {
      status.textContent = "待完成验证";
    }
  }
  if (profileStatus) {
    profileStatus.textContent = status?.textContent || (isSignedIn ? "账号已连接" : "访客模式");
  }

  if (meta) {
    if (!isConfigured) {
      meta.textContent = "请先在 .env 中配置 Supabase 连接信息。";
    } else if (!isSignedIn) {
      meta.textContent = "点击头像进入个人中心。";
    } else if (app.auth.user?.email) {
      meta.textContent = `当前账号：${app.auth.user.email}`;
    } else {
      meta.textContent = "当前会话已连接，可以直接使用。";
    }
  }

  if (signIn) {
    signIn.href = authPageHref("signin");
    signIn.hidden = !isConfigured || isSignedIn;
    signIn.setAttribute("aria-disabled", String(!isConfigured));
  }
  if (profileSignIn) {
    profileSignIn.href = authPageHref("signin");
    profileSignIn.hidden = !isConfigured || isSignedIn;
    profileSignIn.setAttribute("aria-disabled", String(!isConfigured));
  }

  if (signUp) {
    signUp.href = authPageHref("signup");
    signUp.hidden = !isConfigured || isSignedIn;
    signUp.setAttribute("aria-disabled", String(!isConfigured));
  }
  if (profileSignUp) {
    profileSignUp.href = authPageHref("signup");
    profileSignUp.hidden = !isConfigured || isSignedIn;
    profileSignUp.setAttribute("aria-disabled", String(!isConfigured));
  }

  if (signOut) {
    signOut.hidden = !isSignedIn;
    signOut.disabled = !isSignedIn;
  }
  if (profileSignOut) {
    profileSignOut.hidden = !isSignedIn;
    profileSignOut.disabled = !isSignedIn;
  }

  if (actions) {
    actions.classList.toggle("is-authenticated", isSignedIn);
  }
}

function setState(nextState) {
  app.state = nextState;
  normalizeActiveModelId();
  cacheConversation(currentConversation());
  render();
}

async function refreshState() {
  const state = await api("/api/state");
  setState(state);
}

function markStateRefreshFailed(error) {
  if (app.state?.backend?.dataBackend === "loading") {
    app.state = {
      ...app.state,
      backend: {
        ...app.state.backend,
        dataBackend: "unavailable",
        syncError: error?.message || "State refresh failed"
      }
    };
    render();
    return;
  }
  renderChat();
}

function mergeMessages(existingMessages = [], incomingMessages = []) {
  const byId = new Map();
  [...existingMessages, ...incomingMessages].forEach((message) => {
    if (!message) return;
    if (isPollutedAssistantMessage(message)) return;
    const key = message.id || `${message.role || "message"}:${message.createdAt || ""}:${message.content || ""}`;
    byId.set(key, message);
  });
  return Array.from(byId.values()).sort((a, b) =>
    String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
  );
}

function messageContentKey(value) {
  return String(value ?? "").trim();
}

function removeConfirmedPendingMessages(existingMessages = [], incomingMessages = []) {
  const confirmedUserMessages = new Set(
    incomingMessages
      .filter((message) => message && !message.pending && message.role === "user")
      .map((message) => messageContentKey(message.content))
      .filter(Boolean)
  );
  if (!confirmedUserMessages.size) return existingMessages;
  return existingMessages.filter(
    (message) =>
      !(
        message?.pending &&
        message.role === "user" &&
        confirmedUserMessages.has(messageContentKey(message.content))
      )
  );
}

function mergeConversationIntoState(conversation, messages, scopeKey = activeConversationScopeKey()) {
  if (!conversation) return;
  const cleanConversation = sanitizeConversationMessages(conversation);
  const conversations = Array.isArray(app.state?.conversations) ? [...app.state.conversations] : [];
  let index = conversations.findIndex((item) => item.id === cleanConversation.id);
  if (index < 0 && scopeKey) {
    index = conversations.findIndex((item) => item.id === `pending:${scopeKey}`);
  }
  const existingMessages = index >= 0 ? sanitizeConversationMessages(conversations[index]).messages || [] : [];
  const incomingMessages = Array.isArray(messages)
    ? messages
    : Array.isArray(cleanConversation.messages)
      ? cleanConversation.messages
      : [];
  const baseMessages = removeConfirmedPendingMessages(existingMessages, incomingMessages);
  const nextConversation = {
    ...(index >= 0 ? conversations[index] : {}),
    ...cleanConversation,
    messages: mergeMessages(baseMessages, incomingMessages)
  };

  if (index >= 0) {
    conversations[index] = nextConversation;
  } else {
    conversations.unshift(nextConversation);
  }

  conversations.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  app.state = {
    ...app.state,
    conversations
  };
  saveConversationScope(scopeKey, nextConversation.id);
  cacheConversation(nextConversation, scopeKey);
}

function appendOptimisticUserMessage(content, conversationId = currentConversation().id, scopeKey = activeConversationScopeKey()) {
  const conversations = Array.isArray(app.state?.conversations) ? [...app.state.conversations] : [];
  const index = conversations.findIndex((item) => item.id === conversationId);
  const baseConversation = index >= 0 ? conversations[index] : { ...currentConversation(scopeKey), id: conversationId };
  const timestamp = new Date().toISOString();
  const message = {
    id: `tmp_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    content,
    createdAt: timestamp,
    pending: true
  };
  const previousMessages = Array.isArray(baseConversation.messages) ? baseConversation.messages : [];
  const titleSource = messageContentKey(content).split("\n")[0];
  const nextConversation = {
    ...baseConversation,
    id: conversationId,
    scopeKey,
    title: previousMessages.length ? baseConversation.title : titleSource.slice(0, 22) || baseConversation.title,
    updatedAt: timestamp,
    messages: [...previousMessages, message]
  };

  if (index >= 0) {
    conversations[index] = nextConversation;
  } else {
    conversations.unshift(nextConversation);
  }

  app.state = {
    ...app.state,
    conversations
  };
  cacheConversation(nextConversation, scopeKey);
  renderChat();
  return { conversationId, messageId: message.id, scopeKey };
}

function removeOptimisticMessage(optimisticMessage) {
  if (!optimisticMessage?.messageId) return;
  const conversations = Array.isArray(app.state?.conversations) ? [...app.state.conversations] : [];
  const index = conversations.findIndex((item) => item.id === optimisticMessage.conversationId);
  if (index < 0) return;
  const conversation = conversations[index];
  const messages = (conversation.messages || []).filter((message) => message.id !== optimisticMessage.messageId);
  if (messages.length === (conversation.messages || []).length) return;
  const nextConversation = {
    ...conversation,
    messages
  };
  conversations[index] = nextConversation;
  app.state = {
    ...app.state,
    conversations
  };
  cacheConversation(nextConversation, optimisticMessage.scopeKey || activeConversationScopeKey());
  renderChat();
}

function clearConversationLocally(scopeKey = activeConversationScopeKey()) {
  const conversationId = conversationIdForScope(scopeKey) || `pending:${scopeKey}`;
  const conversations = (app.state?.conversations || []).map((conversation) =>
    conversation.id === conversationId
      ? { ...conversation, messages: [], updatedAt: new Date().toISOString() }
      : conversation
  );
  app.state = {
    ...app.state,
    conversations
  };
  clearCachedConversation(scopeKey);
  renderChat();
}

function applyChatResponse(response, scopeKey = activeConversationScopeKey()) {
  if (response?.state) {
    setState(response.state);
    return;
  }
  if (!response?.conversation) return;
  mergeConversationIntoState(response.conversation, response.messages, scopeKey);
  renderChat();
}

function scheduleStateRefresh(delay = 350) {
  clearTimeout(app.stateRefreshTimer);
  app.stateRefreshTimer = setTimeout(() => {
    app.stateRefreshTimer = null;
    refreshState().catch((error) => {
      console.warn("State refresh failed after chat update", error);
    });
  }, delay);
}

function selectableModels() {
  return app.state?.models?.length ? app.state.models : BOOTSTRAP_MODELS;
}

function localOllamaModel(models = selectableModels()) {
  return models.find((model) => String(model.provider || "").toLowerCase().includes("local"))
    || models.find((model) => String(model.name || "").toLowerCase().includes("ollama"));
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

function normalizeModelId(modelId) {
  const models = selectableModels();
  if (models.some((model) => model.id === modelId)) return modelId;
  const localModel = localOllamaModel(models);
  if (localModel && isLocalModelRequest(modelId)) return localModel.id;
  return models[0]?.id || modelId;
}

function normalizeActiveModelId() {
  app.activeModelId = normalizeModelId(app.activeModelId);
  return app.activeModelId;
}

function selectedModel() {
  const models = selectableModels();
  const activeModelId = normalizeActiveModelId();
  return models.find((model) => model.id === activeModelId) || models[0];
}

function findConversationById(conversationId) {
  if (!conversationId) return null;
  return (app.state?.conversations || []).find((item) => item.id === conversationId) || null;
}

function conversationStubForScope(scopeKey = activeConversationScopeKey()) {
  return {
    id: `pending:${scopeKey}`,
    title: conversationTitleForScope(scopeKey),
    messages: [],
    scopeKey,
    pendingConversation: true
  };
}

function ensureCachedConversationForScope(scopeKey = activeConversationScopeKey()) {
  const cachedConversation = readCachedConversation(scopeKey);
  if (!cachedConversation) return null;
  if (!findConversationById(cachedConversation.id)) {
    app.state = {
      ...app.state,
      conversations: [cachedConversation, ...(app.state?.conversations || [])]
    };
  }
  saveConversationScope(scopeKey, cachedConversation.id);
  return cachedConversation;
}

function currentConversation(scopeKey = activeConversationScopeKey()) {
  const scopedId = conversationIdForScope(scopeKey);
  const scopedConversation = findConversationById(scopedId);
  if (scopedConversation) return scopedConversation;

  const cachedConversation = ensureCachedConversationForScope(scopeKey);
  if (cachedConversation) return cachedConversation;

  if (scopeKey === "shared") {
    return app.state?.conversations?.[0] || conversationStubForScope(scopeKey);
  }

  return conversationStubForScope(scopeKey);
}

function interpolate(start, end, progress) {
  return start + (end - start) * progress;
}

function easeLiquid(progress) {
  const t = Math.max(0, Math.min(1, progress));
  return t * t * (3 - 2 * t);
}

function liquidFrameAt(progress, frames) {
  const t = Math.max(0, Math.min(1, progress));
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1];
    const next = frames[index];
    if (t <= next.offset) {
      const span = next.offset - previous.offset || 1;
      const local = easeLiquid((t - previous.offset) / span);
      const frame = {};
      new Set([...Object.keys(previous), ...Object.keys(next)]).forEach((key) => {
        if (key === "offset") return;
        const previousValue = previous[key];
        const nextValue = next[key];
        if (typeof previousValue === "number" && typeof nextValue === "number") {
          frame[key] = interpolate(previousValue, nextValue, local);
          return;
        }
        frame[key] = local < 0.5 ? previousValue : nextValue;
      });
      return frame;
    }
  }
  const last = frames[frames.length - 1];
  return { ...last };
}

function liquidRadius(progress, direction, pull = 0) {
  const travel = Math.sin(Math.PI * Math.min(progress / 0.72, 1));
  const settle = progress > 0.58 ? Math.sin(((progress - 0.58) / 0.42) * Math.PI) : 0;
  const strength = Math.max(0, Math.min(1.16, Math.max(pull, travel * 0.86) - settle * 0.24));
  const lead = 50 - strength * 12;
  const tail = 50 + strength * 12;
  const upper = 50 + strength * 7;
  const lower = 50 - strength * 7;

  if (direction < 0) {
    return `${tail}% ${lead}% ${lead + 4}% ${tail - 4}% / ${lower}% ${upper}% ${lower}% ${upper}%`;
  }
  return `${lead}% ${tail}% ${tail - 4}% ${lead + 4}% / ${upper}% ${lower}% ${upper}% ${lower}%`;
}

function navLiquidRadius(progress, direction, pull = 0) {
  const travel = Math.sin(Math.PI * Math.min(progress / 0.72, 1));
  const settle = progress > 0.58 ? Math.sin(((progress - 0.58) / 0.42) * Math.PI) : 0;
  const strength = Math.max(0, Math.min(1, Math.max(pull, travel * 0.78) - settle * 0.28));
  const lead = 15 - strength * 4;
  const tail = 15 + strength * 8;

  if (direction < 0) {
    return `${lead}px ${lead}px ${tail}px ${tail}px`;
  }
  return `${tail}px ${tail}px ${lead}px ${lead}px`;
}

function animateModelTabGlass(tabs, frames, duration = MODEL_TAB_ANIMATION_MS) {
  const glass = tabs?.querySelector(".model-tab-glass");
  const trail = tabs?.querySelector(".model-tab-trail");
  if (!glass) return;

  if (app.modelTabGlassFrame) {
    cancelAnimationFrame(app.modelTabGlassFrame);
    app.modelTabGlassFrame = null;
  }
  if (app.modelTabGlassFallbackTimer) {
    clearTimeout(app.modelTabGlassFallbackTimer);
    app.modelTabGlassFallbackTimer = null;
  }

  const setMotionStyle = (element, property, value) => {
    element?.style.setProperty(property, value, "important");
  };

  const startedAt = performance.now();
  const direction = Number.parseFloat(tabs.style.getPropertyValue("--active-tab-direction")) || 1;
  setMotionStyle(glass, "transition", "none");
  const scheduleNextFrame = () => {
    let fallbackTimer = 0;
    const runFrame = (now) => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (app.modelTabGlassFallbackTimer === fallbackTimer) {
        app.modelTabGlassFallbackTimer = null;
      }
      tick(now);
    };
    app.modelTabGlassFrame = requestAnimationFrame(runFrame);
    fallbackTimer = setTimeout(() => {
      if (app.modelTabGlassFrame) {
        cancelAnimationFrame(app.modelTabGlassFrame);
        app.modelTabGlassFrame = null;
      }
      if (app.modelTabGlassFallbackTimer === fallbackTimer) {
        app.modelTabGlassFallbackTimer = null;
      }
      tick(performance.now());
    }, 32);
    app.modelTabGlassFallbackTimer = fallbackTimer;
  };

  const tick = (now) => {
    if (app.modelTabGlassFallbackTimer) {
      clearTimeout(app.modelTabGlassFallbackTimer);
      app.modelTabGlassFallbackTimer = null;
    }
    const progress = (now - startedAt) / duration;
    const frame = liquidFrameAt(progress, frames);
    const lensWidth = frame.width + MODEL_TAB_LENS_EXPANSION;
    const lensX = frame.x - MODEL_TAB_LENS_OUTSET;
    setMotionStyle(glass, "width", `${lensWidth}px`);
    setMotionStyle(glass, "transform", `translate3d(${lensX}px, 0, 0) skewX(${frame.skew || 0}deg)`);
    setMotionStyle(glass, "border-radius", liquidRadius(Math.min(progress, 1), direction, frame.pull || 0));
    setMotionStyle(glass, "opacity", "var(--model-tab-glass-opacity, 1)");
    setMotionStyle(glass, "filter", "none");
    glass.style.setProperty("--model-tab-glint-x", `${frame.glint || 0}%`);
    glass.style.setProperty("--model-tab-glint-opacity", String(frame.glintOpacity || 0.16));
    glass.style.setProperty("--model-tab-edge-alpha", String(frame.edgeAlpha || 0.18));
    if (trail) {
      setMotionStyle(trail, "width", `${frame.trailWidth || frame.width}px`);
      setMotionStyle(trail, "transform", `translate3d(${frame.trailX ?? frame.x}px, 0, 0) scaleX(${frame.trailScale || 1})`);
      setMotionStyle(trail, "opacity", String(frame.trailOpacity || 0));
      setMotionStyle(trail, "filter", frame.trailBlur === 0 ? "none" : `blur(${frame.trailBlur ?? 8}px)`);
    }

    if (progress < 1) {
      scheduleNextFrame();
      return;
    }

    glass.style.removeProperty("border-radius");
    glass.style.removeProperty("opacity");
    glass.style.removeProperty("filter");
    glass.style.removeProperty("--model-tab-glint-x");
    glass.style.removeProperty("--model-tab-glint-opacity");
    glass.style.removeProperty("--model-tab-edge-alpha");
    if (trail) {
      trail.style.removeProperty("width");
      trail.style.removeProperty("transform");
      trail.style.removeProperty("opacity");
      trail.style.removeProperty("filter");
    }
    refreshModelTabGlass(tabs);
    app.modelTabGlassFrame = null;
    app.modelTabGlassFallbackTimer = null;
  };

  tick(startedAt);
}

function refreshModelTabGlass(tabs, width, height) {
  const glass = tabs?.querySelector(".model-tab-glass");
  if (!glass) return;
  const rect = glass.getBoundingClientRect();
  const detail = {
    width: width || rect.width,
    height: height || rect.height,
    exact: true
  };

  if (window.ModelHubLiquidGlass?.refreshElement) {
    window.ModelHubLiquidGlass.refreshElement(glass, detail);
    return;
  }

  glass.dispatchEvent(new CustomEvent("modelhub:refresh-liquid-glass", { bubbles: true, detail }));
}

function cancelModelTabMotion() {
  if (app.modelTabGlassFrame) {
    cancelAnimationFrame(app.modelTabGlassFrame);
    app.modelTabGlassFrame = null;
  }
  if (app.modelTabGlassFallbackTimer) {
    clearTimeout(app.modelTabGlassFallbackTimer);
    app.modelTabGlassFallbackTimer = null;
  }
  if (app.modelTabMotionTimer) {
    clearTimeout(app.modelTabMotionTimer);
    app.modelTabMotionTimer = null;
  }
}

function clearModelTabInlineMotion(tabs) {
  const glass = tabs?.querySelector(".model-tab-glass");
  const trail = tabs?.querySelector(".model-tab-trail");
  ["width", "transform", "border-radius", "opacity", "filter", "transition"].forEach((property) => {
    glass?.style.removeProperty(property);
  });
  ["--model-tab-glint-x", "--model-tab-glint-opacity", "--model-tab-edge-alpha"].forEach((property) => {
    glass?.style.removeProperty(property);
  });
  ["width", "transform", "opacity", "filter"].forEach((property) => {
    trail?.style.removeProperty(property);
  });
}

function setModelTabActiveState(modelId) {
  const normalizedModelId = normalizeModelId(modelId);
  if (!normalizedModelId || normalizedModelId === app.activeModelId) return;
  app.activeModelId = normalizedModelId;
  const tabs = $("#modelTabs");
  $$("button[data-model-id]", tabs || document).forEach((button) => {
    const active = button.dataset.modelId === normalizedModelId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const activeModelLabel = $("#activeModelLabel");
  if (activeModelLabel) activeModelLabel.textContent = selectedModel()?.name || "閫夋嫨妯″瀷";
}

function modelTabButtonFromClientX(tabs, clientX) {
  const buttons = $$("button[data-model-id]", tabs);
  if (!buttons.length) return null;
  let best = buttons[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  buttons.forEach((button) => {
    const rect = button.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    const distance = Math.abs(clientX - center);
    if (distance < bestDistance) {
      best = button;
      bestDistance = distance;
    }
  });
  return best;
}

function applyModelTabDragFrame(tabs, event) {
  const glass = tabs?.querySelector(".model-tab-glass");
  const trail = tabs?.querySelector(".model-tab-trail");
  const target = modelTabButtonFromClientX(tabs, event.clientX);
  if (!tabs || !glass || !target) return null;

  const tabsRect = tabs.getBoundingClientRect();
  const width = target.offsetWidth;
  const height = target.offsetHeight;
  const minX = 0;
  const maxX = Math.max(0, tabs.clientWidth - width);
  const pointerX = event.clientX - tabsRect.left - width / 2;
  const x = Math.max(minX, Math.min(maxX, pointerX));
  const targetX = target.offsetLeft - tabs.scrollLeft;
  const direction = x >= (Number.parseFloat(tabs.style.getPropertyValue("--active-tab-x")) || targetX) ? 1 : -1;
  const skew = Math.max(-5.5, Math.min(5.5, (x - targetX) * 0.08));

  tabs.style.setProperty("--active-tab-x", `${x}px`);
  tabs.style.setProperty("--active-tab-width", `${width}px`);
  tabs.style.setProperty("--active-tab-height", `${height}px`);
  tabs.style.setProperty("--active-tab-direction", `${direction}`);
  glass.style.setProperty("width", `${width + MODEL_TAB_LENS_EXPANSION}px`, "important");
  glass.style.setProperty("transform", `translate3d(${x - MODEL_TAB_LENS_OUTSET}px, 0, 0) skewX(${skew}deg)`, "important");
  glass.style.setProperty("border-radius", liquidRadius(0.35, direction, Math.min(0.72, Math.abs(skew) / 5.5)), "important");
  glass.style.setProperty("opacity", "var(--model-tab-glass-opacity, 1)", "important");
  glass.style.setProperty("filter", "none", "important");
  glass.style.setProperty("--model-tab-glint-x", "0px");
  glass.style.setProperty("--model-tab-glint-opacity", "0");
  glass.style.setProperty("--model-tab-edge-alpha", "0.34");

  if (trail) {
    trail.style.setProperty("opacity", "0", "important");
    trail.style.setProperty("filter", "none", "important");
  }

  return target;
}

function settleDraggedModelTab(tabs, target) {
  if (!tabs || !target) return;
  cancelModelTabMotion();
  tabs.classList.add("is-sliding");
  clearModelTabInlineMotion(tabs);
  void tabs.offsetWidth;
  syncModelTabIndicator();
  refreshModelTabGlass(tabs, target.offsetWidth, target.offsetHeight);
  clearTimeout(app.modelTabMotionTimer);
  app.modelTabMotionTimer = setTimeout(() => tabs.classList.remove("is-sliding"), MODEL_TAB_DRAG_SETTLE_MS + 60);
}

function syncModelTabIndicator() {
  const tabs = $("#modelTabs");
  const active = tabs?.querySelector("button.active");
  if (!tabs || !active) return;

  const previousLeft = Number.parseFloat(tabs.style.getPropertyValue("--active-tab-x"));
  const previousWidth = Number.parseFloat(tabs.style.getPropertyValue("--active-tab-width"));
  const left = active.offsetLeft - tabs.scrollLeft;
  const direction = Number.isFinite(previousLeft) && left < previousLeft ? -1 : 1;
  const activeWidth = active.offsetWidth;
  const hasPrevious = Number.isFinite(previousLeft) && Number.isFinite(previousWidth);
  const distance = hasPrevious ? Math.abs(left - previousLeft) : 0;

  tabs.style.setProperty("--active-tab-x", `${left}px`);
  tabs.style.setProperty("--active-tab-width", `${activeWidth}px`);
  tabs.style.setProperty("--active-tab-height", `${active.offsetHeight}px`);
  tabs.style.setProperty("--active-tab-direction", `${direction}`);

  if (hasPrevious && distance > 1 && !tabs.classList.contains("is-dragging")) {
    const stretch = Math.min(42, Math.max(16, distance * 0.1));
    tabs.classList.add("is-sliding");
    refreshModelTabGlass(tabs, activeWidth + stretch, active.offsetHeight);
    animateModelTabGlass(tabs, [
      { offset: 0, x: previousLeft, width: previousWidth, skew: 0, pull: 0, opacity: 1, saturate: 1, edgeAlpha: 0.2, trailOpacity: 0 },
      { offset: 0.2, x: interpolate(previousLeft, left, 0.24), width: Math.max(previousWidth, activeWidth) + stretch, skew: 4.2 * direction, pull: 0.82, opacity: 1, saturate: 1.06, edgeAlpha: 0.3, trailOpacity: 0 },
      { offset: 0.56, x: interpolate(previousLeft, left, 0.72), width: activeWidth + stretch * 0.65, skew: -2.4 * direction, pull: 0.68, opacity: 1, saturate: 1.08, edgeAlpha: 0.32, trailOpacity: 0 },
      { offset: 0.82, x: left + direction * 5, width: activeWidth + 8, skew: 1.25 * direction, pull: 0.24, opacity: 1, saturate: 1.03, edgeAlpha: 0.24, trailOpacity: 0 },
      { offset: 1, x: left, width: activeWidth, skew: 0, pull: 0, opacity: 1, saturate: 1, edgeAlpha: 0.2, trailOpacity: 0 }
    ], MODEL_TAB_ANIMATION_MS);
    clearTimeout(app.modelTabMotionTimer);
    app.modelTabMotionTimer = setTimeout(() => {
      tabs.classList.remove("is-sliding");
      refreshModelTabGlass(tabs, activeWidth, active.offsetHeight);
    }, MODEL_TAB_ANIMATION_MS + 80);
    return;
  }

  if (window.ModelHubLiquidGlass?.refresh) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.ModelHubLiquidGlass.refresh());
    });
  } else {
    refreshModelTabGlass(tabs, active.offsetWidth, active.offsetHeight);
  }
}

function animateNavTabGlass(nav, frames) {
  const glass = nav?.querySelector(".nav-tab-glass");
  const trail = nav?.querySelector(".nav-tab-trail");
  if (!glass) return;

  if (app.navTabGlassFrame) {
    cancelAnimationFrame(app.navTabGlassFrame);
    app.navTabGlassFrame = null;
  }
  if (app.navTabGlassFallbackTimer) {
    clearTimeout(app.navTabGlassFallbackTimer);
    app.navTabGlassFallbackTimer = null;
  }

  const setMotionStyle = (element, property, value) => {
    element?.style.setProperty(property, value, "important");
  };

  const startedAt = performance.now();
  const direction = Number.parseFloat(nav.style.getPropertyValue("--active-nav-direction")) || 1;
  setMotionStyle(glass, "transition", "none");

  const scheduleNextFrame = () => {
    let fallbackTimer = 0;
    const runFrame = (now) => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (app.navTabGlassFallbackTimer === fallbackTimer) {
        app.navTabGlassFallbackTimer = null;
      }
      tick(now);
    };
    app.navTabGlassFrame = requestAnimationFrame(runFrame);
    fallbackTimer = setTimeout(() => {
      if (app.navTabGlassFrame) {
        cancelAnimationFrame(app.navTabGlassFrame);
        app.navTabGlassFrame = null;
      }
      if (app.navTabGlassFallbackTimer === fallbackTimer) {
        app.navTabGlassFallbackTimer = null;
      }
      tick(performance.now());
    }, 32);
    app.navTabGlassFallbackTimer = fallbackTimer;
  };

  const tick = (now) => {
    if (app.navTabGlassFallbackTimer) {
      clearTimeout(app.navTabGlassFallbackTimer);
      app.navTabGlassFallbackTimer = null;
    }
    const progress = (now - startedAt) / NAV_TAB_ANIMATION_MS;
    const frame = liquidFrameAt(progress, frames);
    setMotionStyle(glass, "width", `${frame.width}px`);
    setMotionStyle(glass, "height", `${frame.height}px`);
    setMotionStyle(glass, "transform", `translate3d(${frame.x}px, ${frame.y}px, 0) skewY(${frame.skew || 0}deg)`);
    setMotionStyle(glass, "border-radius", navLiquidRadius(Math.min(progress, 1), direction, frame.pull || 0));
    setMotionStyle(glass, "opacity", String(frame.opacity || 1));
    setMotionStyle(glass, "filter", `saturate(${frame.saturate || 1})`);
    glass.style.setProperty("--nav-tab-glint-y", `${frame.glint || 0}%`);
    glass.style.setProperty("--nav-tab-glint-opacity", String(frame.glintOpacity || 0.08));
    glass.style.setProperty("--nav-tab-edge-alpha", String(frame.edgeAlpha || 0.18));
    if (trail) {
      setMotionStyle(trail, "width", `${frame.trailWidth || frame.width}px`);
      setMotionStyle(trail, "height", `${frame.trailHeight || frame.height}px`);
      setMotionStyle(trail, "transform", `translate3d(${frame.trailX ?? frame.x}px, ${frame.trailY ?? frame.y}px, 0) scaleY(${frame.trailScale || 1})`);
      setMotionStyle(trail, "opacity", String(frame.trailOpacity || 0));
      setMotionStyle(trail, "filter", `blur(${frame.trailBlur || 8}px)`);
    }

    if (progress < 1) {
      scheduleNextFrame();
      return;
    }

    glass.style.removeProperty("width");
    glass.style.removeProperty("height");
    glass.style.removeProperty("transform");
    glass.style.removeProperty("border-radius");
    glass.style.removeProperty("opacity");
    glass.style.removeProperty("filter");
    glass.style.removeProperty("transition");
    glass.style.removeProperty("--nav-tab-glint-y");
    glass.style.removeProperty("--nav-tab-glint-opacity");
    glass.style.removeProperty("--nav-tab-edge-alpha");
    if (trail) {
      trail.style.removeProperty("width");
      trail.style.removeProperty("height");
      trail.style.removeProperty("transform");
      trail.style.removeProperty("opacity");
      trail.style.removeProperty("filter");
    }
    refreshNavTabGlass(nav);
    app.navTabGlassFrame = null;
    app.navTabGlassFallbackTimer = null;
  };

  tick(startedAt);
}

function refreshNavTabGlass(nav, width, height) {
  const glass = nav?.querySelector(".nav-tab-glass");
  if (!glass) return;
  const rect = glass.getBoundingClientRect();
  const detail = {
    width: width || rect.width,
    height: height || rect.height,
    exact: true
  };

  if (window.ModelHubLiquidGlass?.refreshElement) {
    window.ModelHubLiquidGlass.refreshElement(glass, detail);
    return;
  }

  glass.dispatchEvent(new CustomEvent("modelhub:refresh-liquid-glass", { bubbles: true, detail }));
}

function syncNavTabIndicator() {
  const nav = $(".nav-list");
  const active = nav?.querySelector(".nav-item.active:not([hidden])");
  if (!nav) return;
  const glass = nav.querySelector(".nav-tab-glass");
  const trail = nav.querySelector(".nav-tab-trail");
  nav.classList.toggle("has-nav-selection", Boolean(active));
  if (!active) {
    glass?.style.setProperty("opacity", "0", "important");
    trail?.style.setProperty("opacity", "0", "important");
    return;
  }

  glass?.style.removeProperty("opacity");
  trail?.style.removeProperty("opacity");

  const previousTop = Number.parseFloat(nav.style.getPropertyValue("--active-nav-y"));
  const previousHeight = Number.parseFloat(nav.style.getPropertyValue("--active-nav-height"));
  const x = active.offsetLeft;
  const y = active.offsetTop - nav.scrollTop;
  const nextWidth = active.offsetWidth;
  const nextHeight = active.offsetHeight;
  const hasPrevious = Number.isFinite(previousTop) && Number.isFinite(previousHeight);
  const startY = hasPrevious ? previousTop : y;
  const startHeight = hasPrevious ? previousHeight : nextHeight;
  const delta = y - startY;
  const direction = delta < 0 ? -1 : 1;
  const startCenter = startY + startHeight / 2;
  const nextCenter = y + nextHeight / 2;
  const distance = Math.abs(delta);
  const maxBridgeHeight = Math.min(nav.clientHeight - 10, distance + Math.max(startHeight, nextHeight));
  const bridgeHeight = Math.min(
    maxBridgeHeight,
    Math.max(Math.max(startHeight, nextHeight) + 18, distance * 0.58 + (startHeight + nextHeight) / 2)
  );
  const bridgeY = (startCenter + nextCenter) / 2 - bridgeHeight / 2;
  const stretchHeight = Math.max(startHeight, nextHeight) + Math.min(30, Math.max(10, distance * 0.12));
  const earlyHeight = Math.max(startHeight, nextHeight) + Math.min(18, Math.max(8, distance * 0.06));
  const settleHeight = nextHeight + Math.min(10, Math.max(4, distance * 0.04));
  const earlyCenter = interpolate(startCenter, nextCenter, 0.42);
  const midCenter = interpolate(startCenter, nextCenter, 0.88);
  const trailHeight = Math.min(maxBridgeHeight, Math.max(Math.max(startHeight, nextHeight) + 24, distance * 0.52 + (startHeight + nextHeight) / 2));
  const trailY = (startCenter + nextCenter) / 2 - trailHeight / 2;
  const overshoot = y + direction * Math.min(14, Math.max(5, Math.abs(delta) * 0.1));
  const returnY = y - direction * 2;

  nav.style.setProperty("--active-nav-x", `${x}px`);
  nav.style.setProperty("--active-nav-y", `${y}px`);
  nav.style.setProperty("--active-nav-width", `${nextWidth}px`);
  nav.style.setProperty("--active-nav-height", `${nextHeight}px`);
  nav.style.setProperty("--active-nav-direction", `${direction}`);

  if (hasPrevious && Math.abs(delta) > 1) {
    refreshNavTabGlass(nav, nextWidth, stretchHeight);
    nav.classList.remove("is-sliding-nav");
    void nav.offsetWidth;
    nav.classList.add("is-sliding-nav");
    animateNavTabGlass(nav, [
      { offset: 0, x, y: startY, width: nextWidth, height: startHeight, skew: 0, pull: 0, opacity: 0.9, saturate: 1, glint: -22 * direction, glintOpacity: 0.06, edgeAlpha: 0.18, trailX: x + 7, trailY: startY, trailWidth: Math.max(1, nextWidth - 14), trailHeight: startHeight, trailOpacity: 0, trailBlur: 9 },
      { offset: 0.16, x, y: earlyCenter - earlyHeight / 2, width: nextWidth, height: earlyHeight, skew: -4.8 * direction, pull: 0.82, opacity: 0.96, saturate: 1.07, glint: -7 * direction, glintOpacity: 0.1, edgeAlpha: 0.25, trailX: x + 7, trailY: bridgeY, trailWidth: Math.max(1, nextWidth - 14), trailHeight: bridgeHeight, trailOpacity: 0.025, trailBlur: 13 },
      { offset: 0.38, x, y: midCenter - stretchHeight / 2, width: nextWidth, height: stretchHeight, skew: -2.8 * direction, pull: 0.95, opacity: 0.98, saturate: 1.1, glint: 16 * direction, glintOpacity: 0.13, edgeAlpha: 0.31, trailX: x + 7, trailY, trailWidth: Math.max(1, nextWidth - 14), trailHeight, trailOpacity: 0.034, trailBlur: 16 },
      { offset: 0.64, x, y: overshoot, width: nextWidth, height: settleHeight, skew: 3.2 * direction, pull: 0.55, opacity: 0.96, saturate: 1.06, glint: 22 * direction, glintOpacity: 0.1, edgeAlpha: 0.25, trailX: x + 7, trailY: trailY + direction * 16, trailWidth: Math.max(1, nextWidth - 14), trailHeight: Math.max(nextHeight + 24, trailHeight * 0.54), trailOpacity: 0.018, trailBlur: 14 },
      { offset: 0.84, x, y: returnY, width: nextWidth, height: nextHeight + 4, skew: -1.1 * direction, pull: 0.18, opacity: 0.92, saturate: 1.03, glint: 6 * direction, glintOpacity: 0.08, edgeAlpha: 0.21, trailX: x + 7, trailY: y, trailWidth: Math.max(1, nextWidth - 14), trailHeight: nextHeight, trailOpacity: 0.01, trailBlur: 10 },
      { offset: 1, x, y, width: nextWidth, height: nextHeight, skew: 0, pull: 0, opacity: 0.9, saturate: 1, glint: 0, glintOpacity: 0.06, edgeAlpha: 0.18, trailX: x + 7, trailY: y, trailWidth: Math.max(1, nextWidth - 14), trailHeight: nextHeight, trailOpacity: 0, trailBlur: 9 }
    ]);
    clearTimeout(app.navTabMotionTimer);
    app.navTabMotionTimer = setTimeout(() => nav.classList.remove("is-sliding-nav"), NAV_TAB_ANIMATION_MS + 80);
  } else {
    refreshNavTabGlass(nav, nextWidth, nextHeight);
  }
}

function monthUsage() {
  const month = new Date().toISOString().slice(0, 7);
  return (app.state?.usage || []).filter((row) => row.date?.startsWith(month));
}

function usageSummary(rows = monthUsage()) {
  return rows.reduce(
    (acc, row) => {
      acc.tokens += row.totalTokens || 0;
      acc.costUsd += row.costUsd || 0;
      return acc;
    },
    { tokens: 0, costUsd: 0 }
  );
}

function kickActiveViewPanelsRepaint() {
  const panels = $$(ACTIVE_VIEW_PANEL_SELECTOR);
  if (!panels.length) return;

  panels.forEach((panel) => {
    panel.classList.remove("is-view-repaint-kick");
    void panel.offsetHeight;
    panel.classList.add("is-view-repaint-kick");
    panel.style.setProperty("transform", "translate3d(0, 0, 0.01px)", "important");
  });

  requestAnimationFrame(() => {
    panels.forEach((panel) => {
      panel.style.setProperty("transform", "translate3d(0, 0, 0)", "important");
    });
    requestAnimationFrame(() => {
      panels.forEach((panel) => {
        panel.classList.remove("is-view-repaint-kick");
        panel.style.removeProperty("transform");
      });
    });
  });
}

function scheduleActiveViewPanelsRepaint(view) {
  app.viewRepaintTimers.forEach((timer) => clearTimeout(timer));
  app.viewRepaintTimers = [];

  if (view === "overview") return;

  app.viewRepaintTimers = VIEW_REPAINT_DELAYS_MS.map((delay) => {
    const timer = setTimeout(() => {
      app.viewRepaintTimers = app.viewRepaintTimers.filter((item) => item !== timer);
      kickActiveViewPanelsRepaint();
    }, delay);
    return timer;
  });
}

function switchView(view) {
  if (view === "chat") view = "overview";
  if (view === "platform") view = "profile";
  if (!$(`#view-${view}`)) view = "overview";
  app.activeView = view;
  const matchingNavItem = $(`.nav-item[data-view="${view}"]`);
  if (matchingNavItem) {
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item === matchingNavItem));
  }
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
  const active = $(`#view-${view}`);
  const title = $("#viewTitle");
  const eyebrow = $("#viewEyebrow");
  if (title) title.textContent = active?.dataset.title || "ModelHub 工作台";
  if (eyebrow) eyebrow.textContent = active?.dataset.eyebrow || "Overview";
  $(".sidebar")?.classList.remove("open");
  requestAnimationFrame(syncNavTabIndicator);
  requestAnimationFrame(renderCharts);
  scheduleActiveViewPanelsRepaint(view);
}

function render() {
  renderAuthPanel();
  if (!app.state) return;
  renderMetrics();
  renderOverview();
  renderModels();
  renderChatModeControls();
  renderChat();
  renderKeys();
  renderUsageControls();
  renderPrompts();
  renderKnowledge();
  renderBatch();
  renderPlatform();
  renderCharts();
  requestAnimationFrame(syncNavTabIndicator);
  updatePoller();
}

function renderMetrics() {
  const summary = usageSummary();
  const fxRate = app.state.settings.fxRate || 7.25;
  const healthy = app.state.keys.filter((key) => key.health?.status === "ok").length;
  const checked = app.state.keys.filter((key) => key.lastCheckedAt).length;
  const budget = Number(app.state.settings.budgetUsd || 0);
  const percent = budget ? Math.round((summary.costUsd / budget) * 100) : 0;
  const setMetric = (selector, value) => {
    const node = $(selector);
    if (node) node.textContent = value;
  };

  setMetric("#metricSpend", formatUsd(summary.costUsd));
  setMetric("#metricSpendCny", `约 ${formatCny(summary.costUsd * fxRate)}`);
  setMetric("#metricTokens", formatNumber(summary.tokens));
  setMetric("#metricHealthyKeys", `${healthy}/${app.state.keys.length}`);
  setMetric("#metricKeyHint", checked ? `${checked} 个已检测` : "等待健康检测");
  setMetric("#metricBudgetRisk", percent >= 90 ? "高" : percent >= 70 ? "中" : "低");
  setMetric("#metricBudgetDetail", budget ? `已用 ${percent}% / ${formatUsd(budget)}` : "月度预算未设置");
  setMetric("#sidebarBudget", budget ? `预算 ${percent}%` : "预算健康");
}

function renderOverview() {
  const modelStrip = $("#overviewModelStrip");
  if (modelStrip) {
    modelStrip.innerHTML = app.state.models
      .map((model, index) => `<span class="model-pill ${index < 3 ? "active" : ""}">${escapeHtml(model.name)} · ${escapeHtml(model.provider)}</span>`)
      .join("");
  }

  const overviewCompare = $("#overviewCompare");
  if (overviewCompare) {
    const samples = app.state.models.slice(0, 3).map((model) => ({
      model,
      text: `${model.style}。适合在同一问题下快速比较语气、成本和上下文处理能力。`
    }));
    overviewCompare.innerHTML = samples
      .map(
        ({ model, text }) => `
          <article class="answer-card">
            <header>
              <strong>${escapeHtml(model.name)}</strong>
              <span class="mini-pill">${formatUsd(model.outputPerMillion)}/1M out</span>
            </header>
            <p>${escapeHtml(text)}</p>
          </article>
        `
      )
      .join("");
  }

  const health = app.state.keys.length
    ? app.state.keys
    : [{ provider: "OpenAI", name: "等待添加密钥", health: { status: "warn", label: "未配置", detail: "添加 API Key 后可检测" }, balanceUsd: 0 }];
  const overviewHealth = $("#overviewHealth");
  if (overviewHealth) {
    overviewHealth.innerHTML = health
      .slice(0, 5)
      .map(
        (key) => `
          <div class="health-row">
            <div>
              <strong>${escapeHtml(key.provider)} / ${escapeHtml(key.name)}</strong>
              <small>${escapeHtml(key.health?.detail || "等待检测")}</small>
            </div>
            <span class="status-pill ${key.health?.status || "warn"}">${escapeHtml(key.health?.label || "未知")}</span>
          </div>
        `
      )
      .join("");
  }

  const jobs = app.state.jobs.length
    ? app.state.jobs.slice(0, 4)
    : [{ type: "摘要", modelName: "GPT-4.1", progress: 0, status: "queued", createdAt: new Date().toISOString() }];
  const overviewTasks = $("#overviewTasks");
  if (overviewTasks) {
    overviewTasks.innerHTML = jobs
      .map(
        (job) => `
          <div class="timeline-row">
            <div>
              <strong>${escapeHtml(job.type)} · ${escapeHtml(job.modelName)}</strong>
              <small>${job.progress}% · ${escapeHtml(job.status)} · ${relativeTime(job.createdAt)}</small>
            </div>
            <div class="progress-track" aria-label="任务进度"><span style="--progress:${job.progress}%"></span></div>
          </div>
        `
      )
      .join("");
  }

  const overviewPrompts = $("#overviewPrompts");
  if (overviewPrompts) {
    overviewPrompts.innerHTML = app.state.prompts
      .filter((prompt) => prompt.favorite || prompt.official)
      .slice(0, 4)
      .map(
        (prompt) => `
          <button class="quick-prompt" type="button" data-use-prompt="${prompt.id}">
            <strong>${escapeHtml(prompt.title)}</strong><br>
            <small>${escapeHtml(prompt.category)} · ${prompt.official ? "官方" : "自定义"}</small>
          </button>
        `
      )
      .join("");
  }
}

function renderModels() {
  const tabs = $("#modelTabs");
  normalizeActiveModelId();

  if (tabs) {
    tabs.innerHTML = `
      <span class="model-tab-trail" aria-hidden="true"></span>
      <span class="model-tab-glass" aria-hidden="true"></span>
      ${app.state.models
        .map(
          (model) => `
          <button class="${model.id === app.activeModelId ? "active" : ""}" type="button" data-model-id="${model.id}" aria-pressed="${model.id === app.activeModelId}">
            ${escapeHtml(model.name)}
          </button>
        `
        )
        .join("")}
    `;
    requestAnimationFrame(syncModelTabIndicator);
  }

  const activeModelLabel = $("#activeModelLabel");
  if (activeModelLabel) activeModelLabel.textContent = selectedModel()?.name || "选择模型";
}

function renderChatModeControls() {
  const sharedMode = $("#sharedChatMode");
  if (sharedMode && document.activeElement !== sharedMode) {
    sharedMode.checked = Boolean(app.sharedChat);
  }
}

function updateModelTabState() {
  const tabs = $("#modelTabs");
  if (!tabs) {
    renderModels();
    return;
  }

  $$("button[data-model-id]", tabs).forEach((button) => {
    const active = button.dataset.modelId === app.activeModelId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const activeModelLabel = $("#activeModelLabel");
  if (activeModelLabel) activeModelLabel.textContent = selectedModel()?.name || "选择模型";
  syncModelTabIndicator();
  renderChat();
}

function suppressNextModelClick() {
  app.suppressNextModelClick = true;
  clearTimeout(app.suppressModelClickTimer);
  app.suppressModelClickTimer = setTimeout(() => {
    app.suppressNextModelClick = false;
  }, 120);
}

function handleModelTabPointerDown(event) {
  if (event.button !== 0) return;
  const tabs = event.currentTarget;
  const button = event.target.closest("button[data-model-id]");
  if (!tabs || !button || !tabs.contains(button)) return;

  tabs.setPointerCapture?.(event.pointerId);
  app.modelTabDrag = {
    pointerId: event.pointerId,
    tabs,
    startX: event.clientX,
    startY: event.clientY,
    startModelId: app.activeModelId,
    lastTarget: button,
    didMove: false
  };
}

function handleModelTabPointerMove(event) {
  const drag = app.modelTabDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (event.buttons === 0) {
    finishModelTabDrag(event, true);
    return;
  }

  const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (moved <= 4 && !drag.didMove) return;
  if (!drag.didMove) {
    drag.didMove = true;
    cancelModelTabMotion();
    drag.tabs.classList.remove("is-sliding");
    drag.tabs.classList.add("is-dragging");
  }

  event.preventDefault();
  const target = applyModelTabDragFrame(drag.tabs, event);
  if (!target) return;
  drag.lastTarget = target;
  setModelTabActiveState(target.dataset.modelId);
}

function finishModelTabDrag(event, commit) {
  const drag = app.modelTabDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;

  const { tabs } = drag;
  tabs.releasePointerCapture?.(event.pointerId);
  tabs.classList.remove("is-dragging");
  app.modelTabDrag = null;

  if (!drag.didMove) {
    if (commit && drag.lastTarget?.dataset.modelId && drag.lastTarget.dataset.modelId !== app.activeModelId) {
      suppressNextModelClick();
      setModelTabActiveState(drag.lastTarget.dataset.modelId);
      syncModelTabIndicator();
      refreshModelTabGlass(tabs, drag.lastTarget.offsetWidth, drag.lastTarget.offsetHeight);
      renderChat();
    }
    return;
  }

  suppressNextModelClick();

  if (!commit) {
    setModelTabActiveState(drag.startModelId);
    clearModelTabInlineMotion(tabs);
    syncModelTabIndicator();
    renderChat();
    return;
  }

  const target = modelTabButtonFromClientX(tabs, event.clientX) || drag.lastTarget;
  if (!target) {
    clearModelTabInlineMotion(tabs);
    syncModelTabIndicator();
    return;
  }

  setModelTabActiveState(target.dataset.modelId);
  settleDraggedModelTab(tabs, target);
  refreshModelTabGlass(tabs, target.offsetWidth, target.offsetHeight);
  renderChat();
}

function renderChat() {
  const conversation = sanitizeConversationMessages(currentConversation());
  const title = $("#conversationTitle");
  if (title) title.textContent = conversation.title || "新会话";
  const turns = conversation.messages.filter((message) => message.role === "user").length;
  const stats = $("#conversationStats");
  if (stats) stats.textContent = `${turns} 轮对话`;

  const history = $("#chatHistory");
  if (!history) return;
  if (!conversation.messages.length) {
    const isHydratingHistory = Boolean(app.auth.session?.access_token && app.state?.backend?.dataBackend === "loading");
    if (isHydratingHistory) {
      history.innerHTML = `
        <div class="empty-state chat-empty chat-empty-loading">
          <strong>正在同步历史对话</strong>
          <span>稍等一下，正在恢复上次聊天。</span>
        </div>
      `;
      return;
    }
    history.innerHTML = `
      <div class="empty-state chat-empty">
        <strong>今天想问什么？</strong>
        <span>输入一个问题后，可以单模型回复，也可以打开“并排对比”一次发送给多个模型。</span>
      </div>
    `;
  } else {
    history.innerHTML = groupMessages(conversation.messages)
      .map((group) => {
        if (group.type === "user") {
          return `
            <div class="message user">
              <div class="message-meta">你 · ${relativeTime(group.message.createdAt)}</div>
              <div class="message-bubble">${renderMessageText(group.message.content)}</div>
            </div>
          `;
        }
        if (group.messages.length > 1) {
          return `
            <div class="message compare">
              ${group.messages.map(renderAnswerCard).join("")}
            </div>
          `;
        }
        const message = group.messages[0];
        return `
          <div class="message">
            <div class="message-meta">${escapeHtml(messageModelName(message))} · ${providerStatusLabel(message)} · ${relativeTime(message.createdAt)}</div>
            <div class="message-bubble">${renderMessageText(message.content)}</div>
          </div>
        `;
      })
      .join("");
    history.scrollTop = history.scrollHeight;
  }

}

function groupMessages(messages) {
  const groups = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message.role === "user") {
      groups.push({ type: "user", message });
      index += 1;
      continue;
    }
    const assistants = [];
    while (messages[index] && messages[index].role === "assistant") {
      assistants.push(messages[index]);
      index += 1;
    }
    groups.push({ type: "assistant", messages: assistants });
  }
  return groups;
}

function messageModelName(message) {
  if (!message) return "";
  const models = app.state?.models?.length ? app.state.models : BOOTSTRAP_MODELS;
  const model = models.find((item) => item.id === message.modelId || item.id === message.modelName);
  if (model) return model.name;
  const modelLabel = String(message.modelId || message.modelName || "");
  if (modelLabel.startsWith("qwen2.5:") || modelLabel.startsWith("llama3.2:")) {
    return localOllamaModel()?.name || "Qwen2.5 3B";
  }
  return message.modelName || message.modelId || "";
}

function providerStatusLabel(message) {
  const status = String(message?.providerStatus || "").toLowerCase();
  if (status === "live") return "真实调用";
  if (status === "blocked") return "策略拦截";
  if (status === "error") return "调用失败";
  if (status === "simulated") return "模拟回复";
  return "状态未知";
}

function renderAnswerCard(message) {
  return `
    <article class="answer-card">
      <header>
        <strong>${escapeHtml(messageModelName(message))}</strong>
        <span class="mini-pill">${escapeHtml(message.provider)}</span>
        <span class="mini-pill">${providerStatusLabel(message)}</span>
      </header>
      <p>${renderMessageText(message.content)}</p>
    </article>
  `;
}

function renderKeys() {
  const policies = app.state.settings.securityPolicies || {};
  const setChecked = (selector, value) => {
    const node = $(selector);
    if (node && document.activeElement !== node) node.checked = Boolean(value);
  };
  setChecked("#encryptedOnlyToggle", policies.encryptedOnly ?? true);
  setChecked("#noSecretLogsToggle", policies.noSecretLogs ?? true);
  setChecked("#balanceAlertsToggle", policies.balanceAlerts ?? true);

  const rows = app.state.keys.length
    ? app.state.keys
        .map(
          (key) => `
            <tr>
              <td>${escapeHtml(key.provider)}</td>
              <td>${escapeHtml(key.name)}</td>
              <td>${escapeHtml(key.preview)}<br><small>${escapeHtml(key.fingerprint)}</small></td>
              <td><span class="status-pill ${key.health?.status || "warn"}">${escapeHtml(key.health?.label || "未检测")}</span></td>
              <td>${key.balanceUsd == null ? "不适用" : formatUsd(key.balanceUsd)}</td>
              <td>${relativeTime(key.lastCheckedAt)}</td>
              <td>
                <div class="row-actions">
                  <button type="button" data-check-key="${key.id}">检测</button>
                  <button type="button" data-delete-key="${key.id}">删除</button>
                </div>
              </td>
            </tr>
          `
        )
        .join("")
    : `<tr><td colspan="7">还没有密钥。添加后会以 AES-256-GCM 密文写入本地数据库。</td></tr>`;
  $("#keysTable").innerHTML = rows;
}

function renderUsageControls() {
  const fx = $("#fxRateInput");
  const budget = $("#budgetInput");
  if (document.activeElement !== fx) fx.value = app.state.settings.fxRate;
  if (document.activeElement !== budget) budget.value = app.state.settings.budgetUsd;

  const summary = usageSummary();
  const budgetUsd = Number(app.state.settings.budgetUsd || 0);
  const percent = budgetUsd ? Math.min(100, Math.round((summary.costUsd / budgetUsd) * 100)) : 0;
  const color = percent >= 90 ? "var(--red)" : percent >= 70 ? "var(--amber)" : "var(--teal)";

  $("#budgetRing").style.background = `conic-gradient(${color} ${percent * 3.6}deg, var(--line) 0deg)`;
  $("#budgetPercent").textContent = `${percent}%`;
  $("#budgetMessage").textContent = budgetUsd
    ? `本月已消耗 ${formatUsd(summary.costUsd)}，折合 ${formatCny(summary.costUsd * app.state.settings.fxRate)}。`
    : "设置月预算后可启用预警。";

  $("#priceList").innerHTML = app.state.models
    .map(
      (model) => `
        <div class="price-row">
          <div>
            <strong>${escapeHtml(model.name)}</strong>
            <small>输入 ${formatUsd(model.inputPerMillion)} / 输出 ${formatUsd(model.outputPerMillion)} 每 100 万 tokens</small>
          </div>
          <span class="mini-pill">${escapeHtml(model.provider)}</span>
        </div>
      `
    )
    .join("");
}

function renderPrompts() {
  $("#promptGrid").innerHTML = app.state.prompts
    .map(
      (prompt) => {
        const isFavorite = Boolean(prompt.favorite);
        const isPending = app.favoritePendingIds.has(prompt.id);
        const favoriteLabel = isFavorite ? "已收藏" : "收藏";
        const favoriteAction = isFavorite ? "取消收藏" : "收藏";
        return `
        <article class="prompt-card">
          <header>
            <div>
              <h3>${escapeHtml(prompt.title)}</h3>
              <span class="tag">${escapeHtml(prompt.category)}</span>
            </div>
            <button
              class="favorite-toggle${isFavorite ? " is-on" : ""}${isPending ? " is-saving" : ""}"
              type="button"
              aria-label="${favoriteAction}"
              aria-pressed="${String(isFavorite)}"
              title="${favoriteAction}"
              data-favorite-prompt="${prompt.id}"
              data-favorite-state="${isFavorite ? "on" : "off"}"
              ${isPending ? "aria-busy=\"true\"" : ""}
            >
              <span class="favorite-mark" aria-hidden="true"></span>
              <span class="favorite-text">${favoriteLabel}</span>
            </button>
          </header>
          <p>${escapeHtml(prompt.body)}</p>
          <footer>
            <button class="ghost-button small" type="button" data-edit-prompt="${prompt.id}">编辑</button>
            <button class="primary-button small" type="button" data-use-prompt="${prompt.id}">使用</button>
          </footer>
        </article>
      `;
      }
    )
    .join("");

  $$("#promptGrid .prompt-card").forEach((card) => {
    const button = card.querySelector("[data-favorite-prompt]");
    if (!button) return;
    const isFavorite = button.dataset.favoriteState === "on";
    card.classList.toggle("is-favorite", isFavorite);
  });
}

function flashFavoriteAuthRequired(button) {
  if (!button) return;
  button.classList.remove("is-denied");
  void button.offsetWidth;
  button.classList.add("is-denied");
  window.setTimeout(() => button.classList.remove("is-denied"), 420);
}

function applyPromptUpdate(prompt) {
  if (!prompt) return;
  const index = app.state.prompts.findIndex((item) => item.id === prompt.id);
  if (index >= 0) {
    app.state.prompts[index] = {
      ...app.state.prompts[index],
      ...prompt,
      id: app.state.prompts[index].id
    };
  } else {
    app.state.prompts.unshift(prompt);
  }
  renderPrompts();
  renderOverview();
}

function renderKnowledge() {
  const list = $("#knowledgeList");
  if (!list) return;
  const documents = app.state.knowledgeBases.flatMap((kb) =>
    kb.documents.map((doc) => ({
      ...doc,
      kbName: kb.name,
      kbUpdatedAt: kb.updatedAt
    }))
  );
  list.innerHTML = documents.length
    ? documents
        .slice(0, 6)
        .map(
          (doc) => `
            <article class="kb-card">
              <header>
                <h3>${escapeHtml(doc.name)}</h3>
                <span class="mini-pill">${doc.chunkCount} 段</span>
              </header>
              <small>${escapeHtml(doc.kbName)} · ${formatNumber(doc.size)} bytes · ${relativeTime(doc.updatedAt || doc.kbUpdatedAt)}</small>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">还没有资料。粘贴一段内容即可开始。</div>`;
}

function renderBatch() {
  const latest = app.selectedJobId
    ? app.state.jobs.find((job) => job.id === app.selectedJobId)
    : app.state.jobs[0];
  if (latest) app.selectedJobId = latest.id;

  const status = $("#batchStatus");
  if (status) {
    status.textContent = latest
      ? `${latest.type} · ${latest.modelName} · ${latest.progress}% · ${latest.status}`
      : "输入多行文本后开始处理。";
  }

  const results = $("#batchResults");
  if (!results) return;
  results.innerHTML = latest
    ? latest.results
        .map(
          (row) => `
            <tr>
              <td>${row.id}</td>
              <td>${escapeHtml(row.input)}</td>
              <td>${escapeHtml(row.result || "-")}</td>
              <td><span class="status-pill ${row.status === "completed" ? "ok" : "warn"}">${escapeHtml(row.status)}</span></td>
            </tr>
          `
        )
        .join("")
    : `<tr><td colspan="4">暂无结果</td></tr>`;
}

function renderPlatform() {
  const safetyWords = $("#safetyWords");
  if (document.activeElement !== safetyWords) {
    safetyWords.value = (app.state.settings.safetyWords || []).join(", ");
  }
  $("#safetyToggle").checked = Boolean(app.state.settings.safetyEnabled);
  const identity = app.state.settings.identity || {};
  const setChecked = (selector, value) => {
    const node = $(selector);
    if (node && document.activeElement !== node) node.checked = Boolean(value);
  };
  setChecked("#emailLoginToggle", identity.emailLogin ?? true);
  setChecked("#wechatLoginToggle", identity.wechatLogin ?? false);
  setChecked("#teamSpaceToggle", identity.teamSpace ?? true);
  const activePlan = app.state.settings.billingPlan || "team";
  $$("[data-plan]").forEach((plan) => plan.classList.toggle("selected", plan.dataset.plan === activePlan));
  $("#auditTimeline").innerHTML = app.state.auditLogs
    .slice(0, 10)
    .map(
      (log) => `
        <div class="timeline-row">
          <div>
            <strong>${escapeHtml(log.action)}</strong>
            <small>${escapeHtml(log.actor)} · ${escapeHtml(log.detail)} · ${relativeTime(log.createdAt)}</small>
          </div>
          <span class="mini-pill">audit</span>
        </div>
      `
    )
    .join("");
}

function renderCharts() {
  if (!app.state) return;
  drawSpendChart($("#overviewSpendChart"), app.state.usage);
  drawUsageLineChart($("#usageLineChart"), app.state.usage);
  drawUsageBarChart($("#usageBarChart"), app.state.usage);
}

function setupCanvas(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const minHeight = canvas.id === "usageBarChart" ? 150 : canvas.id === "usageLineChart" ? 170 : 220;
  const width = Math.max(320, Math.round(rect.width || canvas.width || 720));
  const height = Math.max(minHeight, Math.round(rect.height || canvas.height || 260));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function groupedByDate(usage) {
  const map = new Map();
  usage.forEach((row) => {
    const current = map.get(row.date) || { date: row.date, tokens: 0, costUsd: 0 };
    current.tokens += row.totalTokens || 0;
    current.costUsd += row.costUsd || 0;
    map.set(row.date, current);
  });
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date)).slice(-7);
}

function drawAxes(ctx, width, height) {
  ctx.strokeStyle = cssVar("--line");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(44, 18);
  ctx.lineTo(44, height - 34);
  ctx.lineTo(width - 18, height - 34);
  ctx.stroke();
}

function drawSpendChart(canvas, usage) {
  const setup = setupCanvas(canvas);
  if (!setup) return;
  const { ctx, width, height } = setup;
  const data = groupedByDate(usage);
  drawAxes(ctx, width, height);
  if (!data.length) return;
  const max = Math.max(...data.map((row) => row.costUsd), 0.01);
  const step = (width - 78) / Math.max(1, data.length - 1);
  ctx.strokeStyle = cssVar("--teal");
  ctx.lineWidth = 3;
  ctx.beginPath();
  data.forEach((row, index) => {
    const x = 44 + index * step;
    const y = height - 34 - (row.costUsd / max) * (height - 64);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  data.forEach((row, index) => {
    const x = 44 + index * step;
    const y = height - 34 - (row.costUsd / max) * (height - 64);
    ctx.fillStyle = cssVar("--surface");
    ctx.strokeStyle = cssVar("--teal");
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = cssVar("--muted");
    ctx.font = "12px sans-serif";
    ctx.fillText(row.date.slice(5), x - 15, height - 12);
  });
}

function drawUsageLineChart(canvas, usage) {
  const setup = setupCanvas(canvas);
  if (!setup) return;
  const { ctx, width, height } = setup;
  const data = groupedByDate(usage);
  drawAxes(ctx, width, height);
  if (!data.length) return;
  const max = Math.max(...data.map((row) => row.tokens), 1);
  const step = (width - 82) / Math.max(1, data.length - 1);
  ctx.strokeStyle = cssVar("--indigo");
  ctx.lineWidth = 3;
  ctx.beginPath();
  data.forEach((row, index) => {
    const x = 46 + index * step;
    const y = height - 38 - (row.tokens / max) * (height - 72);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = cssVar("--text");
  ctx.font = "13px sans-serif";
  ctx.fillText("Tokens / 7 days", 52, 26);
}

function drawUsageBarChart(canvas, usage) {
  const setup = setupCanvas(canvas);
  if (!setup) return;
  const { ctx, width, height } = setup;
  const byModel = new Map();
  usage.forEach((row) => {
    byModel.set(row.modelName, (byModel.get(row.modelName) || 0) + (row.costUsd || 0));
  });
  const data = Array.from(byModel.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const colors = [cssVar("--teal"), cssVar("--coral"), cssVar("--indigo"), cssVar("--amber")];
  ctx.fillStyle = cssVar("--text");
  ctx.font = "13px sans-serif";
  ctx.fillText("模型成本占比", 18, 24);
  if (!data.length) {
    ctx.fillStyle = cssVar("--muted");
    ctx.font = "12px sans-serif";
    ctx.fillText("暂无用量数据", 18, 48);
    return;
  }

  const total = data.reduce((sum, [, value]) => sum + value, 0) || 1;
  const radius = Math.min(height * 0.34, width * 0.18, 68);
  const cx = Math.max(74, Math.min(width * 0.28, 112));
  const cy = Math.max(88, height * 0.55);
  let start = -Math.PI / 2;

  data.forEach(([name, value], index) => {
    const angle = (value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = colors[index % colors.length];
    ctx.fill();
    start += angle;
  });

  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.54, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
  ctx.fill();

  ctx.fillStyle = cssVar("--text");
  ctx.font = "700 15px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(formatUsd(total), cx, cy + 4);
  ctx.textAlign = "left";

  const legendX = Math.min(width - 190, cx + radius + 34);
  const legendY = Math.max(52, cy - Math.min(58, data.length * 12));
  data.slice(0, 4).forEach(([name, value], index) => {
    const y = legendY + index * 24;
    const percent = Math.round((value / total) * 100);
    ctx.fillStyle = colors[index % colors.length];
    ctx.beginPath();
    ctx.roundRect(legendX, y - 9, 10, 10, 3);
    ctx.fill();
    ctx.fillStyle = cssVar("--text");
    ctx.font = "12px sans-serif";
    ctx.fillText(name.slice(0, 14), legendX + 16, y);
    ctx.fillStyle = cssVar("--muted");
    ctx.fillText(`${percent}%`, legendX + 118, y);
  });
}

function updatePoller() {
  const hasRunning = app.state.jobs.some((job) => job.status === "running");
  if (hasRunning && !app.jobPoller) {
    app.jobPoller = setInterval(refreshState, 1400);
  }
  if (!hasRunning && app.jobPoller) {
    clearInterval(app.jobPoller);
    app.jobPoller = null;
  }
}

function debounce(fn, delay = 450) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const saveSettings = debounce(async () => {
  try {
    await persistSettings();
  } catch (error) {
    toast(error.message);
  }
}, 650);

async function persistSettings() {
  const checked = (selector, fallback = false) => {
    const node = $(selector);
    return node ? node.checked : fallback;
  };
  const payload = {
    fxRate: Number($("#fxRateInput").value || app.state.settings.fxRate),
    budgetUsd: Number($("#budgetInput").value || 0),
    safetyEnabled: $("#safetyToggle").checked,
    safetyWords: $("#safetyWords").value.split(/[,，]/).map((word) => word.trim()).filter(Boolean),
    securityPolicies: {
      encryptedOnly: checked("#encryptedOnlyToggle", true),
      noSecretLogs: checked("#noSecretLogsToggle", true),
      balanceAlerts: checked("#balanceAlertsToggle", true)
    },
    identity: {
      emailLogin: checked("#emailLoginToggle", true),
      wechatLogin: checked("#wechatLoginToggle", false),
      teamSpace: checked("#teamSpaceToggle", true)
    },
    billingPlan: app.state.settings.billingPlan || "team"
  };
  const response = await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
  setState(response.state);
  toast("设置已保存");
}

function formatFileSize(bytes = 0) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function isTextLikeFile(file) {
  const type = String(file.type || "").toLowerCase();
  return (
    type.startsWith("text/") ||
    /\.(txt|md|markdown|json|csv|log|xml|html|css|js|jsx|ts|tsx|py|java|go|rs|sql|yml|yaml)$/i.test(file.name || "")
  );
}

async function prepareChatFile(file) {
  const attachment = {
    name: file.name || "未命名文件",
    type: file.type || "未知类型",
    size: file.size || 0,
    text: "",
    truncated: false
  };

  if (!isTextLikeFile(file)) return attachment;

  try {
    const text = await file.slice(0, MAX_CHAT_FILE_TEXT_CHARS + 1).text();
    attachment.text = text.slice(0, MAX_CHAT_FILE_TEXT_CHARS);
    attachment.truncated = text.length > MAX_CHAT_FILE_TEXT_CHARS || file.size > MAX_CHAT_FILE_TEXT_CHARS;
  } catch {
    attachment.text = "";
  }
  return attachment;
}

function clearPendingChatFiles() {
  app.pendingChatFiles = [];
  const input = $("#chatFileInput");
  if (input) input.value = "";
}

function buildChatMessage(text, files = []) {
  const body = String(text || "").trim();
  if (!files.length) return body;
  const fileBlocks = files.map((file, index) => {
    const header = `附件 ${index + 1}: ${file.name} (${file.type}, ${formatFileSize(file.size)})`;
    if (!file.text) return `${header}\n[该文件不是可直接读取的文本内容，请结合文件信息回答。]`;
    const suffix = file.truncated ? "\n[内容过长，已截取前半部分。]" : "";
    return `${header}\n${file.text}${suffix}`;
  });
  return [body, "请结合下面的文件内容回答：", ...fileBlocks].filter(Boolean).join("\n\n");
}

function downloadFile(filename, content, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  $$(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  const authEmailInput = $("#authEmailInput");
  const authPasswordInput = $("#authPasswordInput");

  const readAuthForm = () => ({
    email: authEmailInput?.value.trim() || "",
    password: authPasswordInput?.value || ""
  });

  const ensureAuthForm = () => {
    const { email, password } = readAuthForm();
    if (!email || !password) {
      toast("请填写邮箱和密码");
      return null;
    }
    return { email, password };
  };

  const handleSignIn = async (control = $("#authSignInButton")) => {
    const payload = ensureAuthForm();
    if (!payload) return;
    await runControl(control, "登录中", async () => {
      await signInWithSupabase(payload.email, payload.password);
      if (authPasswordInput) authPasswordInput.value = "";
      await refreshState();
      toast("登录成功");
    });
  };

  const handleSignUp = async (control = $("#authSignUpButton")) => {
    const payload = ensureAuthForm();
    if (!payload) return;
    await runControl(control, "注册中", async () => {
      const response = await signUpWithSupabase(payload.email, payload.password);
      if (authPasswordInput) authPasswordInput.value = "";
      if (response.access_token || response.session?.access_token) {
        await refreshState();
        toast("注册成功，已自动登录");
        return;
      }
      toast("注册成功，请查收邮箱完成验证");
    });
  };

  const handleSignOut = async (control = $("#authSignOutButton")) => {
    await runControl(control, "退出中", async () => {
      await signOutWithSupabase();
      if (authPasswordInput) authPasswordInput.value = "";
      await refreshState();
      toast("已退出登录");
    });
  };

  $("#authPanel")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleSignIn(event.submitter || $("#authSignInButton"));
  });
  $("#authSignInButton")?.addEventListener("click", async () => handleSignIn());
  $("#authSignUpButton")?.addEventListener("click", async () => handleSignUp());
  $("#authSignOutButton")?.addEventListener("click", async () => handleSignOut());
  $("#accountSignOutButton")?.addEventListener("click", async () => {
    await runControl($("#accountSignOutButton"), "退出中", async () => {
      await signOutWithSupabase();
      await refreshState();
      toast("已退出登录");
    });
  });
  $("#profileSignOutButton")?.addEventListener("click", async () => {
    await runControl($("#profileSignOutButton"), "退出中", async () => {
      await signOutWithSupabase();
      await refreshState();
      toast("已退出登录");
    });
  });

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target) return;

    try {
    if (target.dataset.viewJump) {
      switchView(target.dataset.viewJump);
    }

    if (target.dataset.modelId) {
      if (app.suppressNextModelClick) {
        app.suppressNextModelClick = false;
        clearTimeout(app.suppressModelClickTimer);
        event.preventDefault();
        return;
      }
      app.activeModelId = normalizeModelId(target.dataset.modelId);
      updateModelTabState();
    }

    if (target.dataset.quickChat) {
      $("#chatInput").value = target.dataset.quickChat;
      $("#chatInput").focus();
      $("#estimatedTokens").textContent = `预计 ${estimateTokens($("#chatInput").value)} tokens`;
    }

    if (target.dataset.usePrompt) {
      const prompt = app.state.prompts.find((item) => item.id === target.dataset.usePrompt);
      if (prompt) {
        switchView("overview");
        $("#chatInput").value = `${prompt.body}\n\n`;
        $("#chatInput").focus();
        toast(`已插入：${prompt.title}`);
      }
    }

    if (target.dataset.favoritePrompt) {
      const prompt = app.state.prompts.find((item) => item.id === target.dataset.favoritePrompt);
      if (!prompt) return;
      if (app.favoritePendingIds.has(prompt.id)) return;
      const nextFavorite = !prompt.favorite;
      if (!app.auth.user) {
        flashFavoriteAuthRequired(target);
        toast(nextFavorite ? "请先登录后再收藏提示词" : "请先登录后再取消收藏");
        return;
      }
      const previousPrompt = { ...prompt };
      app.favoritePendingIds.add(prompt.id);
      applyPromptUpdate({ ...prompt, favorite: nextFavorite });
      toast(nextFavorite ? "已收藏" : "已取消收藏");
      try {
        const response = await api(`/api/prompts/${prompt.id}`, {
          method: "PATCH",
          body: JSON.stringify({ favorite: nextFavorite })
        });
        app.favoritePendingIds.delete(prompt.id);
        if (response.state) setState(response.state);
        else applyPromptUpdate(response.prompt);
      } catch (error) {
        app.favoritePendingIds.delete(prompt.id);
        applyPromptUpdate(previousPrompt);
        if (error.status === 401) {
          clearAuthSession();
          const currentButton = $(`[data-favorite-prompt="${CSS.escape(prompt.id)}"]`);
          flashFavoriteAuthRequired(currentButton);
          toast(nextFavorite ? "请先登录后再收藏提示词" : "请先登录后再取消收藏");
          return;
        }
        toast(error.message || "收藏状态保存失败");
      }
    }

    if (target.dataset.editPrompt) {
      const prompt = app.state.prompts.find((item) => item.id === target.dataset.editPrompt);
      if (!prompt) return;
      app.editingPromptId = prompt.id;
      $("#promptTitleInput").value = prompt.title;
      $("#promptCategoryInput").value = prompt.category;
      $("#promptBodyInput").value = prompt.body;
      toast("已载入提示词，可编辑后保存");
    }

    if (target.dataset.checkKey) {
      await runControl(target, "检测中", async () => {
        const response = await api(`/api/keys/${target.dataset.checkKey}/check`, { method: "POST", body: "{}" });
        setState(response.state);
        toast("健康检测完成");
      });
    }

    if (target.dataset.deleteKey) {
      if (!window.confirm("确定删除这个密钥吗？删除后无法恢复。")) return;
      await runControl(target, "删除中", async () => {
        const response = await api(`/api/keys/${target.dataset.deleteKey}`, { method: "DELETE" });
        setState(response.state);
        toast("密钥已删除");
      });
    }

    if (target.dataset.plan) {
      app.state.settings.billingPlan = target.dataset.plan;
      $$("[data-plan]").forEach((plan) => plan.classList.toggle("selected", plan.dataset.plan === target.dataset.plan));
      await runControl(target, "保存中", async () => {
        await persistSettings();
      });
    }
    } catch (error) {
      toast(error.message || "操作失败");
    }
  });

  $(".mobile-menu")?.addEventListener("click", () => $(".sidebar")?.classList.toggle("open"));
  $("#themeToggle")?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("modelhub-theme", next);
    requestAnimationFrame(syncNavTabIndicator);
    renderCharts();
  });

  $("#sharedChatMode")?.addEventListener("change", (event) => {
    app.sharedChat = Boolean(event.target.checked);
    localStorage.setItem(CHAT_SHARED_MODE_KEY, app.sharedChat ? "true" : "false");
    renderChatModeControls();
    renderChat();
  });

  $("#chatInput").addEventListener("input", (event) => {
    $("#estimatedTokens").textContent = `预计 ${estimateTokens(event.target.value)} tokens`;
  });

  $("#chatInput").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  });

  $("#chatForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter || event.currentTarget.querySelector("button[type='submit']");
    const input = $("#chatInput");
    const typedMessage = input.value.trim();
    const files = app.pendingChatFiles || [];
    if (!typedMessage && !files.length) return;
    if (!app.auth.user) {
      redirectToSignIn(typedMessage);
      return;
    }
    const message = buildChatMessage(typedMessage, files);
    const compare = $("#compareMode").checked;
    const activeModelId = normalizeActiveModelId();
    const scopeKey = activeConversationScopeKey();
    const conversation = currentConversation(scopeKey);
    const modelIds = compare
      ? [activeModelId, ...selectableModels().map((model) => model.id).filter((id) => id !== activeModelId)].slice(0, 3)
      : [activeModelId];
    const conversationId = conversation.id;
    const needsNewConversation = !conversationId || String(conversationId).startsWith("pending:");
    input.value = "";
    $("#estimatedTokens").textContent = "预计 0 tokens";
    const optimisticMessage = appendOptimisticUserMessage(message, conversationId, scopeKey);
    const sent = await runControl(submitter, "发送中", async () => {
      const response = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          conversationId: needsNewConversation ? null : conversationId,
          conversationScope: scopeKey,
          conversationTitle: conversationTitleForScope(scopeKey),
          forceNewConversation: needsNewConversation,
          message,
          modelIds
        })
      });
      applyChatResponse(response, scopeKey);
      scheduleStateRefresh();
      return true;
    });
    if (sent) {
      clearPendingChatFiles();
    } else {
      removeOptimisticMessage(optimisticMessage);
      input.value = typedMessage;
      $("#estimatedTokens").textContent = `预计 ${estimateTokens(message)} tokens`;
    }
  });

  $("#clearChat").addEventListener("click", async () => {
    if (!window.confirm("确定清空当前会话吗？")) return;
    const scopeKey = activeConversationScopeKey();
    const conversation = currentConversation(scopeKey);
    if (!conversation.id || String(conversation.id).startsWith("pending:")) {
      clearConversationLocally(scopeKey);
      return;
    }
    await runControl($("#clearChat"), "清空中", async () => {
      const response = await api(`/api/conversations/${conversation.id}`, { method: "DELETE" });
      setState(response.state);
      clearCachedConversation(scopeKey);
      toast("会话已清空");
    });
  });

  $("#chatAttachButton")?.addEventListener("click", () => {
    $("#chatFileInput")?.click();
  });

  $("#chatFileInput")?.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []).slice(0, MAX_CHAT_FILE_COUNT);
    if (!files.length) {
      clearPendingChatFiles();
      return;
    }
    app.pendingChatFiles = await Promise.all(files.map(prepareChatFile));
    $("#chatInput")?.focus();
    toast(`已选择 ${app.pendingChatFiles.length} 个文件，点击发送`);
  });

  const modelTabs = $("#modelTabs");
  modelTabs?.addEventListener("pointerdown", handleModelTabPointerDown);
  modelTabs?.addEventListener("pointermove", handleModelTabPointerMove);
  modelTabs?.addEventListener("pointerup", (event) => finishModelTabDrag(event, true));
  modelTabs?.addEventListener("pointercancel", (event) => finishModelTabDrag(event, false));
  modelTabs?.addEventListener("lostpointercapture", (event) => finishModelTabDrag(event, true));
  modelTabs?.addEventListener("scroll", syncModelTabIndicator, { passive: true });
  window.addEventListener("resize", () => requestAnimationFrame(syncModelTabIndicator));
  window.addEventListener("resize", () => requestAnimationFrame(syncNavTabIndicator));

  $("#keyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter || event.currentTarget.querySelector("button[type='submit']");
    const payload = {
      provider: $("#providerInput").value,
      name: $("#keyNameInput").value.trim(),
      apiKey: $("#apiKeyInput").value.trim(),
      passphrase: $("#vaultPassInput").value
    };
    if (!payload.name || !payload.apiKey) {
      toast("请填写密钥名称和 API Key");
      return;
    }
    await runControl(submitter, "保存中", async () => {
      const response = await api("/api/keys", { method: "POST", body: JSON.stringify(payload) });
      setState(response.state);
      event.currentTarget.reset();
      toast("密钥已加密保存");
    });
  });

  $("#checkAllKeys").addEventListener("click", async () => {
    if (!app.state.keys.length) {
      toast("还没有可检测的密钥");
      return;
    }
    await runControl($("#checkAllKeys"), "检测中", async () => {
      const response = await api("/api/keys/check-all", { method: "POST", body: "{}" });
      setState(response.state);
      toast("批量检测完成");
    });
  });

  $("#fxRateInput").addEventListener("input", saveSettings);
  $("#budgetInput").addEventListener("input", saveSettings);
  $("#safetyWords").addEventListener("input", saveSettings);
  $("#safetyToggle").addEventListener("change", saveSettings);
  [
    "#encryptedOnlyToggle",
    "#noSecretLogsToggle",
    "#balanceAlertsToggle",
    "#emailLoginToggle",
    "#wechatLoginToggle",
    "#teamSpaceToggle"
  ].forEach((selector) => $(selector)?.addEventListener("change", saveSettings));

  $("#promptForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter || event.currentTarget.querySelector("button[type='submit']");
    const payload = {
      title: $("#promptTitleInput").value.trim(),
      category: $("#promptCategoryInput").value,
      body: $("#promptBodyInput").value.trim()
    };
    if (!payload.title || !payload.body) {
      toast("请填写标题和提示词内容");
      return;
    }
    const path = app.editingPromptId ? `/api/prompts/${app.editingPromptId}` : "/api/prompts";
    const method = app.editingPromptId ? "PATCH" : "POST";
    await runControl(submitter, "保存中", async () => {
      const response = await api(path, { method, body: JSON.stringify(payload) });
      app.editingPromptId = null;
      event.currentTarget.reset();
      setState(response.state);
      toast("提示词已保存");
    });
  });

  $("#exportPrompts").addEventListener("click", () => {
    const content = JSON.stringify(app.state.prompts, null, 2);
    downloadFile("modelhub-prompts.json", content);
  });

  $("#importPrompts").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const content = await file.text();
      const prompts = JSON.parse(content);
      const list = Array.isArray(prompts) ? prompts : prompts.prompts;
      if (!Array.isArray(list)) throw new Error("导入文件需要是提示词数组或包含 prompts 数组");
      const response = await api("/api/prompts/import", {
        method: "POST",
        body: JSON.stringify({ prompts: list })
      });
      setState(response.state);
      toast("提示词已导入");
    } catch (error) {
      toast(error.message || "导入失败");
    } finally {
      event.target.value = "";
    }
  });

  $("#knowledgeForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter || event.currentTarget.querySelector("button[type='submit']");
    const text = $("#knowledgeTextInput").value.trim();
    if (!text) {
      toast("请先粘贴资料内容");
      return;
    }
    const name = $("#knowledgeNameInput").value.trim() || `资料 ${app.state.knowledgeBases[0]?.documents.length + 1 || 1}`;
    await runControl(submitter, "入库中", async () => {
      const response = await api("/api/knowledge/documents", {
        method: "POST",
        body: JSON.stringify({
          name,
          type: "text/plain",
          size: text.length,
          text
        })
      });
      $("#knowledgeNameInput").value = "";
      $("#knowledgeTextInput").value = "";
      setState(response.state);
      toast("资料已加入知识库");
    });
  });

  $("#qaForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter || event.currentTarget.querySelector("button[type='submit']");
    const question = $("#qaInput").value.trim();
    if (!question) return;
    $("#qaAnswer").textContent = "正在检索知识库...";
    const asked = await runControl(submitter, "检索中", async () => {
      const response = await api("/api/knowledge/ask", { method: "POST", body: JSON.stringify({ question }) });
      $("#qaAnswer").textContent = response.answer;
      setState(response.state);
      return true;
    });
    if (!asked) $("#qaAnswer").textContent = "检索失败，请稍后重试。";
  });

  $("#batchForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter || event.currentTarget.querySelector("button[type='submit']");
    const rows = $("#batchRowsInput").value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 80);
    if (!rows.length) {
      toast("请先输入要处理的文本");
      return;
    }
    await runControl(submitter, "处理中", async () => {
      const response = await api("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          type: $("#batchType").value,
          modelId: app.activeModelId,
          rows
        })
      });
      setState(response.state);
      app.selectedJobId = response.job.id;
      toast("批量处理已开始");
    });
  });

  $("#addAuditLog").addEventListener("click", async () => {
    await runControl($("#addAuditLog"), "写入中", async () => {
      const response = await api("/api/audit", {
        method: "POST",
        body: JSON.stringify({ action: "手动合规检查", detail: "管理员确认敏感词与预算策略", actor: "admin@example.com" })
      });
      setState(response.state);
      toast("审计日志已写入");
    });
  });

  $("#refreshUsage")?.addEventListener("click", () => {
    renderCharts();
    toast("图表已刷新");
  });

  $("#globalSearch")?.addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    if (!query) return;
    const prompt = app.state.prompts.find((item) => `${item.title} ${item.category}`.toLowerCase().includes(query));
    const key = app.state.keys.find((item) => `${item.provider} ${item.name}`.toLowerCase().includes(query));
    if (prompt) toast(`找到提示词：${prompt.title}`);
    else if (key) toast(`找到密钥：${key.provider} / ${key.name}`);
  });

  window.addEventListener("resize", debounce(renderCharts, 160));
}

async function init() {
  document.documentElement.dataset.theme = localStorage.getItem("modelhub-theme") || "";
  app.auth.session = readStoredSession();
  app.auth.user = app.auth.session?.user || null;
  app.sharedChat = localStorage.getItem(CHAT_SHARED_MODE_KEY) === "true";
  app.state = createBootstrapState();
  const cachedConversation = readCachedConversation();
  if (cachedConversation) {
    app.state.conversations = [cachedConversation];
  }
  bindEvents();
  render();
  switchView("overview");
  restoreChatDraft();
  requestAnimationFrame(syncModelTabIndicator);
  try {
    await loadServerConfig();
    const expiresAt = app.auth.session?.expires_at ? Number(app.auth.session.expires_at) * 1000 : 0;
    if (app.auth.session?.refresh_token && (!expiresAt || expiresAt <= Date.now() + 60_000)) {
      try {
        await refreshSupabaseSession();
      } catch {
        clearAuthSession();
      }
    }
    renderAuthPanel();
    refreshState().catch((error) => {
      markStateRefreshFailed(error);
      toast(error.message || "数据同步失败，已保留本地初始界面");
    });
  } catch (error) {
    $(".workspace").innerHTML = `
      <section class="panel">
        <div class="empty-state">
          后端服务未连接。请启动 server.js 后访问本页面。
          <br><br>
          ${escapeHtml(error.message)}
        </div>
      </section>
    `;
  }
}

init();
