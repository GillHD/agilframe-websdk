/**
 * Cluster / Node enrollment + Core leader-election contract.
 *
 * A leader Core issues one-time enrollment tokens. A standby Core redeems a
 * `core` token through `POST /v1/cluster/join`; an SFU/TURN/STUN/all-in-one Node
 * redeems a `node` token through `POST /v1/nodes/register` and then keeps its
 * liveness with `POST /v1/nodes/:id/heartbeat`.
 *
 * Tokens are hashed at rest, TTL- and use-limited and revocable; the node
 * registry is file-backed. With `AGIL_REDIS_URL` set, Cores elect one leader
 * through a Redis lease; without Redis a single Core runs standalone. Room
 * state, tenant config and the node registry are **not** replicated — only the
 * leader lease and its heartbeat are shared.
 */
import { z } from 'zod';

/**
 * Roles a Core can have. With `AGIL_REDIS_URL` the role is decided by the lease
 * (one leader, the rest standby); without Redis `AGIL_CLUSTER_ROLE` pins it.
 */
export const clusterRoles = ['leader', 'standby'] as const;
export const clusterRoleSchema = z.enum(clusterRoles);
export type ClusterRole = z.infer<typeof clusterRoleSchema>;

/** How a Core derives its role: standalone (no Redis) or a Redis lease. */
export const clusterModes = ['standalone', 'redis'] as const;
export const clusterModeSchema = z.enum(clusterModes);
export type ClusterMode = z.infer<typeof clusterModeSchema>;

/** Leader-lease defaults and hard bounds (milliseconds). */
export const LEADER_LEASE_DEFAULT_TTL_MS = 10_000;
export const LEADER_LEASE_MIN_TTL_MS = 2_000;
export const LEADER_LEASE_MAX_TTL_MS = 120_000;
/** Renewal must happen well before expiry; the default is TTL / 3. */
export const LEADER_RENEW_SAFETY_FACTOR = 3;

/** Node roles. `all` = all-in-one node (signaling + SFU + TURN/STUN). */
export const nodeRoles = ['sfu', 'turn', 'stun', 'all'] as const;
export const nodeRoleSchema = z.enum(nodeRoles);
export type NodeRole = z.infer<typeof nodeRoleSchema>;

/** Derived node status (never stored verbatim except `disabled`/`draining`). */
export const nodeStatuses = ['online', 'offline', 'draining', 'disabled'] as const;
export const nodeStatusSchema = z.enum(nodeStatuses);
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

/** Kind of one-time enrollment token. */
export const enrollmentKinds = ['core', 'node'] as const;
export const enrollmentKindSchema = z.enum(enrollmentKinds);
export type EnrollmentKind = z.infer<typeof enrollmentKindSchema>;

/** Any role an enrollment token can carry (Core role or Node role). */
export const enrollmentRoleSchema = z.enum([...clusterRoles, ...nodeRoles] as const);
export type EnrollmentRole = z.infer<typeof enrollmentRoleSchema>;

export const enrollmentStatuses = ['active', 'used', 'expired', 'revoked'] as const;
export const enrollmentTokenStatusSchema = z.enum(enrollmentStatuses);
export type EnrollmentTokenStatus = z.infer<typeof enrollmentTokenStatusSchema>;

/** Cluster / node ids are short, URL-safe and case-sensitive. */
export const clusterIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, 'must be 1..64 URL-safe characters');

/** A tenant may clear a managed provider binding with an empty string. */
export const managedNodeIdSchema = z.string().trim().refine((id) => id === '' || clusterIdSchema.safeParse(id).success);

/** Feature ids are lowercase technical tokens (`sfu`, `egress`, `turn`, ...). */
export const nodeFeatureSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]{0,31}$/, 'must be a lowercase feature id');

export const nodeFeaturesSchema = z.array(nodeFeatureSchema).max(16);

/** Reported node capacity (0 = not reported). */
export const nodeCapacitySchema = z.object({
  maxRooms: z.number().int().min(0).max(1_000_000).default(0),
  maxParticipants: z.number().int().min(0).max(10_000_000).default(0),
  bandwidthMbps: z.number().int().min(0).max(1_000_000).default(0),
});
export type NodeCapacity = z.infer<typeof nodeCapacitySchema>;

/** Partial capacity for registration/heartbeat and admin patches. */
export const nodeCapacityInputSchema = z.object({
  maxRooms: z.number().int().min(0).max(1_000_000).optional(),
  maxParticipants: z.number().int().min(0).max(10_000_000).optional(),
  bandwidthMbps: z.number().int().min(0).max(1_000_000).optional(),
});
export type NodeCapacityInput = z.infer<typeof nodeCapacityInputSchema>;

/** Hard upper bounds for metric inputs (inclusive). */
const NODE_METRICS_LOAD1_MAX = 1_000_000;
const NODE_METRICS_ACTIVE_ROOMS_MAX = 1_000_000;
const NODE_METRICS_PARTICIPANTS_MAX = 10_000_000;
const NODE_METRICS_BANDWIDTH_MAX = 1_000_000;
/** 10 years of uptime is already more than any node will report. */
const NODE_METRICS_UPTIME_SEC_MAX = 10 * 365 * 24 * 3600;

/**
 * Live node statistics reported on heartbeat (docs/api/cluster.md §3.2). Every
 * field is optional: a node reports what it can measure and the Core merges the
 * defined values into the last snapshot instead of erasing absent ones. Values
 * must be finite and inside the documented range — the server never invents or
 * zero-fills a metric (missing = "not reported", not 0).
 */
