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

export async function embedText(text: string): Promise<number[]> {
  const result = await geminiRequest(`models/${EMBEDDING_MODEL}:embedContent`, {
    model: `models/${EMBEDDING_MODEL}`,
    content: { parts: [{ text }] },\n    taskType: "RETRIEVAL_DOCUMENT",
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
