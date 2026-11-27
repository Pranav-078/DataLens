import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireUploadProjectOwnership } from "../auth/auth.controller.js";
import { uploadMiddleware, postUploadValidate } from "./upload.controller.js";
import { uploadRequestGuard } from "../../middleware/uploadRequestGuard.js";

export const uploadRouter = Router();

uploadRouter.post(
  "/uploads/validate",
  uploadRequestGuard,
  uploadMiddleware,
  requireUploadProjectOwnership,
  asyncHandler(postUploadValidate)
);
