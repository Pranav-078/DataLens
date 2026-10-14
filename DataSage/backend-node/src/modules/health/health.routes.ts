import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getHealth, getReadiness } from "./health.controller.js";

export const healthRouter = Router();

healthRouter.get("/health", getHealth);
healthRouter.get("/health/ready", asyncHandler(getReadiness));
