import { Router } from "express";
import { getAuthSession, postAuthLogin, postAuthLogout } from "./auth.controller.js";

export const authRouter = Router();

authRouter.get("/auth/session", getAuthSession);
authRouter.post("/auth/login", postAuthLogin);
authRouter.post("/auth/logout", postAuthLogout);
