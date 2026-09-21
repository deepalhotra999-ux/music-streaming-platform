#!/usr/bin/env node
// Test/dev helper: set a user's role directly in the database.
//
// Role changes are admin-only through the API by design (ADR-004), so
// live integration tests cannot promote their throwaway registered users
// through HTTP. This script exists for that single purpose: promote a
// test user to ARTIST (or demote back to LISTENER) without an admin
// session. Not part of the API surface; never deploy.
//
// Usage:
//   DATABASE_URL=postgresql://... node set-user-role.mjs <email> <LISTENER|ARTIST|ADMIN>

import { PrismaClient } from '@prisma/client';

const [email, role] = process.argv.slice(2);
if (!email || !['LISTENER', 'ARTIST', 'ADMIN'].includes(role)) {
  console.error('usage: node set-user-role.mjs <email> <LISTENER|ARTIST|ADMIN>');
  process.exit(2);
}

const prisma = new PrismaClient();
try {
  const user = await prisma.user.update({ where: { email }, data: { role } });
  console.log(`role of ${user.email} set to ${user.role}`);
} catch (e) {
  console.error(`failed: ${e.message}`);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
