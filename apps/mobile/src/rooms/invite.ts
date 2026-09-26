// Phase 28 — invite parsing helpers.
//
// Kept out of the join screen so the tolerant paste-parse is unit-testable
// without pulling expo-router into the test.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Invitation tokens are 32 random bytes encoded base64url: 43 chars.
const TOKEN_RE = /[A-Za-z0-9_-]{43}/;

/**
 * Extract { roomId, token } from a pasted invite message. Returns null
 * unless both a room id and a token are found.
 */
export function parseInviteText(text: string): { roomId: string; token: string } | null {
  const roomId = UUID_RE.exec(text)?.[0] ?? null;
  // Avoid matching the uuid itself as the token.
  const withoutUuid = roomId ? text.replace(roomId, '') : text;
  const token = TOKEN_RE.exec(withoutUuid)?.[0] ?? null;
  if (!roomId || !token) return null;
  return { roomId, token };
}
