const $ = (selector, root = document) => root.querySelector(selector);

const AUTH_STORAGE_KEY = "modelhub.supabase.session";

const authState = {
  config: null,
  session: null,
  user: null,
  mode: "signin",
  returnTo: "/"
};

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
  authState.session = normalized;
  authState.user = normalized?.user || null;
  persistSession(normalized);
  render();
}

function clearAuthSession() {
  authState.session = null;
  authState.user = null;
  persistSession(null);
  render();
}

function supabaseConfig() {
  return authState.config?.supabase || null;
}

function authDisplayName() {
  return authState.user?.email || authState.user?.phone || authState.user?.id || "未登录";
}

function authModeHref(mode) {
  return `/auth.html?mode=${mode}&returnTo=${encodeURIComponent(authState.returnTo || "/")}`;
}

function setNotice(message, tone = "info") {
  const node = $("#authNotice");
  if (!node) return;
  node.textContent = message;
  node.dataset.tone = tone;
}

function setBusy(control, busy, busyText) {
  if (!control) return;
  if (busy) {
    control.dataset.originalText = control.textContent;
    control.disabled = true;
    control.setAttribute("aria-busy", "true");
    if (busyText) control.textContent = busyText;
    return;
  }
  control.disabled = false;
  control.removeAttribute("aria-busy");
  if (control.dataset.originalText) {
    control.textContent = control.dataset.originalText;
    delete control.dataset.originalText;
  }
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error_description || payload.msg || payload.error || "请求失败");
  }
  return payload;
}

async function loadServerConfig() {
  authState.config = await requestJson("/api/security/status", { headers: { "Content-Type": "application/json" } });
  render();
  return authState.config;
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
  const session = authState.session || readStoredSession();
  if (!session?.refresh_token) return null;
  const payload = await supabaseAuthRequest("/token?grant_type=refresh_token", {
    refresh_token: session.refresh_token
  });
  setAuthSession(payload);
  return payload;
}

async function signOutWithSupabase() {
  const session = authState.session || readStoredSession();
  if (!supabaseConfig()?.configured) {
    clearAuthSession();
    return;
  }
  if (session?.refresh_token) {
    try {
      await supabaseAuthRequest("/logout", { refresh_token: session.refresh_token });
    } catch {
      // Fall through and clear the local session.
    }
  }
  clearAuthSession();
}

function parseRoute() {
  const params = new URLSearchParams(window.location.search);
  authState.mode = params.get("mode") === "signup" ? "signup" : "signin";
  authState.returnTo = params.get("returnTo") || "/";
}

