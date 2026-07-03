function prepareAnthropicMessages(messages = []) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => String(message.content || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const prepared = [];
  messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .forEach((message) => {
      const content = String(message.content || "").trim();
      if (!content) return;
      const previous = prepared[prepared.length - 1];
      if (previous?.role === message.role) {
        previous.content += `\n\n${content}`;
      } else {
        prepared.push({ role: message.role, content });
      }
    });
  if (prepared[0]?.role === "assistant") {
    prepared.unshift({ role: "user", content: "继续。" });
  }
  return { system, messages: prepared };
}

async function chatAnthropic({ apiKey, model, messages }) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  const prepared = prepareAnthropicMessages(messages);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      ...(prepared.system ? { system: prepared.system } : {}),
      messages: prepared.messages
    }),
    signal: AbortSignal.timeout(45_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `Anthropic request failed: ${response.status}`);
  }
  return {
    text: (payload.content || []).map((item) => item.text || "").join("\n").trim(),
    rawUsage: payload.usage || null
  };
}

module.exports = {
  chatAnthropic
};
