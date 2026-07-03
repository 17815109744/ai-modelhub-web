function ollamaBaseUrl() {
  return (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

const DEFAULT_OLLAMA_MODEL = "qwen2.5:3b";

async function installedOllamaModels() {
  const response = await fetch(`${ollamaBaseUrl()}/api/tags`);
  if (!response.ok) return [];
  const payload = await response.json().catch(() => ({}));
  return Array.isArray(payload.models)
    ? payload.models.map((item) => item.model || item.name).filter(Boolean)
    : [];
}

async function resolveOllamaModel(preferredModel) {
  const preferred = preferredModel || process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
  try {
    const installed = await installedOllamaModels();
    if (!installed.length) return preferred;
    if (installed.includes(preferred)) return preferred;
    if (process.env.OLLAMA_MODEL && installed.includes(process.env.OLLAMA_MODEL)) return process.env.OLLAMA_MODEL;
    return installed[0];
  } catch {
    return preferred;
  }
}

async function chatOllama({ model, messages }) {
  const resolvedModel = await resolveOllamaModel(model);
  const preparedMessages = [];
  messages.forEach((message) => {
    const content = String(message.content || "").trim();
    if (!content) return;
    const role =
      message.role === "system"
        ? "system"
        : message.role === "assistant"
          ? "assistant"
          : "user";
    const previous = preparedMessages[preparedMessages.length - 1];
    if (previous?.role === role) {
      previous.content += `\n\n${content}`;
    } else {
      preparedMessages.push({ role, content });
    }
  });
  const response = await fetch(`${ollamaBaseUrl()}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: resolvedModel,
      stream: false,
      messages: preparedMessages
    }),
    signal: AbortSignal.timeout(45_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Ollama request failed: ${response.status}`);
  }
  return {
    text: payload.message?.content || payload.response || "",
    rawUsage: {
      promptEvalCount: payload.prompt_eval_count || null,
      evalCount: payload.eval_count || null
    }
  };
}

module.exports = {
  chatOllama
};
