import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

/**
 * API responses are JSON, but these headers also protect browser consumers
 * and prevent accidental exposure through permissive browser embedding.
 */
export function hardeningHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");

  // Only advertise HSTS on requests that reached this app over HTTPS.
  // With a trusted proxy configured, req.secure reflects X-Forwarded-Proto.
  if (config.NODE_ENV === "production" && _req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

/** Exact-origin comparison; URL parsing rejects opaque and malformed origins. */
export function isTrustedOrigin(origin: string | undefined, publicOrigin: string | undefined): boolean {
  if (!origin || !publicOrigin || origin === "null") return false;
  try {
    const parsed = new URL(origin);
    const expected = new URL(publicOrigin);
    return parsed.origin === expected.origin;
  } catch {
    return false;
  }
}

/**
 * Cookie-authenticated state-changing requests must carry the exact browser
 * origin configured for the deployment. SameSite cookies are defense in
 * depth, not a substitute for server-side CSRF validation.
 */
export function requireTrustedOrigin(req: Request, res: Response, next: NextFunction): void {
  if (config.NODE_ENV !== "production" || !["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    next();
    return;
  }

  if (!isTrustedOrigin(req.get("origin"), config.PUBLIC_ORIGIN)) {
    res.status(403).json({
      error: {
        code: "UNTRUSTED_ORIGIN",
        message: "This request origin is not allowed.",
        details: {},
        requestId: req.id,
      },
    });
    return;
  }

  next();
}