const nodeMetricFields = {
  /** CPU utilisation, 0..100 % (fractions allowed). */
  cpuPercent: z.number().min(0).max(100).optional(),
  /** Memory utilisation, 0..100 % (fractions allowed). */
  memoryPercent: z.number().min(0).max(100).optional(),
  /** 1-minute load average (not normalised by core count). */
  load1: z.number().min(0).max(NODE_METRICS_LOAD1_MAX).optional(),
  /** Rooms currently hosted on the node. */
  activeRooms: z.number().int().min(0).max(NODE_METRICS_ACTIVE_ROOMS_MAX).optional(),
  /** Participants currently connected to the node. */
  participants: z.number().int().min(0).max(NODE_METRICS_PARTICIPANTS_MAX).optional(),
  /** Aggregate media bandwidth 0..1000000 Mbps (fractions allowed). */
  bandwidthMbps: z.number().min(0).max(NODE_METRICS_BANDWIDTH_MAX).optional(),
  /** Node process/host uptime in seconds (fractions allowed). */
  uptimeSec: z.number().min(0).max(NODE_METRICS_UPTIME_SEC_MAX).optional(),
  /** Node agent build/version string (separate from the registration `version`). */
  version: z.string().trim().min(1).max(32).optional(),
};

export const nodeMetricsInputSchema = z.object({
  ...nodeMetricFields,
  /**
   * Client capture time (epoch ms). Optional; when omitted the Core stamps its
   * receipt time so the returned snapshot always has an honest `reportedAt`.
   */
  reportedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type NodeMetricsInput = z.infer<typeof nodeMetricsInputSchema>;

/** Stored/returned live metrics snapshot — always carries `reportedAt`. */
export const nodeMetricsSchema = z.object({
  ...nodeMetricFields,
  reportedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type NodeMetrics = z.infer<typeof nodeMetricsSchema>;

/** Cluster identity: the leader Core, or a standby that has joined it. */
export const clusterSchema = z.object({
  id: clusterIdSchema,
  role: clusterRoleSchema,
  version: z.string().min(1).max(32),
});
export type Cluster = z.infer<typeof clusterSchema>;

/* ------------------------------------------------------------------ */
/* Per-node modules (Docker add-on packages)                           */
/* ------------------------------------------------------------------ */

/**
 * Per-node modules are a **Core-controlled allowlist** of Docker add-on
 * packages. The node agent reports which modules are installed and in which
 * state; the dashboard only ever asks the Core to queue one of the allowlisted
 * `start|stop|restart|install|remove` actions. An image/command supplied by the
 * dashboard is never accepted — the Core resolves the image from its catalog.
 *
 * The catalog ids below are the only module ids a node may report or an operator
 * may control. Adding a module is a protocol/server change on purpose: it is an
 * allowlist, not a free-form plugin registry.
 */
export const nodeModuleKinds = ['egress', 'stt', 'recorder', 'turn', 'sip', 'ingress', 'sfu'] as const;
export const nodeModuleKindSchema = z.enum(nodeModuleKinds);
export type NodeModuleKind = z.infer<typeof nodeModuleKindSchema>;
/** This module is provisioned by a node operator and can target a reported Docker ID. */
export function isOperatorManagedNodeModule(id: string): boolean {
  return id === 'ingress' || id === 'sfu';
}

/** Lifecycle state of a container-backed module as reported by its node. */
export const nodeModuleStatuses = ['running', 'stopped', 'error', 'installing', 'unknown'] as const;
export const nodeModuleStatusSchema = z.enum(nodeModuleStatuses);
export type NodeModuleStatus = z.infer<typeof nodeModuleStatusSchema>;

/** Health as reported by the node agent (separate from the lifecycle status). */
export const nodeModuleHealths = ['healthy', 'degraded', 'unhealthy', 'unknown'] as const;
export const nodeModuleHealthSchema = z.enum(nodeModuleHealths);
export type NodeModuleHealth = z.infer<typeof nodeModuleHealthSchema>;

/** Cross-module action ids the Core may queue for a node. */
export const nodeModuleActions = [
  'start', 'stop', 'restart', 'install', 'remove', 'enable-autostart', 'disable-autostart',
] as const;
export const nodeModuleActionSchema = z.enum(nodeModuleActions);
export type NodeModuleAction = z.infer<typeof nodeModuleActionSchema>;

export const customNodeModuleActions = ['start', 'stop', 'restart'] as const;
const customTemplateModuleActions = [...customNodeModuleActions, 'remove'] as const;
export type CustomNodeModuleAction = typeof customTemplateModuleActions[number];
export function isCustomNodeModuleAction(action: NodeModuleAction): action is CustomNodeModuleAction {
  return customTemplateModuleActions.some((candidate) => candidate === action);
}

export const nodeModuleContainerIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

export function isNodeModuleAutoStartAction(action: NodeModuleAction): boolean {
  return action === 'enable-autostart' || action === 'disable-autostart';
}

/** An inventory module identifier (`^[a-z][a-z0-9-]{0,31}$`). */
const NODE_MODULE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const nodeModuleIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(NODE_MODULE_ID_RE, 'must be a lowercase module id');

/** Command ids are server-generated (`nmc_<16 hex>`) and never client input. */
const NODE_MODULE_COMMAND_ID_RE = /^nmc_[0-9a-f]{16}$/;
export const nodeModuleCommandIdSchema = z
  .string()
  .regex(NODE_MODULE_COMMAND_ID_RE, 'must be a generated module command id');

/** Docker image reference: repo[:tag][@sha256:digest], no whitespace/secrets. */
const NODE_MODULE_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
export const nodeModuleImageSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(NODE_MODULE_IMAGE_RE, 'must be a Docker image reference')
  .refine((value) => !value.includes('//') && !value.endsWith(':') && !value.endsWith('/'), {
    message: 'must be a valid Docker image reference',
  });

const NODE_PINNED_TEMPLATE_IMAGE_RE = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?)\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/;
export const nodeTemplateResourceDefaults = Object.freeze({ cpuMillicores: 500, memoryMiB: 256, pidsLimit: 64 });
export const nodeTemplateResourcesSchema = z.strictObject({
  cpuMillicores: z.number().int().min(100).max(8_000),
  memoryMiB: z.number().int().min(64).max(8_192),
  pidsLimit: z.number().int().min(16).max(512),
});
export const nodeTemplateImageSchema = nodeModuleImageSchema.refine((image) => {
    const registry = NODE_PINNED_TEMPLATE_IMAGE_RE.exec(image)?.[1];
    if (!registry) return false;
    const [host = '', port] = registry.split(':');
    return (host === 'localhost' || host.includes('.') || port !== undefined) &&
      (port === undefined || (Number(port) > 0 && Number(port) <= 65535));
}, { message: 'must use an explicit registry and a pinned sha256 digest' });
export const nodeCustomModuleTemplateSchema = z.strictObject({
  id: nodeModuleIdSchema.refine((id) => !nodeModuleKindSchema.safeParse(id).success),
  image: nodeTemplateImageSchema,
  cached: z.boolean(),
  installable: z.literal(true).optional(),
  blockedReason: z.enum(['image_not_cached', 'image_incompatible', 'inspection_failed', 'environment_unavailable', 'storage_unavailable', 'network_unavailable']).optional(),
  resources: nodeTemplateResourcesSchema.optional(),
  storage: z.literal('read_only').optional(),
  profileChanged: z.literal(true).optional(),
  privatePorts: z.array(z.object({ port: z.number().int().min(1).max(65535), protocol: z.enum(['tcp', 'udp']) }).strict())
    .min(1).max(8).refine((ports) => new Set(ports.map(({ port, protocol }) => `${port}/${protocol}`)).size === ports.length).optional(),
});
export type NodeCustomModuleTemplate = z.infer<typeof nodeCustomModuleTemplateSchema>;
export const nodeCustomModuleTemplatesSchema = z.array(nodeCustomModuleTemplateSchema).max(16)
  .refine((templates) => new Set(templates.map(({ id }) => id)).size === templates.length, {
    message: 'must use unique custom template ids',
  });

/**
 * Repository part of a Docker image reference (`registry:5000/agil/egress:1.2`
 * → `registry:5000/agil/egress`). The Core allowlist matches on the repository,
 * so a tag/digest bump does not require a protocol change while a different
 * image is still rejected.
 */
export function nodeModuleImageRepository(image: string): string {
  const at = image.indexOf('@');
  const withoutDigest = at >= 0 ? image.slice(0, at) : image;
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

/** Official workers installed by Compose and observed through Inventory. */
export function isComposeProvisionedNodeModuleImage(id: string, image: string): boolean {
  const repository = nodeModuleImageRepository(image).toLowerCase().replace(/^docker\.io\//, '');
  return (id === 'egress' && repository === 'livekit/egress') || (id === 'sip' && repository === 'livekit/sip');
}

/** Hard bounds shared by the protocol, the Core and the node agent. */
export const NODE_MODULE_MAX_ITEMS = 32;
export const NODE_MODULE_MAX_PORTS = 8;
export const NODE_MODULE_MAX_ERROR_CHARS = 300;
/** TTL of a queued command: delivered once, dropped if not acked in time. */
export const NODE_MODULE_COMMAND_TTL_SEC = 300;
export const NODE_MODULE_COMMAND_TTL_MS = NODE_MODULE_COMMAND_TTL_SEC * 1000;
/** Max queued+in-flight commands per node (oldest are pruned by the Core). */
export const NODE_MODULE_COMMAND_MAX_QUEUE = 16;

const nodeModulePortsSchema = z
  .array(z.number().int().min(1).max(65_535))
  .max(NODE_MODULE_MAX_PORTS);

const nodeModuleVersionSchema = z.string().trim().max(32);

/** Module inventory entry as returned by the Core (`GET /v1/admin/nodes`). */
export const nodeModuleSchema = z.object({
  /** Catalog id or operator-defined id from the node. */
  id: nodeModuleIdSchema,
  /** Catalog type or the node's operator-defined classification. */
  kind: nodeModuleIdSchema,
  /** Display name (agent-reported, catalog fallback). */
  name: z.string().trim().min(1).max(80),
  /** Installed module/agent version; `''` = not reported. */
  version: nodeModuleVersionSchema,
  /** Docker image reference from inventory. Catalog ids use allowlisted repositories. */
  image: nodeModuleImageSchema,
  status: nodeModuleStatusSchema,
  health: nodeModuleHealthSchema,
  /** Docker restart policy, when reported and configurable by this agent. */
  autoStart: z.boolean().optional(),
  /** Present only for a locally approved, currently eligible custom container. */
  lifecycleContainerId: nodeModuleContainerIdSchema.optional(),
  sfuDrainState: z.enum(['available', 'requested', 'restart_requested']).optional(),
  templateRemovable: z.literal(true).optional(),
  /** Published container ports reported by the node (informational). */
  ports: nodeModulePortsSchema,
  /** Epoch ms of the last state update; Core receipt time when the agent omitted it. */
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** Last error text reported by the agent; absent when the module is healthy. */
  lastError: z.string().trim().min(1).max(NODE_MODULE_MAX_ERROR_CHARS).optional(),
});
export type NodeModule = z.infer<typeof nodeModuleSchema>;

const nodeModuleLogEventSchema = z.object({
  time: z.number().int().min(0).max(8_640_000_000_000_000),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  stream: z.enum(['stdout', 'stderr']),
});
export const nodeModuleLogWindowSchema = z.object({
  status: z.enum(['ready', 'unavailable']),
  events: z.array(nodeModuleLogEventSchema).max(16),
});
export const nodeModuleLogWindowsSchema = z.array(nodeModuleLogWindowSchema.extend({
  moduleId: nodeModuleIdSchema,
})).max(4);
export type NodeModuleLogWindows = z.infer<typeof nodeModuleLogWindowsSchema>;

/**
 * Heartbeat module snapshot entry. Deliberately stricter than the returned
 * shape: the node must say which image and status it actually runs; the Core
 * enriches catalog entries and preserves operator-managed entries for inventory.
 * Catalog ids require an allowlisted image. Omitted `updatedAt` is stamped with the
 * Core receipt time (honest timestamp, no invented state).
 */
export const nodeModuleReportSchema = z.object({
  id: nodeModuleIdSchema,
  kind: nodeModuleIdSchema.optional(),
  image: nodeModuleImageSchema,
  status: nodeModuleStatusSchema,
  name: z.string().trim().min(1).max(80).optional(),
  version: nodeModuleVersionSchema.optional(),
  health: nodeModuleHealthSchema.optional(),
  autoStart: z.boolean().optional(),
  lifecycleContainerId: nodeModuleContainerIdSchema.optional(),
  sfuDrainState: z.enum(['available', 'requested']).optional(),
  templateRemovable: z.literal(true).optional(),
  logs: nodeModuleLogWindowSchema.optional(),
  ports: nodeModulePortsSchema.optional(),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  lastError: z.string().trim().min(1).max(NODE_MODULE_MAX_ERROR_CHARS).optional(),
});
export type NodeModuleReport = z.infer<typeof nodeModuleReportSchema>;
export const nodeModuleReportsSchema = z.array(nodeModuleReportSchema).max(NODE_MODULE_MAX_ITEMS);

/** A command the Core queued for a node; delivered on the next heartbeat only. */
export const nodeModuleCommandSchema = z.object({
  id: nodeModuleCommandIdSchema,
  moduleId: nodeModuleIdSchema,
  action: nodeModuleActionSchema,
  /** Docker image for a preset or a locally approved install. */
  image: nodeModuleImageSchema.optional(),
  targetContainerId: nodeModuleContainerIdSchema.optional(),
  /** Epoch ms when the command was queued. */
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** Epoch ms after which the command is dropped and no longer delivered. */
  expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).refine(({ moduleId, action, image, targetContainerId }) => (
  isOperatorManagedNodeModule(moduleId) ? targetContainerId !== undefined && image === undefined &&
    (moduleId === 'sfu' ? action === 'start' : customNodeModuleActions.some((lifecycle) => lifecycle === action)) :
  nodeModuleKindSchema.safeParse(moduleId).success ? targetContainerId === undefined :
    (action === 'install' ? nodeTemplateImageSchema.safeParse(image).success :
      targetContainerId !== undefined && image === undefined && isCustomNodeModuleAction(action))
), { path: ['moduleId'], message: 'custom actions require an approved digest for install or an exact container id for lifecycle' });
export type NodeModuleCommand = z.infer<typeof nodeModuleCommandSchema>;

/** Acknowledgement of one delivered command (sent on a later heartbeat). */
export const nodeModuleResultSchema = z.object({
  commandId: nodeModuleCommandIdSchema,
  ok: z.boolean(),
  status: nodeModuleStatusSchema,
  /** Agent error text (bounded); absent when `ok` is true. */
  error: z.string().trim().min(1).max(NODE_MODULE_MAX_ERROR_CHARS).optional(),
});
export type NodeModuleResult = z.infer<typeof nodeModuleResultSchema>;
export const nodeModuleResultsSchema = z.array(nodeModuleResultSchema).max(NODE_MODULE_MAX_ITEMS);

/** `POST /v1/admin/nodes/:nodeId/modules/:moduleId/actions` body. */
export const nodeModuleActionRequestSchema = z.object({
  action: nodeModuleActionSchema,
  /** Exact container ID for lifecycle actions or an isolated template replacement. */
  targetContainerId: nodeModuleContainerIdSchema.optional(),
  expectedImage: nodeTemplateImageSchema.optional(),
});
export type NodeModuleActionRequest = z.infer<typeof nodeModuleActionRequestSchema>;

export interface NodeModuleActionResponse {
  /** Queued command; delivered to the node on its next heartbeat. */
  command: NodeModuleCommand;
}

/**
 * One allowlisted module in the Core catalog. `image` is the canonical
 * repository:tag the Core installs; `repository` is the allowlisted Docker
 * repository (tag/digest bumps are accepted). `env` lists variable **names and
 * hints only** — never values, never secrets.
 */
export const nodeModuleEnvHintSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'must be an env var name'),
  required: z.boolean().default(false),
  /** True when the value is a node-side secret and must never be sent to the Core. */
  secret: z.boolean().default(false),
  description: z.string().trim().max(200).default(''),
});
export type NodeModuleEnvHint = z.infer<typeof nodeModuleEnvHintSchema>;

export const nodeModuleCatalogEntrySchema = z.object({
  id: nodeModuleKindSchema,
  kind: nodeModuleKindSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(300),
  image: nodeModuleImageSchema,
  /** Allowlisted Docker repository; a reported image must use exactly this repo. */
  repository: z.string().min(1).max(180),
  /** Default ports (informational); the node reports the actually published ones. */
  ports: nodeModulePortsSchema,
  env: z.array(nodeModuleEnvHintSchema).max(16),
  /** Actions the Core may queue for this module. */
  actions: z.array(nodeModuleActionSchema).min(1).max(nodeModuleActions.length),
});
export type NodeModuleCatalogEntry = z.infer<typeof nodeModuleCatalogEntrySchema>;

export const nodeModuleCatalogResponseSchema = z.object({
  catalog: z.array(nodeModuleCatalogEntrySchema),
  /** Union of every action the catalog supports. */
  actions: z.array(nodeModuleActionSchema),
});
export type NodeModuleCatalogResponse = z.infer<typeof nodeModuleCatalogResponseSchema>;

/** `GET /v1/admin/nodes/:nodeId/modules` response. */
export const nodeModuleFailureSchema = z.object({
  moduleId: nodeModuleIdSchema,
  action: nodeModuleActionSchema,
  reason: z.enum(['delivery_expired', 'result_expired', 'target_changed']).optional(),
  error: z.string().trim().min(1).max(NODE_MODULE_MAX_ERROR_CHARS).optional(),
});
export type NodeModuleFailure = z.infer<typeof nodeModuleFailureSchema>;

export const nodeModuleAvailabilitySchema = z.enum(['available', 'unavailable', 'disabled']);
export type NodeModuleAvailability = z.infer<typeof nodeModuleAvailabilitySchema>;

export const nodeModulesResponseSchema = z.object({
  nodeId: z.string().min(1).max(64),
  modules: z.array(nodeModuleSchema),
  moduleAvailability: nodeModuleAvailabilitySchema.optional(),
  moduleTemplates: nodeCustomModuleTemplatesSchema.optional(),
  logWindows: nodeModuleLogWindowsSchema.optional(),
  inventoryStale: z.boolean().optional(),
  /** Queued commands not yet delivered (for the dashboard's pending badge). */
  pendingCommands: z.array(nodeModuleCommandSchema),
  /** Delivered commands that are awaiting a result from the node. */
  inFlightCommands: z.array(nodeModuleCommandSchema).optional(),
  /** Last failed command per module. Cleared when a later command succeeds. */
  failures: z.array(nodeModuleFailureSchema).max(NODE_MODULE_MAX_ITEMS).optional(),
});
export type NodeModulesResponse = z.infer<typeof nodeModulesResponseSchema>;

/* ------------------------------------------------------------------ */
/* Leader lease / HA status                                            */
/* ------------------------------------------------------------------ */

/**
 * Current leader as this Core sees it: its own fenced state while leader, or
 * the shared Redis record while standby (`null` when nobody holds the lease).
 */
export interface ClusterLeaderStatus {
  id: string | null;
  /** Epoch ms when this leader acquired the lease (best effort). */
  since: number | null;
  /** Epoch ms of the last successful lease renewal / leader heartbeat. */
  heartbeatAt: number | null;
  /** True when this Core is the leader. */
  self: boolean;
}

/**
 * Redis leader lease exposed by `GET /v1/admin/cluster/status`.
 *
 * `held` is the local, **fenced** belief: the Core only accepts mutations while
 * `role=leader` and `Date.now() < validUntil`. A Core that loses Redis stops
 * accepting mutations at `validUntil` even if it cannot reach Redis to learn
 * that a new leader was elected, so two Cores never mutate at the same time.
 */
export interface LeaderLeaseStatus {
  mode: ClusterMode;
  /** This Core holds a locally valid lease (leader only). */
  held: boolean;
  /** Configured lease TTL (`AGIL_LEADER_LEASE_TTL_MS`); 0 in standalone mode. */
  ttlMs: number;
  /** Remaining TTL of the shared lease key (from Redis PTTL), when known. */
  ttlRemainingMs: number | null;
  /** Epoch ms after which this Core stops acting as leader (fencing deadline). */
  validUntil: number | null;
  /** Epoch ms of the last successful renewal. */
  heartbeatAt: number | null;
  /** Redis connection currently usable. */
  redisConnected: boolean;
  /** Consecutive failed renewal attempts (0 while healthy). */
  renewalFailures: number;
  /** Human-readable reason for the current role/lease state. */
  reason: string;
}

/** What is (and is not) shared between Cores in this stage. */
export interface ClusterHaStatus {
  mode: ClusterMode;
  /** Stable id of this Core process (lease value owner). */
  nodeId: string;
  /** Leadership also holds the Redis node-registry write lock. */
  registryLockHeld: boolean;
  registryLockTtlRemainingMs: number | null;
  /** Rooms/presence live in process memory and are lost on failover. */
  roomStateReplicated: false;
  /** Tenant configuration is a per-Core file and is not replicated. */
  tenantConfigReplicated: false;
  /** The node/token registry is a per-Core file and is not replicated. */
  nodeRegistryReplicated: false;
  /** Durable stores this Core uses. */
  stateStore: 'local-file';
}

/** Post-failover notice rendered by the dashboard and printed by the CLI. */
export interface ClusterFailoverStatus {
  /** This Core acquired leadership after observing another leader. */
  detected: boolean;
  previousLeaderId: string | null;
  changedAt: number | null;
  /** Operator-facing message, including the room-state limitation. */
  message: string;
}

/**
 * Baseline node record (`{id, role, features, capacity, status}`) plus the
 * metadata the Core keeps for the panel. Secrets (`keyHash`) are never part of
 * this shape.
 */
export const nodeTurnEndpointSchema = z.object({
  ip: z.ipv4(),
  port: z.number().int().min(1).max(65_535),
  tlsPort: z.number().int().min(1).max(65_535).optional(),
  tlsHostname: z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/).optional(),
  credentialMode: z.enum(['static', 'rest']).optional(),
}).strict().refine((endpoint) => !endpoint.tlsHostname || endpoint.tlsPort !== undefined, { path: ['tlsPort'] });
export type NodeTurnEndpoint = z.infer<typeof nodeTurnEndpointSchema>;

export interface NodeSummary {
  id: string;
  role: NodeRole;
  features: string[];
  capacity: NodeCapacity;
  status: NodeStatus;
  /** Tenant that owns the enrollment token used to register the node. */
  tenantId: string;
  name: string;
  /** Public/base URL the node advertises (informational; not probed yet). */
  endpoint: string;
  /** Health path the node advertises (informational; not probed yet). */
  healthPath: string;
  region: string;
  version: string;
  /**
   * Latest live metrics reported by the node (heartbeat). Absent until the node
   * sends its first `metrics` report; never zero-filled by the server.
   */
  metrics?: NodeMetrics;
  /** Readiness of the bundled SFU. Absent on nodes that have not reported it. */
  sfuReady?: boolean;
  /** Readiness of bundled coturn, independent of Docker module inventory. */
  turnReady?: boolean;
  /** Advertised endpoint of ready bundled coturn. Contains no credentials. */
  turnEndpoint?: NodeTurnEndpoint;
  /** Core verified that the ready endpoint has the automatic TURN signing key. */
  automaticTurnVerified?: boolean;
  /**
   * Latest module inventory reported by the node (heartbeat). Absent until the
   * node sends its first `modules` snapshot; `[]` means "reported: no modules
   * installed". The Core never fabricates a module entry.
   */
  modules?: NodeModule[];
  /** Running module ids from a fresh inventory on an online node. Absent on older Cores. */
  availableModules?: NodeModuleKind[];
  /** Docker modules excluded from dispatch by the administrator. */
  disabledModules?: NodeModuleKind[];
  /** The last inventory exists but is expired or was invalidated. */
  inventoryStale?: boolean;
  /** Whether the agent could inspect Docker modules on its latest online heartbeat. */
  moduleAvailability?: NodeModuleAvailability;
  /** Admin disable switch; a disabled node cannot heartbeat. */
  enabled: boolean;
  /** Drain marker; it only changes `status`. */
  drain: boolean;
  createdAt: number;
  registeredAt: number;
  lastSeenAt: number | null;
  /** Epoch ms when the node key expires; `null` = no expiry. */
  keyExpiresAt: number | null;
  /** Epoch ms of the last key rotation; `null` for the original key. */
  keyRotatedAt: number | null;
}

/** A standby Core that redeemed a `core` token (registry only; no failover). */
export interface StandbyCoreSummary {
  id: string;
  tenantId: string;
  clusterId: string;
  version: string;
  region: string;
  registeredAt: number;
  lastSeenAt: number | null;
}

/**
 * Enrollment token as exposed by the API. `uses` is the configured maximum,
 * `remainingUses` the number left; the plaintext is returned only once, by
 * `POST /v1/admin/cluster/tokens`.
 */
export const enrollmentTokenSchema = z.object({
  id: z.string().min(1).max(64),
  kind: enrollmentKindSchema,
  role: enrollmentRoleSchema,
  features: nodeFeaturesSchema,
  /** Epoch milliseconds. */
  expiresAt: z.number().int().nonnegative(),
  uses: z.number().int().min(1).max(100),
  createdBy: z.string().min(1).max(160),
});
export type EnrollmentToken = z.infer<typeof enrollmentTokenSchema>;

export interface EnrollmentTokenSummary extends EnrollmentToken {
  remainingUses: number;
  createdAt: number;
  revokedAt: number | null;
  label: string;
  status: EnrollmentTokenStatus;
}

export const enrollmentTokenCreateRequestSchema = z.object({
  kind: enrollmentKindSchema,
  /** Defaults: `standby` for `core`, `all` for `node`. */
  role: enrollmentRoleSchema.optional(),
  /** Node feature scope; empty = no feature restriction recorded. */
  features: nodeFeaturesSchema.optional(),
  /** 1..2592000 seconds (30 days); default 3600. */
  ttlSec: z.number().int().min(1).max(2_592_000).optional(),
  /** 1..100; default 1 (one-time). */
  uses: z.number().int().min(1).max(100).optional(),
  label: z.string().max(80).optional(),
});
export type EnrollmentTokenCreateRequest = z.infer<typeof enrollmentTokenCreateRequestSchema>;

export interface EnrollmentTokenCreatedResponse {
  /** Plaintext token — returned once and never recoverable. */
  token: string;
  enrollment: EnrollmentTokenSummary;
}

export interface EnrollmentTokenListResponse {
  tokens: EnrollmentTokenSummary[];
}

export interface EnrollmentTokenRevokeResponse {
  revoked: boolean;
  id: string;
  enrollment: EnrollmentTokenSummary;
}

/* ------------------------------------------------------------------ */
/* Node registration / heartbeat                                       */
/* ------------------------------------------------------------------ */

const ENDPOINT_RE = /^(https?|wss?):\/\/[^\s/]+/i;

/**
 * Metadata-service hosts are never legitimate node endpoints: a scheduler or
 * probe must not be handed a cloud-metadata address from an enrollment token
 * holder.
 */
const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data',
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254',
]);

