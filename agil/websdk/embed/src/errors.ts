/**
 * Errors and redaction helpers.
 *
 * Security invariant: no library code logs, and every message that can reach
 * an event listener, the DOM or an exception is passed through
 * {@link redactSecrets} first. Callers supply the current token so even a
 * widget error that echoes the iframe URL cannot leak it.
 */

/** Stable error categories used by {@link AgilCallErrorDetail}. */
export type EmbedErrorCode =
  | 'invalid-config'
  | 'missing-room'
  | 'load-timeout'
  | 'bridge-timeout'
  | 'bridge-error'
  | 'destroyed';

/** Configuration error thrown by the URL builder/origin parser. */
export class EmbedConfigError extends Error {
  readonly code: EmbedErrorCode;

  constructor(message: string, code: EmbedErrorCode = 'invalid-config') {
    super(message);
    this.name = 'EmbedConfigError';
    this.code = code;
  }
}

/** Bridge lifecycle/transport error. */
export class EmbedBridgeError extends Error {
  readonly code: EmbedErrorCode;

  constructor(message: string, code: EmbedErrorCode = 'bridge-error') {
    super(message);
    this.name = 'EmbedBridgeError';
    this.code = code;
  }
}

const MAX_PUBLIC_MESSAGE = 300;

/** Matches token-ish query parameters anywhere in a string. */
const SECRET_QUERY_RE = /([?&#](?:token|identity_token|id_token|access_token)=)[^&#\s"'<>]*/gi;

/** Matches JWT-shaped strings (three base64url segments). */
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** Removes control characters and collapses whitespace for DOM/event text. */
function printable(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Redacts token-like secrets from an arbitrary string.
 *
 * @param input   Untrusted text (error message, widget payload, …).
 * @param secrets Known secret values (the current token) to replace verbatim.
 */
export function redactSecrets(input: unknown, secrets: readonly string[] = []): string {
  let text = typeof input === 'string' ? input : String(input ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    text = text.split(secret).join('[redacted]');
  }
  text = text.replace(SECRET_QUERY_RE, '$1[redacted]');
  text = text.replace(JWT_RE, '[redacted]');
  return text;
}

/**
 * Converts an untrusted error/value into a short, printable, redacted message.
 * Password-like values and stack traces are never included.
 */
export function publicMessage(
  error: unknown,
  secrets: readonly string[] = [],
  fallback = 'Unexpected error',
): string {
  let raw: string;
  if (error instanceof Error) raw = error.message || fallback;
  else if (typeof error === 'string') raw = error;
  else raw = fallback;
  const clean = printable(redactSecrets(raw, secrets));
  if (!clean) return fallback;
  return clean.length > MAX_PUBLIC_MESSAGE ? `${clean.slice(0, MAX_PUBLIC_MESSAGE - 1)}…` : clean;
}

/** Maps an unknown thrown value to a safe `{code, message}` pair. */
export function toPublicError(
  error: unknown,
  secrets: readonly string[] = [],
): { code: EmbedErrorCode; message: string } {
  if (error instanceof EmbedConfigError || error instanceof EmbedBridgeError) {
    return { code: error.code, message: publicMessage(error, secrets) };
  }
  return { code: 'bridge-error', message: publicMessage(error, secrets) };
}
