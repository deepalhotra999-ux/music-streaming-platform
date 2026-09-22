// Phase 25 — minimal base64 codec for binary segment assembly.
//
// React Native has no global Buffer; expo-file-system's legacy API moves
// binary through base64 strings. These helpers convert between Uint8Array
// and standard base64 (with padding).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET[(n >> 18) & 63];
    out += ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : '=';
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const len = clean.length;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const outLen = Math.floor(len / 4) * 3 - padding;
  const out = new Uint8Array(outLen);
  const val = (ch: string): number => {
    if (ch === '=') return 0;
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base64 input.');
    return idx;
  };
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const n =
      (val(clean[i]) << 18) |
      (val(clean[i + 1]) << 12) |
      (val(clean[i + 2]) << 6) |
      val(clean[i + 3]);
    if (p < outLen) out[p++] = (n >> 16) & 255;
    if (p < outLen) out[p++] = (n >> 8) & 255;
    if (p < outLen) out[p++] = n & 255;
  }
  return out;
}
