const { chatOpenAI } = require("./openai");
const { chatAnthropic } = require("./anthropic");
const { chatGemini } = require("./gemini");
const { chatOllama } = require("./ollama");
const { providerAllowedForPrivacy } = require("../security/privacy");

function providerKey(provider) {
  const normalized = String(provider || "").toLowerCase();
  if (normalized.includes("openai")) return process.env.OPENAI_API_KEY || "";
  if (normalized.includes("claude") || normalized.includes("anthropic")) return process.env.ANTHROPIC_API_KEY || "";
  if (normalized.includes("gemini") || normalized.includes("google")) return process.env.GEMINI_API_KEY || "";
  return "";
}

function providerConfigured(provider) {
  return Boolean(providerKey(provider));
}

async function callProvider({ model, messages, input, privacyLevel, apiKey: requestApiKey = "" }) {
  const provider = model.provider;
  const normalized = String(provider || "").toLowerCase();

  if (!providerAllowedForPrivacy(normalized, privacyLevel)) {
    return {
      blocked: true,
      text: `Blocked by privacy policy: ${provider} is not allowed for ${privacyLevel} data.`
    };
  }

  const apiKey = requestApiKey || providerKey(provider);
  if (normalized.includes("local") || normalized.includes("ollama") || normalized.includes("self-hosted")) {
    return chatOllama({ model: model.id, messages, input });
  }

  if (!apiKey) {
    return {
      skipped: true,
      missingKey: true,
      text: `未配置 ${provider} API Key，请先在密钥管理里添加该服务商的密钥。`
    };
  }

  if (normalized.includes("openai")) {
    return chatOpenAI({ apiKey, model: model.id, messages, input });
  }
  if (normalized.includes("claude")) {
    return chatAnthropic({ apiKey, model: model.id, messages });
  }
  if (normalized.includes("gemini")) {
    return chatGemini({ apiKey, model: model.id, messages });
  }

  return {
    skipped: true,
    text: ""
  };
}

module.exports = {
  callProvider,
  providerConfigured
};
