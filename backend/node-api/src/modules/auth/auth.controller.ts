import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { prisma } from "../../db/prisma.js";
import {
  clearFailedAttempts,
  isRateLimited,
  recordFailedAttempt,
  type AuthAttemptStore,
} from "./auth-rate-limit.js";

const COOKIE_NAME = "datalens_session";
const SESSION_SECONDS = 8 * 60 * 60;
const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
}).strict();
const registrationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
}).strict();

type SessionPayload = { email: string; userId: string | null; exp: number };
type AuthContext = { userId: string | null; email: string; isAdmin: boolean };
const attempts: AuthAttemptStore = new Map();

function cookieValue(req: Request): string | undefined {
  const header = req.headers.cookie || "";
  for (const entry of header.split(";")) {
    const [name, ...parts] = entry.trim().split("=");
    if (name === COOKIE_NAME) return parts.join("=");
  }
  return undefined;
}

function sign(value: string): string {
  return createHmac("sha256", config.AUTH_COOKIE_SECRET || "")
    .update(value)
    .digest("base64url");
}

function issueSession(email: string, userId: string | null): string {
  const payload = Buffer.from(JSON.stringify({
    email,
    userId,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  } satisfies SessionPayload)).toString("base64url");
  return payload + "." + sign(payload);
}

function readSession(req: Request): SessionPayload | null {
  if (!config.AUTH_ENABLED) return null;
  const token = cookieValue(req);
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;

  const expected = Buffer.from(sign(payload), "base64url");
  const supplied = Buffer.from(signature, "base64url");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (typeof value.email !== "string" || !Number.isInteger(value.exp) || Number(value.exp) <= Date.now() / 1000) return null;

    // A null userId is reserved for the optional legacy administrator login.
    // Existing administrator cookies (created before account registration)
    // remain accepted when they carry the configured administrator address.
    const userId = value.userId ?? null;
    if (userId === null) {
      if (!config.AUTH_ADMIN_EMAIL || value.email.toLowerCase() !== config.AUTH_ADMIN_EMAIL) return null;
    } else if (!z.string().uuid().safeParse(userId).success) {
      return null;
    }

    return { email: value.email.toLowerCase(), userId, exp: Number(value.exp) };
  } catch {
    return null;
  }
}

function setSessionCookie(res: Response, token: string, maxAge: number): void {
  const attributes = [
    COOKIE_NAME + "=" + token,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + maxAge,
  ];
  if (config.NODE_ENV === "production") attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function makePasswordHash(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return salt.toString("hex") + ":" + hash.toString("hex");
}

function passwordMatches(password: string, packed: string | undefined): boolean {
  if (!packed) return false;
  const [saltHex, hashHex] = packed.split(":");
  if (!saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function authError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function publicUser(user: { id: string; name: string; email: string; projects?: Array<{ id: string; name: string }> }) {
  const project = user.projects?.[0];
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
  };
}

export async function getAuthSession(req: Request, res: Response): Promise<void> {
  const session = readSession(req);
  if (!session) {
    res.status(200).json({ authEnabled: config.AUTH_ENABLED, registrationAllowed: config.AUTH_ALLOW_REGISTRATION, authenticated: false, user: null });
    return;
  }

  if (session.userId) {
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true, name: true, email: true,
        projects: { orderBy: { createdAt: "asc" }, take: 1, select: { id: true, name: true } },
      },
    });
    if (!user) {
      setSessionCookie(res, "", 0);
      res.status(200).json({ authEnabled: config.AUTH_ENABLED, registrationAllowed: config.AUTH_ALLOW_REGISTRATION, authenticated: false, user: null });
      return;
    }
    res.status(200).json({ authEnabled: config.AUTH_ENABLED, registrationAllowed: config.AUTH_ALLOW_REGISTRATION, authenticated: true, user: publicUser(user) });
    return;
  }

  res.status(200).json({
    authEnabled: config.AUTH_ENABLED,
    registrationAllowed: config.AUTH_ALLOW_REGISTRATION,
    authenticated: true,
    user: { id: null, name: "Administrator", email: session.email, projectId: null, projectName: "Administrator workspace" },
  });
}

