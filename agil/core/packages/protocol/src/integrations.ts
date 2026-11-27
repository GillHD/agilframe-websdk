/**
 * Integration boundaries between AgilFrame and the company's own systems.
 *
 * AgilFrame owns the real-time layer: rooms, media, chat, files, recording,
 * transcripts, theming, permission *enforcement* and the audit trail. The
 * company application owns its business context: user directory / IdP, wiki
 * and internal resources, AI agent, compliance policy and data retention.
 *
 * We never store company secrets or wiki content; we call company endpoints and
 * forward events via signed webhooks.
 */
import { z } from 'zod';

export const webhookEventTypes = [
  'room.created',
  'room.closed',
  'participant.joined',
  'participant.left',
  'chat.message',
  'file.shared',
  'recording.ready',
  'transcript.ready',
  'analysis.ready',
  'knowledge.answer',
  'compliance.finding',
  'security.event',
] as const;

export type WebhookEventType = (typeof webhookEventTypes)[number];
export const webhookEventTypeSchema = z.enum(webhookEventTypes);

/** Event delivered to the company's webhook endpoint (HTTPS). */
export interface WebhookPayload {
  /** Delivery id (also sent as `x-agil-delivery`). */
  id: string;
  type: WebhookEventType;
  ts: number;
  tenantId: string;
  roomId?: string;
  data: Record<string, unknown>;
}

export const webhookPayloadSchema = z.object({
  id: z.string().min(1),
  type: webhookEventTypeSchema,
  ts: z.number(),
  tenantId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  data: z.record(z.string(), z.unknown()),
});

export interface WebhookEndpointConfig {
  id: string;
  url: string;
  events: WebhookEventType[];
  /** Name of the env variable holding the HMAC secret (never the secret itself). */
  secretEnv: string;
  enabled: boolean;
  retries: number;
  timeoutMs: number;
  description?: string;
}

export const webhookEndpointSchema = z.object({
  id: z.string().min(1).max(64),
  url: z.string().min(1).max(500),
  events: z.array(webhookEventTypeSchema).min(1),
  secretEnv: z.string().min(1).max(100),
  enabled: z.boolean(),
  retries: z.number().int().min(0).max(10),
  timeoutMs: z.number().int().min(500).max(30000),
  description: z.string().max(300).optional(),
});

export interface WebhookDeliveryRecord {
  id: string;
  endpointId: string;
  type: WebhookEventType;
  status: 'delivered' | 'failed' | 'retrying';
  attempts: number;
  ts: number;
  lastError?: string;
  statusCode?: number;
}

/** Application role assigned by an IdP group mapping (see {@link GroupRoleMapping}). */
export type IdentityRole = 'host' | 'moderator' | 'guest';

/**
 * How the OIDC client authenticates at the token endpoint (RFC 6749 §2.3.1).
 * Both are client-secret methods; the secret itself is never stored in the
 * tenant config (only `clientSecretEnv` names the server env var).
 */
export type OidcTokenEndpointAuthMethod = 'client_secret_post' | 'client_secret_basic';

/** OIDC authorization response mode (query is the OAuth default). */
export type OidcResponseMode = 'query' | 'form_post';

export const OIDC_TOKEN_ENDPOINT_AUTH_METHODS = ['client_secret_post', 'client_secret_basic'] as const;
export const OIDC_RESPONSE_MODES = ['query', 'form_post'] as const;

/**
 * Default discovery document path: the OIDC Discovery 1.0 rule appends
 * `/.well-known/openid-configuration` to the issuer (the issuer keeps its path).
 */
export const OIDC_DISCOVERY_WELL_KNOWN_PATH = '/.well-known/openid-configuration';

/**
 * One IdP-group → application-role rule. When `groupRoleMap` is non-empty it is
 * authoritative: only mapped groups grant a non-guest role (highest wins), and
 * an identity with no matching group joins as `guest` even if `roleClaim` says
 * otherwise.
 */
export interface GroupRoleMapping {
  /** Group value as it appears in `groupsClaim` (exact, case-sensitive). */
  group: string;
  role: IdentityRole;
}

