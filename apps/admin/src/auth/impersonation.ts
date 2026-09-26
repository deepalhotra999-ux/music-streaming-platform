// Admin V2 — impersonation JWT claims decoding.
//
// DISPLAY ONLY. The server verifies the signature, enforces duration,
// target eligibility, and re-reads both accounts on every request. These
// claims only power the warning banner and the countdown; they are never
// treated as authorization.

import type { ImpersonationClaims } from '../api/types';

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  const withPad = pad === 0 ? padded : padded + '='.repeat(4 - pad);
  return atob(withPad);
}

/**
 * Decodes the payload of an impersonation JWT without verifying it.
 * Returns null for non-impersonation tokens, malformed tokens, or payloads
 * that do not carry `imp: true`.
 */
export function decodeImpersonationClaims(token: string | null): ImpersonationClaims | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Partial<ImpersonationClaims>;
    if (payload.imp !== true) return null;
    if (typeof payload.exp !== 'number' || typeof payload.reason !== 'string') return null;
    return payload as ImpersonationClaims;
  } catch {
    return null;
  }
}

/** Whole seconds remaining until the impersonation session expires. */
export function impersonationSecondsLeft(claims: ImpersonationClaims, nowMs = Date.now()): number {
  return Math.max(0, Math.floor(claims.exp * 1000 - nowMs) / 1000);
}

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
