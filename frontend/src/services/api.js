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