/**
 * Identity federation: the company's IdP (Keycloak/ADFS/Okta/…) issues tokens
 * that our API verifies against a JWKS, or the company's backend issues our
 * HS256 tokens directly (`mode:'token'`).
 *
 * `mode:'oidc'` drives two flows with the same JWKS trust root:
 *  - verified joins: a caller presents an already-issued `identityToken`
 *    (`POST /v1/auth/oidc/verify`, `POST /v1/rooms/:id/join`);
 *  - dashboard SSO: authorization-code + PKCE against
 *    `authorizationEndpoint`/`tokenEndpoint`
 *    (`GET /v1/auth/oidc/start`, `GET /v1/auth/oidc/callback`).
 *
 * The client secret is never stored in the config: `clientSecretEnv` is the
 * *name* of the environment variable that holds it.
 */
export interface IdentityConfig {
  mode: 'token' | 'oidc';
  /** OIDC issuer (e.g. https://sso.example.com/realms/corp). Required for mode:'oidc'. */
  issuer: string;
  audience: string;
  jwksUrl: string;
  userIdClaim: string;
  nameClaim: string;
  roleClaim: string;
  /** Claim containing feature permissions (string[]). */
  permissionsClaim: string;
  /** Claim that marks the identity as verified by the company. */
  verifiedClaim: string;
  /** OIDC authorization endpoint (mode:'oidc' only; dashboard SSO). */
  authorizationEndpoint: string;
  /** OIDC token endpoint (mode:'oidc' only; server-side code exchange). */
  tokenEndpoint: string;
  /**
   * Opt-in OIDC Discovery 1.0: fetch `<issuer>/.well-known/openid-configuration`
   * and use its authorization/token/jwks/end_session endpoints. Explicit
   * endpoint fields stay supported as a fallback and override individual
   * discovered values when set. Discovery is fetched server-side and validated
   * (the document `issuer` must equal the configured issuer).
   */
  discovery: boolean;
  /**
   * Optional explicit discovery document URL (for IdPs whose metadata is not at
   * the standard issuer path). Non-empty implies discovery even when
   * `discovery` is false. Must return a document for the configured issuer.
   */
  discoveryUrl: string;
  /** OAuth client id registered at the IdP for the dashboard. */
  clientId: string;
  /**
   * Name of the env variable holding the OAuth client secret (never the secret).
   * Restricted to the server-owned namespace `AGIL_OIDC_CLIENT_SECRET` or
   * `AGIL_OIDC_CLIENT_SECRET_*` — see {@link isAllowedOidcClientSecretEnv}.
   */
  clientSecretEnv: string;
  /** Registered redirect URI; empty = `<AGIL_PUBLIC_ORIGIN>/v1/auth/oidc/callback`. */
  redirectUri: string;
  /** Requested scopes; empty = `['openid']` (`openid` is always requested). */
  scopes: string[];
  /**
   * How the client secret is sent to the token endpoint:
   * `client_secret_post` (form body, default) or `client_secret_basic`
   * (HTTP Basic, RFC 6749 §2.3.1).
   */
  tokenEndpointAuthMethod: OidcTokenEndpointAuthMethod;
  /**
   * Authorization response mode: `query` (default) or `form_post`
   * (OAuth 2.0 Form Post Response Mode, used by e.g. Azure AD/ADFS).
   * `form_post` requires the callback POST route and, in a real browser, a
   * `SameSite=None; Secure` binding cookie (production HTTPS).
   */
  responseMode: OidcResponseMode;
  /**
   * IdP RP-initiated logout endpoint (OIDC `end_session_endpoint`). Empty =
   * resolved from discovery; still empty = RP-initiated logout unavailable and
   * the dashboard only revokes the local AGIL session.
   */
  endSessionEndpoint: string;
  /**
   * Registered `post_logout_redirect_uri` for RP-initiated logout. Empty =
   * `<AGIL_PUBLIC_ORIGIN>/v1/auth/oidc/logout/callback` (the server validates
   * the logout `state` there). A custom value must be registered at the IdP.
   */
  postLogoutRedirectUri: string;

  /* ------------------- access policy (all optional) ------------------- */

