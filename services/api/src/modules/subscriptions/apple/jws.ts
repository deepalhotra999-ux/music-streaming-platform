// Phase 19 — Apple App Store Server payload verification.
//
// Apple signs transactions and server notifications as JWS payloads
// (header.payload.signature, ES256). The JWS header's `x5c` field carries
// the certificate chain (leaf first). Verification is:
//
//  1. Parse the 3 segments; header must be ES256 with a non-empty x5c.
//  2. Walk the chain: each certificate must be signed by the next one in
//     x5c, and every certificate must be within its validity period.
//  3. The topmost x5c certificate must chain to the trusted Apple root
//     (bundled Apple Root CA, overridable via APPLE_ROOT_CA_PEM for
//     rotation or tests).
//  4. Verify the JWS signature over "header.payload" with the leaf key.
//
// The trusted root is injectable (`setTrustedRootForTests`) so tests run
// against a throwaway test PKI instead of Apple's real chain. In
// production there is no way to skip verification — adapters throw when
// the store is not configured or a payload fails these checks.

import { X509Certificate, createVerify } from 'node:crypto';
import { badRequest, unprocessableEntity } from '../../../http/errors.js';

/**
 * Apple's Root CA (public root certificate, valid to 2035-02-09), bundled
 * as the default trust anchor for App Store Server payloads. Fetched from
 * https://www.apple.com/appleca/AppleIncRootCertificate.cer on 2026-09-21.
 * Override via the APPLE_ROOT_CA_PEM environment variable.
 */
