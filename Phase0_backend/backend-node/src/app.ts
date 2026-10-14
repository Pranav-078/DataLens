import express from "express";
import { requestId } from "./middleware/requestId.js";
import { accessLog } from "./middleware/accessLog.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { uploadRouter } from "./modules/uploads/upload.routes.js";
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

  app.use(healthRouter);
  app.use(uploadRouter);

  // Must be after all routes: catches anything that matched no route above.
  app.use(notFoundHandler);

  // Must be the LAST app.use(): Express identifies error-handling middleware
  // by its four-argument signature, invoked only via next(err).
  app.use(errorHandler);

  return app;
}