function endpointIssue(value: string): string | null {
  if (!value || !ENDPOINT_RE.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an http(s)/ws(s) URL';
  }
  if (url.username || url.password) return 'must not contain credentials';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (METADATA_HOSTS.has(host)) return 'must not point at a cloud metadata service';
  return null;
}

function endpointSchema(): z.ZodType<string> {
  return z
    .string()
    .max(300)
    .refine((value) => value === '' || ENDPOINT_RE.test(value), 'must be an http(s)/ws(s) URL')
    .superRefine((value, ctx) => {
      const issue = endpointIssue(value);
      if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
    });
}

export const nodeRegisterRequestSchema = z.object({
  /** One-time enrollment token (`agil_enr_...`). */
  token: z.string().min(16).max(200),
  /** Stable node id; defaults to a generated one. Must be unique per tenant. */
  nodeId: clusterIdSchema.optional(),
  role: nodeRoleSchema,
  name: z.string().max(80).optional(),
  features: nodeFeaturesSchema.optional(),
  capacity: nodeCapacityInputSchema.optional(),
  endpoint: endpointSchema().optional(),
  healthPath: z
    .string()
    .max(200)
    .refine((value) => value === '' || value.startsWith('/'), 'must start with /')
    .optional(),
  region: z.string().max(64).optional(),
  version: z.string().max(32).optional(),
  /**
   * Optional node-key lifetime in seconds (1 s … 90 days). When omitted the
   * Core's `AGIL_NODE_KEY_TTL_SEC` default applies (0 = no expiry). Rotation is
   * `POST /v1/admin/nodes/:nodeId/rotate-key`.
   */
  keyTtlSec: z.number().int().min(1).max(7_776_000).optional(),
});
export type NodeRegisterRequest = z.infer<typeof nodeRegisterRequestSchema>;

