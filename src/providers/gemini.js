const { spawn } = require("child_process");

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

function buildGeminiBody(messages) {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => String(message.content || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const contents = [];
  messages
    .filter((message) => message.role !== "system")
    .forEach((message) => {
      const text = String(message.content || "").trim();
      if (!text) return;
      const role = message.role === "assistant" ? "model" : "user";
      const previous = contents[contents.length - 1];
      if (previous?.role === role) {
        previous.parts[0].text += `\n\n${text}`;
      } else {
        contents.push({ role, parts: [{ text }] });
      }
    });
  if (contents[0]?.role === "model") {
    contents.unshift({ role: "user", parts: [{ text: "继续。" }] });
  }
  return {
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    contents,
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 1024
    }
  };
}

function readGeminiText(payload) {
  return (payload.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("\n")
    .trim();
}

function parseProviderError(raw, fallback) {
  try {
    const payload = JSON.parse(String(raw || "").trim());
    return payload.error?.message || fallback;
  } catch {
    return String(raw || "").trim() || fallback;
  }
}

async function fetchGemini({ apiKey, model, body }) {
  const response = await fetch(geminiUrl(model), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `Gemini request failed: ${response.status}`);
  }
  return payload;
}

function powershellGemini({ apiKey, model, body }) {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Gemini direct network request failed"));
  }
  const bodyBase64 = Buffer.from(JSON.stringify(body), "utf8").toString("base64");

  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$bodyBytes = [System.Convert]::FromBase64String($env:GEMINI_REQUEST_BODY_B64)
$headers = @{ 'x-goog-api-key' = $env:GEMINI_API_KEY_VALUE }
try {
  $response = Invoke-RestMethod -Uri $env:GEMINI_API_URL -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bodyBytes -TimeoutSec 45
  $json = $response | ConvertTo-Json -Depth 32 -Compress
  [Console]::Out.Write($json)
} catch {
  $message = $_.Exception.Message
  if ($_.Exception.Response) {
    try {
      $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
      $errorBody = $reader.ReadToEnd()
      if ($errorBody) { $message = $errorBody }
    } catch {}
  }
  [Console]::Error.Write($message)
  exit 1
}
`;

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        GEMINI_API_KEY_VALUE: apiKey,
        GEMINI_API_URL: geminiUrl(model),
        GEMINI_REQUEST_BODY_B64: bodyBase64
      },
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Gemini request timed out"));
    }, 50_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(parseProviderError(stderr, "Gemini PowerShell fallback failed")));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(parseProviderError(stdout || stderr, "Gemini returned an invalid response")));
      }
    });
    child.stdin.end();
  });
}

async function chatGemini({ apiKey, model, messages }) {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const body = buildGeminiBody(messages);
  let payload;

  if (process.platform === "win32" && process.env.GEMINI_TRANSPORT !== "fetch") {
    payload = await powershellGemini({ apiKey, model, body });
    return {
      text: readGeminiText(payload),
      rawUsage: payload.usageMetadata || null
    };
  }

  try {
    payload = await fetchGemini({ apiKey, model, body });
  } catch (error) {
    if (error?.cause?.code || error?.message === "fetch failed" || error?.name === "AbortError") {
      payload = await powershellGemini({ apiKey, model, body });
    } else {
      throw error;
    }
  }

  return {
    text: readGeminiText(payload),
    rawUsage: payload.usageMetadata || null
  };
}

module.exports = {
  chatGemini
};