function render() {
  const title = $("#authTitle");
  const lead = $("#authLead");
  const submitButton = $("#authSubmitButton");
  const emailInput = $("#authEmailInput");
  const passwordInput = $("#authPasswordInput");
  const form = $("#authForm");
  const sessionCard = $("#authSession");
  const sessionIdentity = $("#authSessionIdentity");
  const sessionMeta = $("#authSessionMeta");
  const returnLink = $("#authReturnLink");
  const backLink = $("#authBackLink");
  const altText = $("#authAltText");
  const altLink = $("#authAltLink");
  const signInLink = $("#modeSignInLink");
  const signUpLink = $("#modeSignUpLink");
  const config = supabaseConfig();
  const isConfigured = Boolean(config?.configured);
  const isSignedIn = Boolean(authState.user);
  const isSignup = authState.mode === "signup";

  if (title) title.textContent = isSignup ? "注册 ModelHub" : "登录 ModelHub";
  if (lead) {
    lead.textContent = isSignup
      ? "创建账号后，你的会话和平台设置就能跟着你走。"
      : "登录后继续你的多模型工作台和会话记录。";
  }
  if (submitButton) submitButton.textContent = isSignup ? "注册" : "登录";
  if (returnLink) returnLink.href = authState.returnTo;
  if (backLink) backLink.href = authState.returnTo;

  if (signInLink) {
    signInLink.href = authModeHref("signin");
    signInLink.classList.toggle("active", !isSignup);
    signInLink.setAttribute("aria-current", isSignup ? "false" : "page");
  }
  if (signUpLink) {
    signUpLink.href = authModeHref("signup");
    signUpLink.classList.toggle("active", isSignup);
    signUpLink.setAttribute("aria-current", isSignup ? "page" : "false");
  }

  if (altText) altText.textContent = isSignup ? "已经有账号了？" : "还没有账号？";
  if (altLink) {
    altLink.textContent = isSignup ? "去登录" : "去注册";
    altLink.href = authModeHref(isSignup ? "signin" : "signup");
  }

  if (form) form.hidden = isSignedIn;
  if (sessionCard) sessionCard.hidden = !isSignedIn;

  if (emailInput) emailInput.disabled = !isConfigured;
  if (passwordInput) passwordInput.disabled = !isConfigured;
  if (submitButton) submitButton.disabled = !isConfigured;

  if (!isConfigured) {
    setNotice("当前还没有完成 Supabase 配置，请先补齐 .env 里的连接信息。", "warn");
    return;
  }

  if (isSignedIn) {
    if (sessionIdentity) sessionIdentity.textContent = authDisplayName();
    if (sessionMeta) {
      sessionMeta.textContent = authState.user?.email_confirmed_at
        ? "当前账号已登录，可以直接返回主页继续使用。"
        : "账号已创建，可能还需要完成邮箱验证。";
    }
    setNotice("会话已就绪。", "success");
    return;
  }

  setNotice(
    isSignup ? "注册后是否需要邮箱验证，取决于 Supabase 当前的认证设置。" : "使用你注册好的邮箱和密码即可登录。",
    "info"
  );
}

function bindEvents() {
  $("#authForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = event.submitter || $("#authSubmitButton");
    const email = $("#authEmailInput")?.value.trim() || "";
    const password = $("#authPasswordInput")?.value || "";

    if (!email || !password) {
      setNotice("请填写邮箱和密码。", "error");
      return;
    }

    try {
      setBusy(submitButton, true, authState.mode === "signup" ? "注册中" : "登录中");
      if (authState.mode === "signup") {
        const response = await signUpWithSupabase(email, password);
        $("#authPasswordInput").value = "";
        if (response.access_token || response.session?.access_token) {
          setNotice("注册成功，正在返回主页...", "success");
          window.setTimeout(() => {
            window.location.href = authState.returnTo;
          }, 500);
          return;
        }
        setNotice("注册成功，请查收邮箱完成验证。", "success");
        render();
        return;
      }

      await signInWithSupabase(email, password);
      $("#authPasswordInput").value = "";
      setNotice("登录成功，正在返回主页...", "success");
      render();
      window.setTimeout(() => {
        window.location.href = authState.returnTo;
      }, 400);
    } catch (error) {
      setNotice(error.message || "认证失败，请稍后再试。", "error");
    } finally {
      setBusy(submitButton, false);
    }
  });

  $("#authSignOutButton")?.addEventListener("click", async (event) => {
    try {
      setBusy(event.currentTarget, true, "退出中");
      await signOutWithSupabase();
      setNotice("已退出登录，现在可以切换账号。", "info");
      $("#authPasswordInput")?.focus();
    } catch (error) {
      setNotice(error.message || "退出失败，请稍后再试。", "error");
    } finally {
      setBusy(event.currentTarget, false);
    }
  });
}

async function init() {
  parseRoute();
  authState.session = readStoredSession();
  authState.user = authState.session?.user || null;
  bindEvents();
  render();

  try {
    await loadServerConfig();
    const expiresAt = authState.session?.expires_at ? Number(authState.session.expires_at) * 1000 : 0;
    if (authState.session?.refresh_token && (!expiresAt || expiresAt <= Date.now() + 60_000)) {
      try {
        await refreshSupabaseSession();
      } catch {
        clearAuthSession();
      }
    }
    render();
  } catch (error) {
    setNotice(error.message || "无法加载服务配置。", "error");
  }
}

init();