export interface NodeRegistrationResponse {
  node: NodeSummary;
  /** Per-node credential — returned once; used for heartbeat only. */
  nodeKey: string;
  /** Epoch ms when `nodeKey` expires; `null` = no expiry. */
  keyExpiresAt: number | null;
  heartbeatIntervalSec: number;
  cluster: Cluster;
}

export const nodeHeartbeatRequestSchema = z.object({
  capacity: nodeCapacityInputSchema.optional(),
  sfuReady: z.boolean().optional(),
  turnReady: z.boolean().optional(),
  turnEndpoint: nodeTurnEndpointSchema.optional(),
  turnEndpointProof: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Optional live statistics snapshot; merged into the node's last report. */
  metrics: nodeMetricsInputSchema.optional(),
  /** Nodes may report themselves offline before shutting down. */
  status: z.enum(['online', 'offline']).optional(),
  /**
   * Full module inventory snapshot (Docker add-on packages). Omitted: keep the
   * previous snapshot (old agents stay compatible). Present: replaces it, so
   * `[]` honestly means "no modules installed". Unknown module ids and images
   * outside the Core allowlist are dropped, never echoed back.
   */
  modules: nodeModuleReportsSchema.optional(),
  moduleAvailability: nodeModuleAvailabilitySchema.optional(),
  moduleTemplates: nodeCustomModuleTemplatesSchema.optional(),
  /**
   * Acknowledgements for commands received on an earlier heartbeat. Unknown or
   * already-acknowledged command ids are ignored (the command may have expired).
   */
  moduleResults: nodeModuleResultsSchema.optional(),
});
export type NodeHeartbeatRequest = z.infer<typeof nodeHeartbeatRequestSchema>;

