const PATTERNS = [
  { type: "email", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { type: "phone", regex: /(?<!\d)(?:\+?\d{1,3}[- ]?)?(?:\d{3,4}[- ]?\d{4,8})(?!\d)/g },
  { type: "api_key", regex: /\b(?:sk-|AIza|sk-ant-)[A-Za-z0-9._-]{8,}\b/g },
  { type: "id_number", regex: /\b\d{15}(\d{2}[0-9Xx])?\b/g },
  { type: "credit_card", regex: /\b(?:\d[ -]*?){13,19}\b/g }
];

const HIGH_RISK_WORDS = [
  "password",
  "secret",
  "private key",
  "credential",
  "medical",
  "patient",
  "source code",
  "financial statement",
  "internal forecast",
  "confidential",
  "regulated",
  "密码",
  "密钥",
  "私钥",
  "病历",
  "患者",
  "源代码",
  "内部财报",
  "保密",
  "机密"
];

function normalizePrivacyLevel(value) {
  const normalized = String(value || "").toLowerCase();
  if (["public", "internal", "confidential", "regulated"].includes(normalized)) {
    return normalized;
  }
  return "internal";
}

function findSensitiveEntities(text) {
  const input = String(text || "");
  const entities = [];
  for (const pattern of PATTERNS) {
    for (const match of input.matchAll(pattern.regex)) {
      entities.push({
        type: pattern.type,
        value: match[0],
        index: match.index || 0
      });
    }
  }
  return entities;
}

function classifyPrivacy(text, fallback = "internal") {
  const input = String(text || "");
  const lower = input.toLowerCase();
  const entities = findSensitiveEntities(input);
  const hasHighRiskWord = HIGH_RISK_WORDS.some((word) => lower.includes(word.toLowerCase()));

  if (entities.some((entity) => ["api_key", "id_number", "credit_card"].includes(entity.type))) {
    return "regulated";
  }
  if (hasHighRiskWord || entities.length >= 2) {
    return "confidential";
  }
  if (entities.length === 1) {
    return "internal";
  }
  return normalizePrivacyLevel(fallback);
}

function redactText(text) {
  let output = String(text || "");
  const replacements = [];
  let index = 1;

  for (const pattern of PATTERNS) {
    output = output.replace(pattern.regex, (value) => {
      const token = `[${pattern.type.toUpperCase()}_${index}]`;
      replacements.push({ token, type: pattern.type, value });
      index += 1;
      return token;
    });
  }

  return { text: output, replacements };
}

function providerAllowedForPrivacy(provider, privacyLevel) {
  const normalized = String(provider || "").toLowerCase();
  if (privacyLevel === "public") return true;
  if (privacyLevel === "internal") return !["gemini-free", "unknown"].includes(normalized);
  if (privacyLevel === "confidential") {
    return ["azure-openai", "openai-zdr", "anthropic-zdr", "self-hosted", "local"].includes(normalized);
  }
  if (privacyLevel === "regulated") {
    return ["self-hosted", "local"].includes(normalized);
  }
  return false;
}

module.exports = {
  classifyPrivacy,
  findSensitiveEntities,
  normalizePrivacyLevel,
  redactText,
  providerAllowedForPrivacy
};