  /** Claim carrying the user's email address (used by the email allowlist). */
  emailClaim: string;
  /** Claim carrying the email-verified boolean (`email_verified` in OIDC). */
  emailVerifiedClaim: string;
  /**
   * Require `emailVerifiedClaim === true` (fail closed). When false, an explicit
   * `false` claim still denies; a missing claim is allowed.
   */
  requireEmailVerified: boolean;
  /** Exact email allowlist, case-insensitive. Empty = no exact-email rule. */
  allowedEmails: string[];
  /**
   * Email-domain allowlist, lower-case. `example.com` matches that domain exactly;
   * `*.example.com` matches only subdomains. Empty = no domain rule.
   */
  allowedEmailDomains: string[];
  /** Claim carrying group membership (`string[]` or space/comma-separated string). */
  groupsClaim: string;
  /** IdP-group → role mapping; non-empty = authoritative (see {@link GroupRoleMapping}). */
  groupRoleMap: GroupRoleMapping[];
  /**
   * Groups allowed to sign in to the dashboard. Empty = any identity the IdP
   * authenticates for this client gets a tenant admin session; set this to an
   * admin group to restrict it.
   */
  dashboardAdminGroups: string[];
  /**
   * Claim that must equal the tenant id (`TenantConfig.tenantId`). Guards against
   * replaying an id_token issued for another tenant that shares the same
   * issuer/audience. Empty = no tenant claim check (bind tenants by a unique
   * issuer/audience/client id instead).
   */
  tenantClaim: string;
  /** Maximum accepted `exp - iat` in seconds; 0 = no limit. */
  maxTokenAgeSec: number;
  /** Clock skew applied to `exp`/`nbf`/`iat`, seconds (0..300). */
  clockSkewSec: number;
}

/**
 * Server-owned env-var namespace for OIDC client secrets. A tenant config may
 * only *name* a variable in this namespace; the secret value itself never lives
 * in the config and is read by the server at startup (see `env.ts`). This keeps
 * tenant input from selecting an arbitrary `process.env` entry (e.g.
 * `AGIL_TOKEN_SECRET`).
 */
export const OIDC_CLIENT_SECRET_ENV_PREFIX = 'AGIL_OIDC_CLIENT_SECRET';

/**
 * Optional server-owned map from tenant id to OIDC client-secret env name, used
 * for a legacy/global name (or a tenant id the naming convention cannot
 * express): `AGIL_OIDC_TENANT_SECRETS="demo=AGIL_OIDC_CLIENT_SECRET,..."`.
 */
export const OIDC_TENANT_SECRETS_ENV = 'AGIL_OIDC_TENANT_SECRETS';

const OIDC_CLIENT_SECRET_ENV_RE = /^AGIL_OIDC_CLIENT_SECRET(?:_[A-Za-z0-9_]+)?$/;

/**
 * Convention: `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>`. The tenant segment is
 * a single alphanumeric token matched against the canonical (lower-case)
 * tenant id, so it cannot alias `a-b`/`a_b`/`a.b`/`A_B` or `demo`/`DEMO`.
 * Such ids must use {@link OIDC_TENANT_SECRETS_ENV} instead.
 */
const OIDC_CLIENT_SECRET_ENV_TENANT_RE = /^AGIL_OIDC_CLIENT_SECRET_([A-Za-z0-9]+)_([A-Za-z0-9_]+)$/;

/**
 * True when `name` is an acceptable `integrations.identity.clientSecretEnv`
 * value: empty (not configured), `AGIL_OIDC_CLIENT_SECRET`, or a
 * `AGIL_OIDC_CLIENT_SECRET_<suffix>` variant. This is the *namespace* check;
 * {@link isOidcClientSecretEnvBoundToTenant} additionally enforces the
 * tenant binding. Everything else is rejected at config-write time and again
 * at code-exchange time.
 */
export function isAllowedOidcClientSecretEnv(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const value = name.trim();
  if (value.length === 0) return true;
  if (value.length > 100) return false;
  return OIDC_CLIENT_SECRET_ENV_RE.test(value);
}

/**
 * Lossy tenant label: upper-case with non-alphanumeric runs folded to `_`
 * (`a-b`, `a_b`, `a.b`, `A_B` all become `A_B`, and `demo`/`DEMO` both become
 * `DEMO`).
 *
 * @deprecated Do **not** use for authorization decisions. It cannot distinguish
 * colliding tenant ids; use {@link oidcConventionTenantSegment} (exact
 * convention match) or the explicit `AGIL_OIDC_TENANT_SECRETS` map (exact
 * tenant id). Kept exported for display/diagnostics compatibility.
 */