export interface NodeHeartbeatResponse {
  node: NodeSummary;
  drain: boolean;
  heartbeatIntervalSec: number;
  serverTime: number;
  /**
   * Module commands pending for this node; each command is delivered exactly
   * once (a later heartbeat does not repeat it). Empty when nothing is queued.
   */
  moduleCommands: NodeModuleCommand[];
}

/** Admin key rotation: optional new lifetime; the old key stops working at once. */
export const nodeRotateKeyRequestSchema = z.object({
  keyTtlSec: z.number().int().min(1).max(7_776_000).optional(),
});
export type NodeRotateKeyRequest = z.infer<typeof nodeRotateKeyRequestSchema>;

export interface NodeKeyRotationResponse {
  node: NodeSummary;
  /** New plaintext per-node key — returned once. */
  nodeKey: string;
  keyExpiresAt: number | null;
  heartbeatIntervalSec: number;
}

export const nodeUpdateRequestSchema = z.object({
  name: z.string().max(80).optional(),
  role: nodeRoleSchema.optional(),
  features: nodeFeaturesSchema.optional(),
  moduleEnabled: z.partialRecord(nodeModuleKindSchema, z.boolean()).optional(),
  capacity: nodeCapacityInputSchema.optional(),
  endpoint: endpointSchema().optional(),
  healthPath: z
    .string()
    .max(200)
    .refine((value) => value === '' || value.startsWith('/'), 'must start with /')
    .optional(),
  region: z.string().max(64).optional(),
});
export type NodeUpdateRequest = z.infer<typeof nodeUpdateRequestSchema>;

