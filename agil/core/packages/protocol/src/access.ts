/**
 * Effective permissions for a call participant. The resulting feature list is
 * sent to the widget on join, so UI gating and server-side enforcement agree.
 *
 * Resolution order (later wins):
 *   1. role defaults from `security.accessPolicy.roleDefaults` (unless strict);
 *   2. per-user override `userOverrides[userId]` (replaces the list);
 *   3. token permissions from the access token (replaces the list — issuer decides);
 *   4. remove `deniedFeatures`;
 *   5. intersect with enabled `config.features` flags.
 */
import type { AccessPolicy, FeatureKey, TenantConfig } from './config.js';
import type { Role } from './signaling.js';

export interface AccessContext {
  config: TenantConfig;
  role: Role;
  /** Optional stable user id used for per-user overrides. */
  userId?: string;
  /** Permissions pinned by the token issuer (replaces defaults). */
  tokenPermissions?: FeatureKey[];
  /** Custom role id (from `security.accessPolicy.customRoles`). */
  roleId?: string;
}

export interface AccessResolution {
  allowed: FeatureKey[];
  denied: FeatureKey[];
  /** Which source produced the base list. */
  source: 'role-defaults' | 'user-override' | 'token' | 'strict' | 'custom-role';
  role: Role;
  /** Custom role that was applied, if any. */
  roleId?: string;
  roleName?: string;
}

function normalise(list: readonly string[]): Set<FeatureKey> {
  const enabled = new Set<FeatureKey>();
  for (const key of list) enabled.add(key as FeatureKey);
  return enabled;
}

function policyFor(config: TenantConfig): AccessPolicy {
  return config.security.accessPolicy;
}

/** Finds a company-defined role by id. */
export function findCustomRole(config: TenantConfig, roleId: string | undefined): import('./config.js').CustomRole | undefined {
  if (!roleId) return undefined;
  return config.security.accessPolicy.customRoles.find((role) => role.id === roleId);
}

/** Computes the effective feature list for one participant. */
export function resolveAccess(context: AccessContext): AccessResolution {
  const { config, role, userId, tokenPermissions, roleId } = context;
  const policy = policyFor(config);
  const all = Object.keys(config.features) as FeatureKey[];
  const customRole = findCustomRole(config, roleId);
  let base: Set<FeatureKey>;
  let source: AccessResolution['source'];

  if (Array.isArray(tokenPermissions) && tokenPermissions.length > 0) {
    base = normalise(tokenPermissions);
    source = 'token';
  } else if (userId && Array.isArray(policy.userOverrides[userId])) {
    base = normalise(policy.userOverrides[userId] ?? []);
    source = 'user-override';
  } else if (customRole) {
    base = normalise(customRole.features);
    source = 'custom-role';
  } else if (policy.mode === 'strict') {
    base = new Set<FeatureKey>();
    source = 'strict';
  } else {
    base = normalise(policy.roleDefaults[role] ?? []);
    source = 'role-defaults';
  }

  for (const denied of policy.deniedFeatures) base.delete(denied);

  const allowed: FeatureKey[] = [];
  const denied: FeatureKey[] = [];
  for (const key of all) {
    if (base.has(key) && config.features[key] === true) allowed.push(key);
    else denied.push(key);
  }
  return {
    allowed,
    denied,
    source,
    role,
    roleId: customRole?.id,
    roleName: customRole?.name,
  };
}

/** Convenience predicate for both server and widget. */
export function isFeatureAllowed(context: AccessContext, feature: FeatureKey): boolean {
  const policy = policyFor(context.config);
  if (!context.config.features[feature]) return false;
  if (policy.deniedFeatures.includes(feature)) return false;
  const resolved = resolveAccess({ ...context });
  return resolved.allowed.includes(feature);
}

export interface KnowledgeAgentAccess {
  allowed: boolean;
  reason?: 'disabled' | 'role' | 'permission' | 'not_configured';
  denyMessage?: string;
}

/** Whether a participant may ask the corporate knowledge agent (wiki/RAG). */
export function resolveKnowledgeAgentAccess(context: AccessContext): KnowledgeAgentAccess {
  const agent = context.config.session.knowledgeAgent;
  if (!agent.enabled) return { allowed: false, reason: 'disabled' };
  if (!agent.allowedRoles.includes(context.role)) {
    return { allowed: false, reason: 'role', denyMessage: agent.denyMessage };
  }
  if (agent.requirePermission) {
    const resolved = resolveAccess(context);
    if (!resolved.allowed.includes('knowledgeAgent')) {
      return { allowed: false, reason: 'permission', denyMessage: agent.denyMessage };
    }
  }
  if (!agent.endpoint) return { allowed: false, reason: 'not_configured' };
  return { allowed: true };
}

/** Short human-readable summary for dashboards and MCP tools. */
export function describeAccess(resolution: AccessResolution): string {
  return `role=${resolution.role} source=${resolution.source} allowed=${resolution.allowed.length}/${resolution.allowed.length + resolution.denied.length}`;
}
