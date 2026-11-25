import { PrismaClient } from "@prisma/client";
import { config } from "../config.js";

/**
 * One PrismaClient for the whole process. This is the ONLY file that
 * imports PrismaClient directly — everything else that needs the database
 * imports `prisma` from here, which keeps connection lifecycle in one
 * place and matches the schema.prisma comment that repo/db access should
 * not be scattered.
 */
export const prisma = new PrismaClient({
  log: config.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

/** Called once at process shutdown (see server.ts). */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