export async function postAuthRegister(req: Request, res: Response): Promise<void> {
  if (!config.AUTH_ENABLED) {
    authError(res, 400, "AUTH_DISABLED", "Enable server authentication before creating an account.");
    return;
  }

  if (!config.AUTH_ALLOW_REGISTRATION) {
    authError(res, 403, "REGISTRATION_DISABLED", "New account registration is currently disabled.");
    return;
  }

  const ip = req.ip || "unknown";
  const rateKey = "register:" + ip;
  if (isRateLimited(attempts, rateKey)) {
    authError(res, 429, "REGISTRATION_RATE_LIMITED", "Too many account creation attempts. Try again in 15 minutes.");
    return;
  }

  // Count every registration attempt, including invalid and duplicate requests.
  // A successful registration clears the counter below.
  recordFailedAttempt(attempts, rateKey);

  const parsed = registrationSchema.safeParse(req.body);
  if (!parsed.success) {
    authError(res, 400, "INVALID_REGISTRATION", parsed.error.issues[0]?.message || "Enter your name, a valid email and a password with at least 8 characters.");
    return;
  }

  const name = parsed.data.name;
  const email = parsed.data.email.toLowerCase();
  try {
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: makePasswordHash(parsed.data.password),
        projects: { create: { name: name + "'s workspace" } },
      },
      select: {
        id: true, name: true, email: true,
        projects: { orderBy: { createdAt: "asc" }, take: 1, select: { id: true, name: true } },
      },
    });

    clearFailedAttempts(attempts, rateKey);
    setSessionCookie(res, issueSession(user.email, user.id), SESSION_SECONDS);
    res.status(201).json({ authenticated: true, user: publicUser(user) });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      authError(res, 409, "ACCOUNT_EXISTS", "An account with this email already exists. Sign in instead.");
      return;
    }
    throw error;
  }
}

export async function postAuthLogin(req: Request, res: Response): Promise<void> {
  if (!config.AUTH_ENABLED) {
    authError(res, 400, "AUTH_DISABLED", "Server authentication is disabled in this environment.");
    return;
  }

  const ip = req.ip || "unknown";
  const rateKey = "login:" + ip;
  if (isRateLimited(attempts, rateKey)) {
    authError(res, 429, "LOGIN_RATE_LIMITED", "Too many sign-in attempts. Try again in 15 minutes.");
    return;
  }

  // Count malformed login requests too, not only well-formed wrong passwords.
  recordFailedAttempt(attempts, rateKey);

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    authError(res, 400, "INVALID_LOGIN", "Enter a valid email and password.");
    return;
  }

  const email = parsed.data.email.toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true, name: true, email: true, passwordHash: true,
      projects: { orderBy: { createdAt: "asc" }, take: 1, select: { id: true, name: true } },
    },
  });

  if (user && passwordMatches(parsed.data.password, user.passwordHash)) {
    clearFailedAttempts(attempts, rateKey);
    setSessionCookie(res, issueSession(user.email, user.id), SESSION_SECONDS);
    res.status(200).json({ authenticated: true, user: publicUser(user) });
    return;
  }

  // Backward compatibility for installations that still use the original
  // single administrator credentials from .env.
  const adminMatch = !user &&
    Boolean(config.AUTH_ADMIN_EMAIL) &&
    email === config.AUTH_ADMIN_EMAIL &&
    passwordMatches(parsed.data.password, config.AUTH_ADMIN_PASSWORD_HASH);

  if (adminMatch) {
    clearFailedAttempts(attempts, rateKey);
    setSessionCookie(res, issueSession(email, null), SESSION_SECONDS);
    res.status(200).json({
      authenticated: true,
      user: { id: null, name: "Administrator", email, projectId: null, projectName: "Administrator workspace" },
    });
    return;
  }

  authError(res, 401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
}

export function postAuthLogout(_req: Request, res: Response): void {
  setSessionCookie(res, "", 0);
  res.status(200).json({ success: true });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.AUTH_ENABLED) {
    res.locals.datalensAuth = { userId: null, email: "", isAdmin: true } satisfies AuthContext;
    next();
    return;
  }

  const session = readSession(req);
  if (!session) {
    authError(res, 401, "AUTH_REQUIRED", "Sign in to access this DataLens workspace.");
    return;
  }

  res.locals.datalensAuth = {
    userId: session.userId,
    email: session.email,
    isAdmin: session.userId === null,
  } satisfies AuthContext;
  next();
}

export async function requireProjectOwnership(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = res.locals.datalensAuth as AuthContext | undefined;
  if (!config.AUTH_ENABLED || auth?.isAdmin) {
    next();
    return;
  }
  const projectId = z.string().uuid().safeParse(req.params.projectId);
  if (!projectId.success || !auth?.userId) {
    authError(res, 404, "PROJECT_NOT_FOUND", "Project was not found.");
    return;
  }

  try {
    const project = await prisma.project.findFirst({
      where: { id: projectId.data, ownerUserId: auth.userId },
      select: { id: true },
    });
    if (!project) {
      authError(res, 404, "PROJECT_NOT_FOUND", "Project was not found.");
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireUploadProjectOwnership(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = res.locals.datalensAuth as AuthContext | undefined;
  if (!config.AUTH_ENABLED || auth?.isAdmin) {
    next();
    return;
  }

  const projectId = z.string().uuid().safeParse(req.body?.projectId);
  if (!projectId.success || !auth?.userId) {
    authError(res, 400, "WORKSPACE_REQUIRED", "Your account workspace could not be identified. Sign in again and retry the upload.");
    return;
  }

  try {
    const project = await prisma.project.findFirst({
      where: { id: projectId.data, ownerUserId: auth.userId },
      select: { id: true },
    });
    if (!project) {
      authError(res, 404, "PROJECT_NOT_FOUND", "The selected workspace was not found.");
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}
