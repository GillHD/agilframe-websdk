/**
 * Safe `/embed.html` URL builder.
 *
 * The embed contract (`agil/core/docs/contract.md` §7) puts the room and token in query
 * parameters. This module is the only place allowed to produce that URL, and it
 * refuses:
 *  - non-http(s) servers (`javascript:`, `data:`, `file:`, …);
 *  - credentials in the URL (`https://user:pass@host`);
 *  - a `widget-path` that escapes the configured server origin;
 *  - control characters and userinfo;
 *  - malformed room/tenant/name/token/language/theme values.
 *
 * Error messages never include the rejected value, so a mistyped URL containing
 * a token cannot leak into logs or UI.
 */
import { EmbedConfigError } from './errors.js';
import type { AgilRole, AgilThemeScheme, BuildEmbedUrlOptions, EmbedTarget } from './types.js';

export type { BuildEmbedUrlOptions, EmbedTarget } from './types.js';

export const DEFAULT_WIDGET_PATH = 'embed.html';
export const DEFAULT_HEIGHT = '640px';
export const MAX_TOKEN_LENGTH = 8192;
export const MAX_ROOM_LENGTH = 200;
export const MAX_NAME_LENGTH = 200;
export const MAX_TENANT_LENGTH = 100;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const THEME_SCHEMES: readonly AgilThemeScheme[] = ['light', 'dark', 'auto'];
const ROLES: readonly AgilRole[] = ['host', 'moderator', 'guest'];

function fail(message: string): never {
  throw new EmbedConfigError(message);
}

function isScheme(value: unknown): value is AgilThemeScheme {
  return typeof value === 'string' && (THEME_SCHEMES as readonly string[]).includes(value);
}

function cleanText(
  value: unknown,
  label: string,
  maxLength: number,
  required = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) fail(`${label} is required`);
    return undefined;
  }
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) fail(`${label} is required`);
    return undefined;
  }
  if (trimmed.length > maxLength) fail(`${label} is too long (max ${maxLength} characters)`);
  if (CONTROL_CHARS.test(trimmed)) fail(`${label} contains control characters`);
  return trimmed;
}

/** `true` for hosts allowed to use plain HTTP during development. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '10.0.2.2';
}

function assertSecure(url: URL, allowInsecure: boolean): void {
  if (url.protocol === 'https:') return;
  if (allowInsecure || isLoopbackHost(url.hostname)) return;
  fail('server-url must use https (pass allowInsecure only for local development)');
}

function parseServer(input?: string, allowInsecure = false): URL {
  let raw = input;
  if (raw === undefined || raw === null || !String(raw).trim()) {
    const origin =
      typeof globalThis.location !== 'undefined' ? globalThis.location.origin : undefined;
    if (!origin || origin === 'null') fail('server-url is required');
    raw = origin;
  }
  if (typeof raw !== 'string') fail('server-url must be a string');
  if (CONTROL_CHARS.test(raw)) fail('server-url contains control characters');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    fail('server-url must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail('server-url must use http or https');
  }
  if (!url.hostname) fail('server-url is missing a host');
  if (url.username || url.password) fail('server-url must not include credentials');
  if (url.search || url.hash) fail('server-url must not include a query or fragment');
  assertSecure(url, allowInsecure);
  return url;
}

/** Normalizes a server URL to `scheme://host[:port][/path]` without a trailing slash. */
export function normalizeServerUrl(input?: string, allowInsecure = false): string {
  const url = parseServer(input, allowInsecure);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** Validates a token with the same rules as the native SDKs (no trimming). */
function cleanToken(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(`${label} must be a string`);
  if (!value) return undefined;
  if (value.length > MAX_TOKEN_LENGTH) {
    fail(`${label} is too long (max ${MAX_TOKEN_LENGTH} characters)`);
  }
  if (CONTROL_CHARS.test(value) || /\s/.test(value)) {
    fail(`${label} must not contain whitespace or control characters`);
  }
  return value;
}

function assertRole(value: unknown): AgilRole | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !(ROLES as readonly string[]).includes(value)) {
    fail('role must be "host", "moderator" or "guest"');
  }
  return value as AgilRole;
}