export const nodeDisableRequestSchema = z.object({ disabled: z.boolean().optional() });
export type NodeDisableRequest = z.infer<typeof nodeDisableRequestSchema>;

export const nodeDrainRequestSchema = z.object({ drain: z.boolean().optional() });
export type NodeDrainRequest = z.infer<typeof nodeDrainRequestSchema>;

export interface NodeListResponse {
  nodes: NodeSummary[];
}

export interface NodeResponse {
  node: NodeSummary;
}

export interface NodeDeleteResponse {
  deleted: boolean;
  id: string;
}

/* ------------------------------------------------------------------ */
/* Standby Core join                                                   */
/* ------------------------------------------------------------------ */

export const clusterJoinRequestSchema = z.object({
  /** One-time enrollment token of kind `core`. */
  token: z.string().min(16).max(200),
  /** Id of the standby Core; defaults to a generated one. */
  nodeId: clusterIdSchema.optional(),
  /** Cluster id the standby expects to join (advisory, informational). */
  clusterId: clusterIdSchema.optional(),
  version: z.string().max(32).optional(),
  region: z.string().max(64).optional(),
});
export type ClusterJoinRequest = z.infer<typeof clusterJoinRequestSchema>;

export interface ClusterJoinResponse {
  cluster: Cluster;
  leader: { nodeId: string; version: string; publicOrigin: string };
  standby: StandbyCoreSummary;
  token: { id: string; remainingUses: number };
}

