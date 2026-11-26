import axios from "axios";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api",
  timeout: 120000
});

export const getApiError = error =>
  error?.response?.data?.error?.message ||
  error?.response?.data?.message ||
  error?.message ||
  "Something went wrong. Please try again.";

export const checkApiReadiness = () => api.get("/health/ready");
export const getProjectSummary = projectId => api.get("/projects/" + projectId);
export const getProjectVersions = projectId => api.get("/projects/" + projectId + "/versions");

export const uploadFiles = (files, projectId) => {
  const body = new FormData();
  files.forEach(file => body.append("files", file));
  if (projectId) body.append("projectId", projectId);
  // Let the browser set the multipart boundary automatically.
  return api.post("/uploads/validate", body);
};

export const getVersionTables = (p, v) => api.get("/projects/" + p + "/versions/" + v + "/tables");
export const getVersionIssues = (p, v, page = 1, pageSize = 100) =>
  api.get("/projects/" + p + "/versions/" + v + "/issues", { params: { page, pageSize } });
export const getVersionRelationships = (p, v) => api.get("/projects/" + p + "/versions/" + v + "/relationships");
export const getQualityScore = (p, v) => api.get("/projects/" + p + "/versions/" + v + "/quality-score");

export const uploadKnowledgeDocument = (projectId, file) => {
  const body = new FormData();
  body.append("file", file);
  return api.post("/projects/" + projectId + "/knowledge", body, { timeout: 180000 });
};
export const sendAiMessage = (projectId, payload) =>
  api.post("/projects/" + projectId + "/ai/chat", payload, { timeout: 180000 });

export const listAiSessions = projectId =>
  api.get("/projects/" + projectId + "/ai/sessions");
export const getAiSession = (projectId, sessionId) =>
  api.get("/projects/" + projectId + "/ai/sessions/" + sessionId);


/**
 * Read a server-sent event stream from the authenticated DataLens API.
 * The browser only receives transcript text; the Gemini key stays server-side.
 */
export const streamAiMessage = async (projectId, payload, onEvent) => {
  const baseURL = (api.defaults.baseURL || "/api").replace(/\/$/, "");
  const response = await fetch(
    baseURL + "/projects/" + encodeURIComponent(projectId) + "/ai/chat/stream",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message || "The AI request could not be completed.");
  }
  if (!response.body) throw new Error("Streaming is not supported by this browser.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = block => {
    const data = block.split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .join("\n");
    if (!data) return;
    let event;
    try { event = JSON.parse(data); }
    catch { return; }
    onEvent?.(event);
    if (event.type === "error") throw new Error(event.message || "The AI response could not be completed.");
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, boundary);
        const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
        buffer = buffer.slice(boundary + delimiter.length);
        dispatch(block);
      }
      if (done) break;
    }
    if (buffer.trim()) dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
};
