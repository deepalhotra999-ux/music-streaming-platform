// Phase 3 — authentication. Argon2id password hashing (OWASP-recommended
// memory-hard KDF). Parameters are @node-rs/argon2's OWASP-aligned defaults.

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password);
}

/**
 * Returns false (rather than throwing) when the hash is malformed or the
 * password does not match — a corrupt row must not become a 500 that leaks
 * which half of the credential was wrong.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password);
  } catch {
    return false;
  }
}
