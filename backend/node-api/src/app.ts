import express from "express";
import { authRouter } from "./modules/auth/auth.routes.js";
import { requireAuth, requireProjectOwnership } from "./modules/auth/auth.controller.js";
import { requestId } from "./middleware/requestId.js";
import { accessLog } from "./middleware/accessLog.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { uploadRouter } from "./modules/uploads/upload.routes.js";
import { projectsRouter } from "./modules/projects/projects.routes.js";
import { aiRouter } from "./modules/ai/ai.routes.js";
import { notFoundHandler, errorHandler } from "./errors/errorHandler.js";

/**
 * Builds the Express app without binding a port. Split out from server.ts
 * specifically so tests can `import { app } from "./app.js"` and drive it
 * with supertest, rather than needing a real listening socket.
 */
export function createApp() {
  const app = express();

  app.use(express.json());

  // Order matters: requestId must run before anything that logs or errors.
  app.use(requestId);
  app.use(accessLog);

  app.use(authRouter);
  app.use(healthRouter);
  // In production AUTH_ENABLED is mandatory; local preview can remain public.
  app.use(requireAuth);
  // User accounts can access only projects owned by their account.
  // The legacy administrator and local preview retain their existing access.
  app.use("/projects/:projectId", requireProjectOwnership);
  app.use(uploadRouter);
  app.use(projectsRouter);
  app.use(aiRouter);

  // Must be after all routes: catches anything that matched no route above.
  app.use(notFoundHandler);

  // Must be the LAST app.use(): Express identifies error-handling middleware
  // by its four-argument signature, invoked only via next(err).
  app.use(errorHandler);

  return app;
}
