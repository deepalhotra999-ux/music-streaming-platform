// Phase 3 — authentication. Production entrypoint: `npm run dev` (tsx) or
// `npm start` (compiled dist). Config is validated before the port opens.

import { loadConfig } from './config.js';
import { buildApp } from './http/app.js';
import { prisma } from './db.js';

const config = loadConfig();
const app = await buildApp(config);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: '0.0.0.0' });