export interface ClusterNodeCounts {
  nodes: number;
  online: number;
  offline: number;
  draining: number;
  disabled: number;
  standbys: number;
}

/** Registry slice merged into `GET /v1/admin/cluster/status`. */
export interface ClusterRegistryStatus {
  cluster: Cluster;
  /** Leader lease / election state (also present in standalone mode). */
  leader: ClusterLeaderStatus;
  lease: LeaderLeaseStatus;
  ha: ClusterHaStatus;
  failover: ClusterFailoverStatus;
  standbys: StandbyCoreSummary[];
  enrolledNodes: NodeSummary[];
  counts: ClusterNodeCounts;
  limitations: string[];
}

/** Endpoint paths that are not part of the tenant admin surface. */
export const clusterPaths = {
  join: '/v1/cluster/join',
  nodeRegister: '/v1/nodes/register',
  nodeHeartbeat: (nodeId: string) => `/v1/nodes/${encodeURIComponent(nodeId)}/heartbeat`,
  /** Admin per-node key rotation (tenant admin credential). */
  nodeRotateKey: (nodeId: string) => `/v1/admin/nodes/${encodeURIComponent(nodeId)}/rotate-key`,
} as const;

/**
 * Admin per-node module surface (tenant admin credential).
 *
 * - the catalog is the Core allowlist; the dashboard can never submit an image;
 * - actions are queued for the node and delivered once on its next heartbeat.
 */
