import { config } from "../../config.js";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const CHAT_MODEL = "gemini-2.5-flash";
const EMBEDDING_MODEL = "gemini-embedding-001";

async function geminiRequest(path: string, body: unknown): Promise<any> {
  if (!config.GEMINI_API_KEY) throw new Error("Gemini is not configured. Add GEMINI_API_KEY to the server environment.");
  const response = await fetch(`${API_ROOT}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": config.GEMINI_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.GEMINI_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    const message = payload?.error?.message || `Gemini API returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

export async function embedText(text: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_DOCUMENT"): Promise<number[]> {
  const result = await geminiRequest(`models/${EMBEDDING_MODEL}:embedContent`, {
    model: `models/${EMBEDDING_MODEL}`,
    content: { parts: [{ text }] },
    taskType,
    outputDimensionality: 1536,
  });
  const values = result?.embedding?.values;
  if (!Array.isArray(values) || values.length !== 1536 || !values.every((v: unknown) => typeof v === "number")) {
    throw new Error("Gemini returned an invalid embedding vector.");
  }
  return values as number[];
}

export async function generateText(prompt: string): Promise<string> {
  const result = await geminiRequest(`models/${CHAT_MODEL}:generateContent`, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  });
  const text = result?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned an empty response.");
  return text;
}

/** Extract text from a PDF using Gemini's native PDF understanding. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const result = await geminiRequest(`models/${CHAT_MODEL}:generateContent`, {
    contents: [{
      role: "user",
      parts: [
        { inline_data: { mime_type: "application/pdf", data: buffer.toString("base64") } },
        { text: "Extract all readable text from this PDF. Preserve headings, lists, and table content where possible. Return only the extracted text. Do not summarize or add commentary." }
      ]
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 },
  });
  const text = result?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text || "").join("").trim();
  if (!text) throw new Error("Gemini could not extract readable text from this PDF.");
  return text;
}


/**
 * Stream Gemini text chunks from the server to the Node caller.
 * The API key stays in this module and is never sent to the browser.
 */
export async function* generateTextStream(prompt: string): AsyncGenerator<string> {
  if (!config.GEMINI_API_KEY) {
    throw new Error("Gemini is not configured. Add GEMINI_API_KEY to the server environment.");
  }

  const response = await fetch(
    \`\${API_ROOT}/models/\${CHAT_MODEL}:streamGenerateContent?alt=sse\`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": config.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
      }),
      signal: AbortSignal.timeout(config.GEMINI_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as any;
    throw new Error(payload?.error?.message || \`Gemini stream returned HTTP \${response.status}\`);
  }

  if (!response.body) throw new Error("Gemini did not return a readable response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const extractText = (line: string): string => {
    if (!line.startsWith("data:")) return "";
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") return "";
    try {
      const payload = JSON.parse(raw) as any;
      return payload?.candidates?.[0]?.content?.parts
        ?.map((part: { text?: string }) => part.text || "")
        .join("") || "";
    } catch {
      return "";
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\\r?\\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const text = extractText(line);
        if (text) yield text;
      }
      if (done) break;
    }
    const finalText = extractText(buffer);
    if (finalText) yield finalText;
  } finally {
    reader.releaseLock();
  }
}
