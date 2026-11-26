import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { config } from "../../config.js";

const COOKIE_NAME = "datalens_session";
const SESSION_SECONDS = 8 * 60 * 60;
const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(256),
}).strict();

type SessionPayload = { email: string; exp: number };
const attempts = new Map<string, { count: number; resetAt: number }>();

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

function issueSession(email: string): string {
  const payload = Buffer.from(JSON.stringify({
    email,
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
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionPayload;
    if (value.email !== config.AUTH_ADMIN_EMAIL || !Number.isInteger(value.exp) || value.exp <= Date.now() / 1000) return null;
    return value;
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

function passwordMatches(password: string): boolean {
  const packed = config.AUTH_ADMIN_PASSWORD_HASH;
  if (!packed) return false;
  const [saltHex, hashHex] = packed.split(":");
  if (!saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === 64 && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function rateLimited(ip: string): boolean {
  const current = attempts.get(ip);
  if (!current) return false;
  if (current.resetAt <= Date.now()) {
    attempts.delete(ip);
    return false;
  }
  return current.count >= 5;
}

function registerFailure(ip: string): void {
  const current = attempts.get(ip);
  if (!current || current.resetAt <= Date.now()) {
    attempts.set(ip, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 });
  } else {
    current.count += 1;
  }
}

export function getAuthSession(req: Request, res: Response): void {
  const session = readSession(req);
  res.status(200).json({
    authEnabled: config.AUTH_ENABLED,
    authenticated: Boolean(session),
    user: session ? { email: session.email } : null,
  });
}

export function postAuthLogin(req: Request, res: Response): void {
  if (!config.AUTH_ENABLED) {
    res.status(400).json({ error: { code: "AUTH_DISABLED", message: "Server authentication is disabled in this environment." } });
    return;
  }
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "INVALID_LOGIN", message: "Enter a valid email and password." } });
    return;
  }

  const ip = req.ip || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ error: { code: "LOGIN_RATE_LIMITED", message: "Too many sign-in attempts. Try again in 15 minutes." } });
    return;
  }

  const email = parsed.data.email.toLowerCase();
  if (email !== config.AUTH_ADMIN_EMAIL || !passwordMatches(parsed.data.password)) {
    registerFailure(ip);
    res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." } });
    return;
  }

  attempts.delete(ip);
  setSessionCookie(res, issueSession(email), SESSION_SECONDS);
  res.status(200).json({ authenticated: true, user: { email } });
}

export function postAuthLogout(_req: Request, res: Response): void {
  setSessionCookie(res, "", 0);
  res.status(200).json({ success: true });
}

export function requireAuth(_req: Request, res: Response, next: NextFunction): void {
  if (!config.AUTH_ENABLED || readSession(_req)) {
    next();
    return;
  }
  res.status(401).json({
    error: { code: "AUTH_REQUIRED", message: "Sign in to access this DataLens workspace." },
  });
}
