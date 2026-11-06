/**
 * OSTAD CASINO — wallet session model.
 *
 * Sessions are opaque random tokens. Only a SHA-256 hash is persisted, so a
 * database read cannot be replayed as a login. Sessions are bound to one wallet
 * + chain, are httpOnly cookies at the web layer, expire absolutely, and can be
 * revoked server-side.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_MINUTES = 60 * 8;
export const NONCE_TTL_MINUTES = 10;

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(`ostad-session:${token}`).digest("hex");
}

export function createAuthNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Constant-time hash comparison for stored session lookups. */
export function sessionHashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

export function isExpired(isoTimestamp: string, at: Date = new Date()): boolean {
  const ts = new Date(isoTimestamp).getTime();
  if (Number.isNaN(ts)) return true;
  return ts <= at.getTime();
}
