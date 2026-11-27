import { config } from "./config.js";
import { logger } from "./logger.js";
import { createApp } from "./app.js";
import { disconnectPrisma } from "./db/prisma.js";

const app = createApp();

const server = app.listen(config.API_PORT, () => {
  logger.info(
    { port: config.API_PORT, env: config.NODE_ENV },
    `datasage-api listening on port ${config.API_PORT}`
  );
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  server.close(async () => {
    await disconnectPrisma();
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
