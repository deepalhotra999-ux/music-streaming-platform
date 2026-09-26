#!/usr/bin/env npx tsx
/**
 * LOCAL DEMO SETUP — development only, never run against production.
 *
 * One-command setup for the local product demo:
 *   1. Verifies prerequisites (PostgreSQL, ffmpeg)
 *   2. Applies Prisma migrations
 *   3. Seeds base catalog + demo accounts/data
 *   4. Generates synthetic demo audio (HLS)
 *
 * After this completes, start the backend with `npm run dev`
 * (in services/api), the mobile app with `npx expo start`
 * (in apps/mobile), and the admin app with `npm run dev`
 * (in apps/admin).
 *
 * SAFETY: This script refuses to run if NODE_ENV=production.
 * It only targets the DATABASE_URL in your local .env.
 */
import { execSync } from 'node:child_process';

function check(cmd: string, name: string, hint: string): void {
  try {
    execSync(cmd, { stdio: 'ignore' });
    console.log(`  ✓ ${name}`);
  } catch {
    console.error(`  ✗ ${name} — ${hint}`);
    process.exit(1);
  }
}

function run(cmd: string, label: string): void {
  console.log(`\n→ ${label}...`);
  execSync(cmd, { stdio: 'inherit' });
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('REFUSED: demo setup cannot run with NODE_ENV=production.');
    process.exit(1);
  }

  console.log('Demo setup — prerequisite checks:');
  check(
    'pg_isready -h localhost -p 5432',
    'PostgreSQL (localhost:5432)',
    'Start Postgres: `npm run dev:services` from the repo root, or start your local PostgreSQL.',
  );
  check('ffmpeg -version', 'ffmpeg', 'Install ffmpeg (needed for synthetic demo audio).');

  const dbUrl = process.env.DATABASE_URL ?? '';
  if (dbUrl.includes('amazonaws.com') || dbUrl.includes('rds.')) {
    console.error('REFUSED: DATABASE_URL looks like a production RDS instance. Aborting.');
    process.exit(1);
  }

  run('npx prisma migrate deploy', 'Applying database migrations');
  run('npx prisma db seed', 'Seeding base catalog');
  run('npx tsx prisma/demo-seed.ts', 'Seeding demo accounts and data');
  run('npx tsx scripts/generate-dev-audio.ts', 'Generating synthetic demo audio (HLS)');

  console.log('\n✓ Demo setup complete.\n');
  console.log('Next steps:');
  console.log('  1. Backend:  cd services/api && npm run dev        (http://localhost:3000)');
  console.log('  2. Mobile:   cd apps/mobile && npx expo start');
  console.log('     Android emulator: EXPO_PUBLIC_API_URL=http://10.0.2.2:3000 npx expo start');
  console.log('  3. Admin:    cd apps/admin && npm run dev           (http://localhost:5173)');
  console.log('');
  console.log('Demo accounts (LOCAL ONLY, password: Demo1234!):');
  console.log('  demo.listener@example.local  (Listener)');
  console.log('  demo.artist@example.local    (Artist)');
  console.log('  demo.admin@example.local     (Admin)');
  console.log('');
  console.log('Full walkthrough: docs/LOCAL-DEMO.md');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
