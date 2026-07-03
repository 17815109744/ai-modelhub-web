function extractText(payload) {
  if (payload.output_text) return payload.output_text;
  const parts = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function splitMessages(messages = [], input = "") {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => String(message.content || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const transcript = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const role = message.role === "assistant" ? "assistant" : "user";
      return `${role}: ${message.content || ""}`;
    })
    .join("\n\n")
    .trim();
  return {
    system,
    input: transcript || input || ""
  };
}

async function chatOpenAI({ apiKey, model, messages, input }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const prepared = splitMessages(messages, input);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      ...(prepared.system ? { instructions: prepared.system } : {}),
      input: prepared.input,
      store: false
    }),
    signal: AbortSignal.timeout(45_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `OpenAI request failed: ${response.status}`);
  }
  return {
    text: extractText(payload),
    rawUsage: payload.usage || null
  };
}

module.exports = {
  chatOpenAI
};
