import axios from "axios";
export const api = axios.create({baseURL: import.meta.env.VITE_API_BASE_URL || "/api", timeout: 120000});
export const getApiError = error => error?.response?.data?.error?.message || error?.message || "Something went wrong. Please try again.";
export const uploadFiles = (files, projectId) => { const body = new FormData(); files.forEach(file => body.append("files", file)); if(projectId) body.append("projectId", projectId); return api.post("/uploads/validate", body, {headers:{"Content-Type":"multipart/form-data"}}); };
export const getVersionTables = (p,v) => api.get("/projects/"+p+"/versions/"+v+"/tables");
export const getVersionIssues = (p,v) => api.get("/projects/"+p+"/versions/"+v+"/issues?page=1&pageSize=100");
export const getVersionRelationships = (p,v) => api.get("/projects/"+p+"/versions/"+v+"/relationships");
export const getQualityScore = (p,v) => api.get("/projects/"+p+"/versions/"+v+"/quality-score");