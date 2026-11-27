/**
 * Origin allowlist for the iframe postMessage bridge.
 *
 * Rules (security-critical):
 *  - only absolute `http(s)` origins;
 *  - no `*`, wildcard hosts, paths, queries or fragments;
 *  - origins are canonicalized (`https://A.example:443/` → `https://a.example`)
 *    and compared by exact string equality — never by suffix/prefix.
 *
 * `allowed-origins` is a defense-in-depth check for inbound messages. It does
 * not replace the server's `frame-ancestors` CSP: a parent page cannot enforce
 * framing from JavaScript.
 */
import { EmbedConfigError } from './errors.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function invalidOrigin(reason: string): EmbedConfigError {
  return new EmbedConfigError(`Invalid origin: ${reason}`);
}

/** Parses one exact origin; throws {@link EmbedConfigError} on anything else. */
export function parseOrigin(input: string): string {
  if (typeof input !== 'string') throw invalidOrigin('expected a string');
  const raw = input.trim();
  if (!raw) throw invalidOrigin('empty value');
  if (raw.length > 2048) throw invalidOrigin('value is too long');
  if (raw === '*' || raw.includes('*')) {
    throw invalidOrigin('wildcards are not allowed; list exact origins, never "*"');
  }
  if (CONTROL_CHARS.test(raw) || /\s/.test(raw)) {
    throw invalidOrigin('whitespace/control characters are not allowed');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidOrigin('not an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidOrigin('only http(s) origins are supported');
  }
  if (!url.hostname) throw invalidOrigin('missing host');
  if (url.username || url.password) throw invalidOrigin('credentials are not allowed');
  if (url.pathname !== '/' || url.search || url.hash) {
    throw invalidOrigin('must be an origin without path, query or fragment');
  }
  return url.origin;
}

/**
 * Parses an `allowed-origins` attribute (comma/whitespace separated) and
 * ensures `targetOrigin` is always present.
 *
 * @param value        Raw attribute value (`null`/`''` means "fallback only").
 * @param targetOrigin Origin of the iframe, always trusted.
 */
export function parseAllowedOrigins(
  value: string | null | undefined,
  targetOrigin: string,
): readonly string[] {
  const fallback = parseOrigin(targetOrigin);
  const origins = new Set<string>([fallback]);
  if (typeof value === 'string' && value.trim()) {
    const entries = value.split(/[\s,]+/).filter(Boolean);
    if (entries.length > 32) throw invalidOrigin('too many entries (max 32)');
    for (const entry of entries) origins.add(parseOrigin(entry));
  }
  if (origins.size > 32) throw invalidOrigin('too many entries (max 32)');
  return Object.freeze([...origins]);
}

/**
 * Exact-membership check for `event.origin`.
 * Invalid/hostile candidates (`null`, `*`, URLs with paths) never match.
 */
export function isAllowedOrigin(candidate: string, allowlist: readonly string[]): boolean {
  if (typeof candidate !== 'string' || !candidate) return false;
  let normalized: string;
  try {
    normalized = parseOrigin(candidate);
  } catch {
    return false;
  }
  for (const allowed of allowlist) {
    if (normalized === allowed) return true;
  }
  return false;
}

/** Non-throwing variant used by tests/diagnostics. */
export function tryParseOrigin(value: string): string | null {
  try {
    return parseOrigin(value);
  } catch {
    return null;
  }
}
