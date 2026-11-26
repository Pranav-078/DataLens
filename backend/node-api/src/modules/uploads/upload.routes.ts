import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireUploadProjectOwnership } from "../auth/auth.controller.js";
import { uploadMiddleware, postUploadValidate } from "./upload.controller.js";

export const uploadRouter = Router();

uploadRouter.post(
  "/uploads/validate",
  uploadMiddleware,
  requireUploadProjectOwnership,
  asyncHandler(postUploadValidate)
);
