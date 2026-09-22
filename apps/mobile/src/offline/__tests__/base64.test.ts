// Phase 25 — base64 codec round-trips (segment assembly depends on these).
import { base64ToBytes, bytesToBase64 } from '../base64';

describe('base64 codec', () => {
  it('round-trips arbitrary bytes, including non-multiple-of-3 lengths', () => {
    const vectors: number[][] = [
      [],
      [0],
      [255],
      [1, 2],
      [1, 2, 3],
      [1, 2, 3, 4],
      Array.from({ length: 256 }, (_, i) => i),
      Array.from({ length: 1000 }, (_, i) => (i * 37) % 256),
    ];
    for (const v of vectors) {
      const bytes = new Uint8Array(v);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it('produces standard padded base64', () => {
    expect(bytesToBase64(new Uint8Array([102, 111, 111]))).toBe('Zm9v');
    expect(bytesToBase64(new Uint8Array([102, 111]))).toBe('Zm8=');
    expect(bytesToBase64(new Uint8Array([102]))).toBe('Zg==');
  });

  it('decodes concatenated segment-style chunks without corruption', () => {
    const a = new Uint8Array([0, 1, 2, 3, 4]);
    const b = new Uint8Array([5, 6, 7]);
    // Decode each chunk separately (as the manager does per segment) and
    // concatenate the bytes — never the base64 strings.
    const combined = new Uint8Array(a.length + b.length);
    combined.set(base64ToBytes(bytesToBase64(a)), 0);
    combined.set(base64ToBytes(bytesToBase64(b)), a.length);
    expect(combined).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
  });
});
