/**
 * Tenant-config references to server secrets (`apiKeyEnv`, `secretEnv`,
 * `credentialEnv`, …).
 *
 * Security invariant: a config field may only name a variable inside a
 * server-owned namespace. The server snapshots those names at startup and
 * resolves references against the snapshot only — never `process.env` by
 * tenant input. Validation runs both when the config is written and again when
 * the secret is used.
 */

/** Which server-owned namespace a tenant config field may reference. */
export type TenantSecretEnvKind = 'integration' | 'webhook' | 'siem' | 'sfu' | 'turn' | 'route';

export const TENANT_SECRET_ENV_KINDS: readonly TenantSecretEnvKind[] = [
  'integration',
  'webhook',
  'siem',
  'sfu',
  'turn',
  'route',
];

/**
 * Accepted prefix per kind:
 *  - `integration` — `session.*.apiKeyEnv` (AI/knowledge/in-call agents) and
 *    `providers.<slot>.apiKeyEnv` (chat/files/STT/notifications/…);
 *  - `webhook`     — `integrations.webhooks[].secretEnv`;
 *  - `siem`        — `integrations.siem.secretEnv`;
 *  - `sfu`         — `scale.sfu.apiKeyEnv` / `apiSecretEnv`;
 *  - `turn`        — `scale.turn[].credentialEnv`;
 *  - `route`       — `routing` stream destinations' `secretRef` (an RTMP URL
 *    with its stream key, resolved at egress start and never returned).
 */
export const TENANT_SECRET_ENV_PREFIX: Record<TenantSecretEnvKind, string> = {
  integration: 'AGIL_INTEGRATION_',
  webhook: 'AGIL_WEBHOOK_',
  siem: 'AGIL_SIEM_',
  sfu: 'AGIL_SFU_',
  turn: 'AGIL_TURN_',
  route: 'AGIL_ROUTE_SECRET_',
};

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{2,99}$/;

/**
 * Fixed, server-owned legacy names kept for backward compatibility; new
 * deployments use `AGIL_INTEGRATION_*`.
 */
const LEGACY_INTEGRATION_ENV_NAMES: ReadonlySet<string> = new Set([
  'AGIL_AI_AGENT_KEY',
  'AGIL_KNOWLEDGE_AGENT_KEY',
  'AGIL_INCALL_AGENT_KEY',
  'AGIL_CHAT_PROVIDER_KEY',
  'AGIL_FILES_PROVIDER_KEY',
  'AGIL_STT_PROVIDER_KEY',
  'AGIL_NOTIFICATIONS_PROVIDER_KEY',
  'AGIL_RECORDING_PROVIDER_KEY',
  'AGIL_BACKGROUNDS_PROVIDER_KEY',
]);

/**
 * Server tuning knobs that share a secret namespace prefix but are **not**
 * secrets; excluding them keeps the allowlist secret-only.
 */
const NON_SECRET_ENV_NAMES: ReadonlySet<string> = new Set([
  'AGIL_WEBHOOK_TIMEOUT_MS',
  'AGIL_WEBHOOK_RETRIES',
  'AGIL_SFU_URL',
  'AGIL_SFU_ENABLED',
  'AGIL_SFU_NODE_ID',
  'AGIL_SFU_NODES',
  'AGIL_SFU_PROFILE',
]);

/**
 * True when `name` is an acceptable secret reference for `kind`: empty (field
 * not configured) or a variable in that kind's server-owned namespace.
 */
export function isAllowedTenantSecretEnv(name: unknown, kind: TenantSecretEnvKind): boolean {
  if (typeof name !== 'string') return false;
  const value = name.trim();
  if (value.length === 0) return true;
  if (value !== name) return false;
  if (!ENV_NAME_RE.test(value)) return false;
  if (NON_SECRET_ENV_NAMES.has(value)) return false;
  const prefix = TENANT_SECRET_ENV_PREFIX[kind];
  if (value.length > prefix.length && value.startsWith(prefix)) return true;
  if (kind === 'integration' && LEGACY_INTEGRATION_ENV_NAMES.has(value)) return true;
  return false;
}

/**
 * True when `name` belongs to *any* server-owned secret namespace. Used when
 * snapshotting `process.env` at startup: only these names are ever available
 * to tenant config, even if the config names something else.
 */
export function isAllowedTenantSecretEnvName(name: unknown): boolean {
  return TENANT_SECRET_ENV_KINDS.some((kind) => isAllowedTenantSecretEnv(name, kind));
}

/** Human-readable rule for API errors and docs (e.g. `AGIL_WEBHOOK_*`). */
export function tenantSecretEnvRule(kind: TenantSecretEnvKind): string {
  return `${TENANT_SECRET_ENV_PREFIX[kind]}*`;
}

/** All accepted names for `kind` (prefix wildcard plus legacy exact names). */
export function describeTenantSecretEnv(kind: TenantSecretEnvKind): string {
  if (kind === 'integration') {
    return `${TENANT_SECRET_ENV_PREFIX.integration}* (legacy: ${[...LEGACY_INTEGRATION_ENV_NAMES].join(', ')})`;
  }
  return `${TENANT_SECRET_ENV_PREFIX[kind]}*`;
}

/**
 * Normalises a config value before it is compared/stored. Returns `''` for a
 * non-string. Unlike {@link isAllowedTenantSecretEnv}, this does not validate.
 */
export function normaliseTenantSecretEnvRef(name: unknown): string {
  return typeof name === 'string' ? name.trim() : '';
}