export const nodeModulesPaths = {
  catalog: '/v1/admin/node-modules/catalog',
  nodeModules: (nodeId: string) => `/v1/admin/nodes/${encodeURIComponent(nodeId)}/modules`,
  moduleActions: (nodeId: string, moduleId: string) =>
    `/v1/admin/nodes/${encodeURIComponent(nodeId)}/modules/${encodeURIComponent(moduleId)}/actions`,
} as const;

/** Enrollment token prefix (plaintext is shown once and only stored hashed). */
export const ENROLLMENT_TOKEN_PREFIX = 'agil_enr_';
/** Per-node key prefix (returned once by `POST /v1/nodes/register`). */
export const NODE_KEY_PREFIX = 'nk_';

/** Liveness contract: heartbeat every 30 s, `offline` after 90 s of silence. */
export const NODE_HEARTBEAT_INTERVAL_SEC = 30;
export const NODE_OFFLINE_AFTER_SEC = 90;

/** Baseline limitations, surfaced by `GET /v1/admin/cluster/status`. */
export const CLUSTER_BASELINE_LIMITATIONS: readonly string[] = [
  'core: tenant configuration and the node registry are replicated only when operators configure separate synchronization (docs/ha-leader.md)',
  'core: Redis supports leader election and optional shared room snapshots. Live connections reconnect after failover',
  'node: direct LiveKit ingress uses operator-configured URLs. Advertised endpoint and healthPath are informational',
  'node: maintenance excludes a node from new room assignments. Disabling also rejects its heartbeats',
  'tokens: enrollment is tenant-scoped; a standby rejects token issuance/revocation with 409 not_leader until it acquires the lease',
];