const BUNDLED_APPLE_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIEuzCCA6OgAwIBAgIBAjANBgkqhkiG9w0BAQUFADBiMQswCQYDVQQGEwJVUzET
MBEGA1UEChMKQXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlv
biBBdXRob3JpdHkxFjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0EwHhcNMDYwNDI1MjE0
MDM2WhcNMzUwMjA5MjE0MDM2WjBiMQswCQYDVQQGEwJVUzETMBEGA1UEChMKQXBw
bGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkx
FjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAw
ggEKAoIBAQDkkakJH5HbHkdQ6wXtXnmELes2oldMVeyLGYne+Uts9QerIjAC6Bg+
+FAJ039BqJj50cpmnCRrEdCju+QbKsMflZ56DKRHi1vUFjczy8QPTc4UadHJGXL1
XQ7Vf1+b8iUDulWPTV0N8WQ1IxVLFVkds5T39pyez1C6wVhQZ48ItCD3y6wsIG9w
tj8BMIy3Q88PnT3zK0koGsj+zrW5DtleHNbLPbU6rfQPDgCSC7EhFi501TwN22IW
q6NxkkdTVcGvL0Gz+PvjcM3mo0xFfh9Ma1CWQYnEdGILEINBhzOKgbEwWOxaBDKM
aLOPHd5lc/9nXmW8Sdh2nzMUZaF3lMktAgMBAAGjggF6MIIBdjAOBgNVHQ8BAf8E
BAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUK9BpR5R2Cf70a40uQKb3
R01/CF4wHwYDVR0jBBgwFoAUK9BpR5R2Cf70a40uQKb3R01/CF4wggERBgNVHSAE
ggEIMIIBBDCCAQAGCSqGSIb3Y2QFATCB8jAqBggrBgEFBQcCARYeaHR0cHM6Ly93
d3cuYXBwbGUuY29tL2FwcGxlY2EvMIHDBggrBgEFBQcCAjCBthqBs1JlbGlhbmNl
IG9uIHRoaXMgY2VydGlmaWNhdGUgYnkgYW55IHBhcnR5IGFzc3VtZXMgYWNjZXB0
YW5jZSBvZiB0aGUgdGhlbiBhcHBsaWNhYmxlIHN0YW5kYXJkIHRlcm1zIGFuZCBj
b25kaXRpb25zIG9mIHVzZSwgY2VydGlmaWNhdGUgcG9saWN5IGFuZCBjZXJ0aWZp
Y2F0aW9uIHByYWN0aWNlIHN0YXRlbWVudHMuMA0GCSqGSIb3DQEBBQUAA4IBAQBc
NplMLXi37Yyb3PN3m/J20ncwT8EfhYOFG5k9RzfyqZtAjizUsZAS2L70c5vu0mQP
y3lPNNiiPvl4/2vIB+x9OYOLUyDTOMSxv5pPCmv/K/xZpwUJfBdAVhEedNO3iyM7
R6PVbyTi69G3cN8PReEnyvFteO3ntRcXqNx+IjXKJdXZD9Zr1KIkIxH3oayPc4Fg
xhtbCS+SsvhESPBgOJ4V9T0mZyCKM2r3DYLP3uujL/lTaltkwGMzd/c6ByxW69oP
IQ7aunMZT7XZNn/Bh1XZp5m5MkL72NVxnn6hUrcbvZNCJBIqxw8dtk2cXmPIS4AX
UKqK1drk/NAJBzewdXUh
-----END CERTIFICATE-----`;

let testRootOverride: string | null = null;

/** Test-only: point verification at a throwaway test PKI. */
export function setTrustedRootForTests(pem: string | null): void {
  testRootOverride = pem;
}

function trustedRootPem(): string {
  if (testRootOverride) return testRootOverride;
  return process.env.APPLE_ROOT_CA_PEM ?? BUNDLED_APPLE_ROOT_CA_PEM;
}

export interface VerifiedJwsPayload {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function base64UrlDecode(segment: string): Buffer {
  // Node's base64url decoder rejects malformed input — wrap for a clean 400.
  try {
    return Buffer.from(segment, 'base64url');
  } catch {
    throw badRequest('Malformed JWS: segment is not valid base64url.');
  }
}

function parseJsonObject(raw: Buffer, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw badRequest(`Malformed JWS: ${what} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw badRequest(`Malformed JWS: ${what} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function checkValidity(cert: X509Certificate, role: string, now: Date): void {
  const notBefore = new Date(cert.validFrom);
  const notAfter = new Date(cert.validTo);
  if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime())) {
    throw badRequest(`Apple certificate ${role}: unparseable validity period.`);
  }
  if (now < notBefore || now > notAfter) {
    throw badRequest(`Apple certificate ${role}: outside its validity period.`);
  }
}

/**
 * Verify a JWS signed by Apple's chain and return its decoded payload.
 * Throws 400 for malformed input, 422 for signature/chain failures.
 */
export function verifyAppleSignedPayload(jws: string): VerifiedJwsPayload {
  if (typeof jws !== 'string' || jws.length === 0 || jws.length > 65536) {
    throw badRequest('signedTransactionInfo must be a non-empty JWS string.');
  }
  const parts = jws.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw badRequest('Malformed JWS: expected header.payload.signature.');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = parseJsonObject(base64UrlDecode(headerB64), 'JWS header');
  const payload = parseJsonObject(base64UrlDecode(payloadB64), 'JWS payload');
  const signature = base64UrlDecode(signatureB64);

  if (header.alg !== 'ES256') {
    throw badRequest(`Unsupported JWS algorithm "${String(header.alg)}"; expected ES256.`);
  }
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length === 0 || x5c.some((c) => typeof c !== 'string')) {
    throw badRequest('Malformed JWS: header.x5c must be a non-empty certificate chain.');
  }

  let chain: X509Certificate[];
  try {
    chain = x5c.map((der) => new X509Certificate(Buffer.from(der as string, 'base64')));
  } catch {
    throw badRequest('Malformed JWS: header.x5c contains an undecodable certificate.');
  }

  const now = new Date();
  // Every presented certificate must be temporally valid.
  for (let i = 0; i < chain.length; i++) {
    checkValidity(chain[i], i === 0 ? 'leaf' : `intermediate[${i}]`, now);
  }
  // Each certificate must be signed by the next one in the chain.
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].verify(chain[i + 1].publicKey)) {
      throw unprocessableEntity('Apple certificate chain is broken: signature mismatch.');
    }
  }
  // The topmost presented certificate must chain to the trusted root.
  const root = new X509Certificate(trustedRootPem());
  checkValidity(root, 'trusted root', now);
  const top = chain[chain.length - 1];
  const topIsRoot = top.fingerprint256 === root.fingerprint256;
  if (!topIsRoot) {
    if (!top.verify(root.publicKey)) {
      throw unprocessableEntity(
        'Apple certificate chain does not chain to the trusted Apple root.',
      );
    }
  }

  // Finally, verify the JWS signature with the leaf key. JWS ES256
  // signatures use IEEE P-1363 raw encoding (r || s, 64 bytes), not the
  // DER encoding Node's verifier assumes by default.
  const verifier = createVerify('sha256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const verified = verifier.verify(
    { key: chain[0].publicKey, dsaEncoding: 'ieee-p1363' },
    signature,
  );
  if (!verified) {
    throw unprocessableEntity('Invalid JWS signature.');
  }

  return { header, payload };
}
