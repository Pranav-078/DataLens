import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { uploadMiddleware, postUploadValidate } from "./upload.controller.js";

export const uploadRouter = Router();

uploadRouter.post("/uploads/validate", uploadMiddleware, asyncHandler(postUploadValidate));
