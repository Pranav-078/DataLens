import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { documentUploadMiddleware, uploadKnowledgeDocument, postAiChat, postAiChatStream, listAiSessions, getAiSession } from "./ai.controller.js";

export const aiRouter = Router();
aiRouter.post("/projects/:projectId/knowledge", documentUploadMiddleware, asyncHandler(uploadKnowledgeDocument));
aiRouter.post("/projects/:projectId/ai/chat", asyncHandler(postAiChat));
aiRouter.get("/projects/:projectId/ai/sessions", asyncHandler(listAiSessions));
aiRouter.get("/projects/:projectId/ai/sessions/:sessionId", asyncHandler(getAiSession));
aiRouter.post("/projects/:projectId/ai/chat/stream", asyncHandler(postAiChatStream));
