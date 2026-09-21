import { PrismaClient } from '@prisma/client';

// Single shared PrismaClient for the API service. In dev the client is cached
// on globalThis so hot-reloads don't exhaust the connection pool.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
