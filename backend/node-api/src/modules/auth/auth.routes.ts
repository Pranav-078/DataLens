import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import {
  getAuthSession,
  postAuthLogin,
  postAuthLogout,
  postAuthRegister,
} from "./auth.controller.js";

export const authRouter = Router();

authRouter.get("/auth/session", asyncHandler(getAuthSession));
authRouter.post("/auth/register", asyncHandler(postAuthRegister));
authRouter.post("/auth/login", asyncHandler(postAuthLogin));
authRouter.post("/auth/logout", postAuthLogout);
