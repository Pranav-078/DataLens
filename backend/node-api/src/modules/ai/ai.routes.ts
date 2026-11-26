import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { documentUploadMiddleware, uploadKnowledgeDocument, postAiChat } from "./ai.controller.js";

export const aiRouter = Router();
aiRouter.post("/projects/:projectId/knowledge", documentUploadMiddleware, asyncHandler(uploadKnowledgeDocument));
aiRouter.post("/projects/:projectId/ai/chat", asyncHandler(postAiChat));