export function normalizeOidcTenantSegment(tenantId: unknown): string {
  if (typeof tenantId !== 'string') return '';
  return tenantId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Tenant segment the naming convention accepts for `tenantId`, or `''` when
 * the id cannot safely use the convention.
 *
 * Only canonical tenant ids (lower-case ASCII letters/digits) may use
 * `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>`; their segment is the upper-case id
 * (`demo` -> `DEMO`). Ids that would collide after folding
 * (`a-b`/`a_b`/`a.b`/`A_B`, `demo`/`DEMO`) must use the explicit
 * {@link OIDC_TENANT_SECRETS_ENV} map with the exact tenant id.
 */
export function oidcConventionTenantSegment(tenantId: unknown): string {
  if (typeof tenantId !== 'string') return '';
  const id = tenantId.trim();
  if (!/^[a-z0-9]{1,64}$/.test(id)) return '';
  return id.toUpperCase();
}

/**
 * Tenant derived from the naming convention, or `null` when `name` is not
 * `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>` (e.g. the global
 * `AGIL_OIDC_CLIENT_SECRET` or an unbound `..._<NAME>` legacy name).
 */
export function oidcClientSecretEnvTenant(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const match = OIDC_CLIENT_SECRET_ENV_TENANT_RE.exec(name.trim());
  if (!match) return null;
  return (match[1] ?? '').toUpperCase();
}

/**
 * True when `name` may be selected by `tenantId`: an allowlisted name must be
 * tenant-bound, not just sit in the global `AGIL_OIDC_CLIENT_SECRET_*`
 * namespace. Empty = not configured and always acceptable.
 *
 * An explicit {@link OIDC_TENANT_SECRETS_ENV} entry is authoritative and is
 * compared by **exact, case-sensitive tenant id**: `demo` does not authorize
 * `DEMO`, and `a-b` does not authorize `a_b`, `a.b` or `A_B`. A name mapped to
 * more than one tenant is ambiguous and rejected (fail closed).
 *
 * Without a map entry, the naming convention is used; only canonical
 * lower-case tenant ids can use it (see {@link oidcConventionTenantSegment}).
 */
export function isOidcClientSecretEnvBoundToTenant(
  name: unknown,
  tenantId: unknown,
  tenantSecrets: Readonly<Record<string, string>> = {},
): boolean {
  if (typeof name !== 'string') return false;
  const value = name.trim();
  if (value.length === 0) return true;
  if (!isAllowedOidcClientSecretEnv(value)) return false;
  if (typeof tenantId !== 'string' || tenantId.length === 0) return false;

  // Explicit map wins over the convention (both allow and deny). Compare the
  // exact tenant id: normalising would let a-b/a_b/a.b/A_B select each other.
  const mappedOwners: string[] = [];
  for (const [mappedTenant, mappedName] of Object.entries(tenantSecrets)) {
    if (mappedName === value) mappedOwners.push(mappedTenant);
  }
  if (mappedOwners.length > 0) {
    // A name owned by two tenants is ambiguous. The startup parser drops such
    // names; a direct map object must fail closed here as well.
    return mappedOwners.length === 1 && mappedOwners[0] === tenantId;
  }

  const conventionTenant = oidcConventionTenantSegment(tenantId);
  if (!conventionTenant) return false;
  return oidcClientSecretEnvTenant(value) === conventionTenant;
}

const identityRoleSchema = z.enum(['host', 'moderator', 'guest']);

export const identityConfigSchema = z.object({
  mode: z.enum(['token', 'oidc']),
  issuer: z.string().max(300),
  audience: z.string().max(200),
  jwksUrl: z.string().max(500),
  userIdClaim: z.string().max(100),
  nameClaim: z.string().max(100),
  roleClaim: z.string().max(100),
  permissionsClaim: z.string().max(100),
  verifiedClaim: z.string().max(100),
  // Defaults keep tenant configs without SSO fields valid (the tenant store
  // drops configs that fail validation).
  authorizationEndpoint: z.string().max(500).default(''),
  tokenEndpoint: z.string().max(500).default(''),
  discovery: z.boolean().default(false),
  discoveryUrl: z.string().max(500).default(''),
  clientId: z.string().max(200).default(''),
  clientSecretEnv: z.string().max(100).default(''),
  redirectUri: z.string().max(500).default(''),
  scopes: z.array(z.string().max(100)).max(20).default([]),
  tokenEndpointAuthMethod: z.enum(OIDC_TOKEN_ENDPOINT_AUTH_METHODS).default('client_secret_post'),
  responseMode: z.enum(OIDC_RESPONSE_MODES).default('query'),
  endSessionEndpoint: z.string().max(500).default(''),
  postLogoutRedirectUri: z.string().max(500).default(''),
  emailClaim: z.string().max(100).default('email'),
  emailVerifiedClaim: z.string().max(100).default('email_verified'),
  requireEmailVerified: z.boolean().default(false),
  allowedEmails: z.array(z.string().max(320)).max(200).default([]),
  allowedEmailDomains: z.array(z.string().max(253)).max(100).default([]),
  groupsClaim: z.string().max(100).default('groups'),
  groupRoleMap: z
    .array(z.object({ group: z.string().min(1).max(200), role: identityRoleSchema }))
    .max(100)
    .default([]),
  dashboardAdminGroups: z.array(z.string().max(200)).max(100).default([]),
  tenantClaim: z.string().max(100).default(''),
  maxTokenAgeSec: z.number().int().min(0).max(7 * 86400).default(0),
  clockSkewSec: z.number().int().min(0).max(300).default(60),
});

/** `GET /v1/auth/oidc/start` response (mode:'oidc' only). */
export interface OidcStartResponse {
  authorizationUrl: string;
  /** Unix ms when the state/PKCE entry expires (10 min by default). */
  expiresAt: number;
}

/**
 * `GET /v1/auth/oidc/logout` response: the IdP RP-initiated logout URL
 * (`end_session_endpoint` + `post_logout_redirect_uri` + single-use `state`).
 * The browser is expected to navigate there; local revocation stays separate.
 */
export interface OidcLogoutResponse {
  logoutUrl: string;
  /** Unix ms when the pending logout state expires. */
  expiresAt: number;
}

export interface SiemConfig {
  enabled: boolean;
  /** SIEM collector URL (HTTPS in production). */
  url: string;
  format: 'json' | 'cef';
  /** Name of the env variable holding the optional HMAC secret. */
  secretEnv: string;
  /** Audit event types to forward; empty = all. */
  events: string[];
  timeoutMs: number;
  retries: number;
}

export const siemConfigSchema = z.object({
  enabled: z.boolean(),
  url: z.string().max(500),
  format: z.enum(['json', 'cef']),
  secretEnv: z.string().max(100),
  events: z.array(z.string().max(80)).max(100),
  timeoutMs: z.number().int().min(500).max(30000),
  retries: z.number().int().min(0).max(10),
});

export interface IntegrationsConfig {
  webhooks: WebhookEndpointConfig[];
  identity: IdentityConfig;
  /** SIEM audit export (off by default). */
  siem: SiemConfig;
  /** Origins allowed to embed the widget/iframe (CSP frame-ancestors + checks). */
  allowedOrigins: string[];
  /** Allow the host page to drive the iframe through the postMessage API. */
  embedPostMessage: boolean;
}

export const integrationsConfigSchema = z.object({
  webhooks: z.array(webhookEndpointSchema).max(20),
  identity: identityConfigSchema,
  siem: siemConfigSchema,
  allowedOrigins: z.array(z.string().max(300)),
  embedPostMessage: z.boolean(),
});

export const DEFAULT_INTEGRATIONS: IntegrationsConfig = {
  webhooks: [],
  identity: {
    mode: 'token',
    issuer: '',
    audience: '',
    jwksUrl: '',
    userIdClaim: 'sub',
    nameClaim: 'name',
    roleClaim: 'role',
    permissionsClaim: 'permissions',
    verifiedClaim: 'verified',
    authorizationEndpoint: '',
    tokenEndpoint: '',
    discovery: false,
    discoveryUrl: '',
    clientId: '',
    clientSecretEnv: '',
    redirectUri: '',
    scopes: [],
    tokenEndpointAuthMethod: 'client_secret_post',
    responseMode: 'query',
    endSessionEndpoint: '',
    postLogoutRedirectUri: '',
    emailClaim: 'email',
    emailVerifiedClaim: 'email_verified',
    requireEmailVerified: false,
    allowedEmails: [],
    allowedEmailDomains: [],
    groupsClaim: 'groups',
    groupRoleMap: [],
    dashboardAdminGroups: [],
    tenantClaim: '',
    maxTokenAgeSec: 0,
    clockSkewSec: 60,
  },
  siem: {
    enabled: false,
    url: '',
    format: 'json',
    secretEnv: '',
    events: [],
    timeoutMs: 3000,
    retries: 2,
  },
  allowedOrigins: [],
  embedPostMessage: true,
};

/** Header names used for webhook HMAC signing (hex HMAC-SHA256 of the raw body). */
export const WEBHOOK_SIGNATURE_HEADER = 'x-agil-signature';
export const WEBHOOK_DELIVERY_HEADER = 'x-agil-delivery';
export const WEBHOOK_EVENT_HEADER = 'x-agil-event';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-agil-timestamp';
