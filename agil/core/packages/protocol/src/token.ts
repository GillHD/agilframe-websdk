/**
 * HS256 JWT-style access tokens for AgilFrame rooms.
 *
 * Node-only: import from '@agil/protocol/token' on the server side, never from
 * the browser bundle (the widget only forwards the token string).
 *
 * Claims are small: the token is an authorisation grant, not a session store.
 * The server re-reads tenant config on every join.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { featureKeys, type FeatureKey } from './config.js';
import type { Role } from './signaling.js';

export interface TokenClaims {
  /** Participant id (stable per user, generated server-side if unknown). */
  sub: string;
  name: string;
  role: Role;
  tenantId: string;
  roomId: string;
  /**
   * Optional pinned feature permissions. When present (non-empty) it replaces
   * the tenant role defaults for this participant — the issuer decides exactly
   * what the user may use (see `resolveAccess` in access.ts).
   */
  permissions?: FeatureKey[];
  /** Custom role id from `security.accessPolicy.customRoles` (optional). */
  roleId?: string;
  /** Issued at, unix seconds. */
  iat: number;
  /** Expiration, unix seconds. */
  exp: number;
}

export interface SignTokenOptions {
  ttlSec?: number;
  /** Override "now" (unix seconds) for tests. */
  now?: number;
}

export interface VerifyTokenOptions {
  now?: number;
  clockToleranceSec?: number;
}

export type VerifyTokenResult =
  | { valid: true; claims: TokenClaims }
  | { valid: false; error: string };

function toBase64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function fromBase64Url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function hmacSha256(input: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(input).digest();
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const ROLES: Role[] = ['host', 'moderator', 'guest'];

/** Signs a room token. `ttlSec` defaults to 1 hour. */
export function signToken(
  claims: Omit<TokenClaims, 'iat' | 'exp'>,
  secret: string,
  options: SignTokenOptions = {},
): string {
  if (!secret) throw new Error('AGIL token secret is required');
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSec ?? 3600;
  const payload: TokenClaims = { ...claims, iat: now, exp: now + ttl };
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = toBase64Url(hmacSha256(`${encodedHeader}.${encodedPayload}`, secret));
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/** Verifies signature, structure and expiration. Never throws. */
export function verifyToken(token: string, secret: string, options: VerifyTokenOptions = {}): VerifyTokenResult {
  if (!token || typeof token !== 'string') return { valid: false, error: 'missing_token' };
  if (!secret) return { valid: false, error: 'missing_secret' };
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, error: 'malformed_token' };
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(fromBase64Url(encodedHeader));
    claims = JSON.parse(fromBase64Url(encodedPayload));
  } catch {
    return { valid: false, error: 'malformed_payload' };
  }
  if (typeof header !== 'object' || header === null || (header as { alg?: string }).alg !== 'HS256') {
    return { valid: false, error: 'unsupported_alg' };
  }

  const expected = hmacSha256(`${encodedHeader}.${encodedPayload}`, secret);
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return { valid: false, error: 'malformed_signature' };
  }
  if (!constantTimeEqual(expected, actual)) return { valid: false, error: 'bad_signature' };

  const c = claims as Partial<TokenClaims> & Record<string, unknown>;
  const permissionsValid =
    c.permissions === undefined ||
    (Array.isArray(c.permissions) &&
      c.permissions.every((permission) => typeof permission === 'string' && featureKeys.includes(permission as FeatureKey)));
  if (
    typeof c.sub !== 'string' ||
    typeof c.name !== 'string' ||
    typeof c.tenantId !== 'string' ||
    typeof c.roomId !== 'string' ||
    typeof c.iat !== 'number' ||
    typeof c.exp !== 'number' ||
    typeof c.role !== 'string' ||
    !ROLES.includes(c.role as Role) ||
    !permissionsValid
  ) {
    return { valid: false, error: 'bad_claims' };
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockToleranceSec ?? 30;
  if (c.exp + tolerance < now) return { valid: false, error: 'expired' };
  if (c.iat - tolerance > now) return { valid: false, error: 'not_yet_valid' };

  return { valid: true, claims: c as TokenClaims };
}

/** Decodes claims without verification. Useful for UI hints only; never for auth. */
export function decodeTokenUnsafe(token: string): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(fromBase64Url(parts[1] ?? '')) as TokenClaims;
  } catch {
    return null;
  }
}