/**
 * Resolves `widgetPath` against the server base and enforces same-origin.
 * Exported for tests and host-side validation.
 */
export function resolveWidgetUrl(
  serverUrl: string,
  widgetPath: string = DEFAULT_WIDGET_PATH,
  allowInsecure = false,
): URL {
  const server = parseServer(serverUrl, allowInsecure);
  const basePath = server.pathname.replace(/\/+$/, '');
  const base = `${server.origin}${basePath}/`;
  const raw = widgetPath.trim();
  if (!raw) fail('widget-path must not be empty');
  if (raw.length > 2048) fail('widget-path is too long');
  if (CONTROL_CHARS.test(raw) || /\s/.test(raw)) {
    fail('widget-path must not contain whitespace or control characters');
  }
  if (raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    fail('widget-path must be a path on the configured server, not an absolute URL');
  }
  if (raw.includes('\\')) fail('widget-path must use forward slashes');
  if (raw.split('/').includes('..')) fail('widget-path must not contain ".." segments');
  let target: URL;
  try {
    target = new URL(raw, base);
  } catch {
    fail('widget-path is not a valid URL path');
  }
  if (target.origin !== server.origin) {
    fail('widget-path must stay on the server-url origin');
  }
  if (target.username || target.password) fail('widget-path must not include credentials');
  if (target.search || target.hash) fail('widget-path must not include a query or fragment');
  if (target.pathname === '/' || target.pathname === '') {
    fail('widget-path must point to the embed page');
  }
  return target;
}

/**
 * Builds the iframe URL.
 *
 * @throws {EmbedConfigError} for invalid configuration; messages contain no
 *         user-supplied URL/token values.
 */
export function buildEmbedUrl(options: BuildEmbedUrlOptions): EmbedTarget {
  if (!options || typeof options !== 'object') fail('embed options are required');

  const allowInsecure = options.allowInsecure === true;
  const room = cleanText(options.room, 'room', MAX_ROOM_LENGTH, true) as string;
  const token = cleanToken(options.token, 'token');
  const identityToken = cleanToken(options.identityToken, 'identityToken');
  const tenant = cleanText(options.tenant, 'tenant', MAX_TENANT_LENGTH, false);
  const name = cleanText(options.name, 'name', MAX_NAME_LENGTH, false);
  const role = assertRole(options.role);

  let language: string | undefined;
  if (options.language !== undefined && options.language !== null && String(options.language).trim()) {
    language = String(options.language).trim();
    if (language.length > 35 || !LANGUAGE_RE.test(language)) {
      fail('language must be a BCP-47 tag such as "en", "ru" or "en-US"');
    }
  }

  if (options.theme !== undefined && !isScheme(options.theme)) {
    fail('theme must be "light", "dark" or "auto"');
  }

  const serverUrl = normalizeServerUrl(options.serverUrl, allowInsecure);
  const target = resolveWidgetUrl(
    serverUrl,
    options.widgetPath ?? DEFAULT_WIDGET_PATH,
    allowInsecure,
  );
  const params = target.searchParams;

  params.set('server', serverUrl);
  params.set('room', room);
  if (options.audioOnly === true) params.set('audioOnly', '1');
  if (token) params.set('token', token);
  if (identityToken) params.set('identity_token', identityToken);
  if (role) params.set('role', role);
  if (tenant) params.set('tenant', tenant);
  if (language) params.set('lang', language);
  if (options.theme) params.set('theme', options.theme);
  if (name) params.set('name', name);
  if (options.relayOnly === true) params.set('relay', '1');

  return { url: target.toString(), origin: target.origin, serverUrl };
}
