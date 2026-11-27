/**
 * Routing baseline: Edge -> call, Edge -> stream and WebRTC room -> stream.
 *
 * A **routing rule** is a tenant-scoped policy: it maps one *source* (a headless
 * Edge agent, a room, or — later — a tagged participant) to a set of
 * *destinations* (a room to publish into, an RTMP/HLS stream to derive, an
 * optional recording). Rules are ordered by `priority` (lower number wins, ties
 * broken by `createdAt`, then `id`); an evaluator selects the first enabled rule
 * that matches the source.
 *
 * Security invariants encoded here (the server enforces them again):
 *  - an RTMP URL is a credential-bearing value (the stream key usually lives in
 *    the path): admin responses and Edge-join responses expose only
 *    `urlHost`/`hasSecret`, never `url`;
 *  - a `secretRef` must name a server-owned `AGIL_ROUTE_SECRET_*` variable;
 *  - every rule is tenant-scoped, so no evaluator can select another tenant's
 *    rule, room or stream destination.
 *
 * This module is browser-safe (no Node APIs): the dashboard may import the DTOs
 * and validation helpers, the server adds SSRF/secret resolution on top.
 */
import { z } from 'zod';
import { isAllowedTenantSecretEnv } from './secret-env.js';
import { roleSchema, type Role } from './signaling.js';

/* ------------------------------------------------------------------ */
/* Enumerations & limits                                               */
/* ------------------------------------------------------------------ */

/** What starts a route: an Edge device, a WebRTC room, a tagged participant. */
export const ROUTING_SOURCE_TYPES = ['edge', 'room', 'participant'] as const;
export const routingSourceTypeSchema = z.enum(ROUTING_SOURCE_TYPES);
export type RoutingSourceType = z.infer<typeof routingSourceTypeSchema>;

/** Stream protocols the egress worker can produce from a room. */
export const ROUTING_STREAM_PROVIDERS = ['rtmp', 'hls'] as const;
export const routingStreamProviderSchema = z.enum(ROUTING_STREAM_PROVIDERS);
export type RoutingStreamProvider = z.infer<typeof routingStreamProviderSchema>;

/** Composite layout for stream/recording egress. */
export const ROUTING_LAYOUTS = ['grid', 'speaker'] as const;
export const routingLayoutSchema = z.enum(ROUTING_LAYOUTS);
export type RoutingLayout = z.infer<typeof routingLayoutSchema>;

/**
 * Latency profile hint. The baseline only records it: the egress worker maps it
 * to its own encoder settings (low = shorter keyframes/segment duration).
 */
export const ROUTING_LATENCY_MODES = ['standard', 'low'] as const;
export const routingLatencySchema = z.enum(ROUTING_LATENCY_MODES);
export type RoutingLatency = z.infer<typeof routingLatencySchema>;

/** Media kinds an Edge/participant destination may publish. */
export const ROUTING_PUBLISH_KINDS = ['audio', 'video', 'screen'] as const;
export const routingPublishKindSchema = z.enum(ROUTING_PUBLISH_KINDS);
export type RoutingPublishKind = z.infer<typeof routingPublishKindSchema>;

/**
 * Status of one destination/job or of a run:
 *  - `ready`       room destination resolved (the Edge may join it);
 *  - `started`     egress job accepted by the worker;
 *  - `pending`     accepted but still starting (`EGRESS_STARTING`);
 *  - `partial`     some jobs started, at least one failed/unavailable;
 *  - `unavailable` egress is disabled/unconfigured or a secret is missing;
 *  - `failed`      the egress worker rejected the job;
 *  - `skipped`     dry run (`apply:false`) or destination not applicable.
 */
export const ROUTING_STATUSES = ['ready', 'started', 'pending', 'partial', 'unavailable', 'failed', 'skipped'] as const;
export const routingStatusSchema = z.enum(ROUTING_STATUSES);
export type RoutingStatus = z.infer<typeof routingStatusSchema>;

/** Run status persisted as `lastRun` (never `ready`: a run is not a room). */
export const ROUTING_RUN_STATUSES = ['started', 'pending', 'partial', 'unavailable', 'failed', 'skipped'] as const;
export const routingRunStatusSchema = z.enum(ROUTING_RUN_STATUSES);
export type RoutingRunStatus = z.infer<typeof routingRunStatusSchema>;

/** What triggered an evaluation. */
export const ROUTING_TRIGGERS = ['edge_join', 'room_start', 'route_test'] as const;
export const routingTriggerSchema = z.enum(ROUTING_TRIGGERS);
export type RoutingTrigger = z.infer<typeof routingTriggerSchema>;

export const ROUTING_EDGE_TOKEN_PREFIX = 'agil_edge_';
export const ROUTING_EDGE_TOKEN_STATUSES = ['active', 'used', 'expired', 'revoked'] as const;
export const routingEdgeTokenStatusSchema = z.enum(ROUTING_EDGE_TOKEN_STATUSES);
export type RoutingEdgeTokenStatus = z.infer<typeof routingEdgeTokenStatusSchema>;

/** Hard bounds shared by the server and the dashboard editor. */
export const ROUTING_MAX_RULES_PER_TENANT = 100;
export const ROUTING_MAX_DESTINATIONS = 8;
export const ROUTING_MAX_PRIORITY = 1000;
export const ROUTING_DEFAULT_PRIORITY = 100;
export const ROUTING_MAX_TEMPLATE_LENGTH = 120;
export const ROUTING_MAX_URL_LENGTH = 2000;
/** Defaults materialised on every stored destination/rule. */
export const ROUTING_DEFAULTS = {
  enabled: true,
  priority: ROUTING_DEFAULT_PRIORITY,
  roomRole: 'guest',
  publish: ['audio', 'video'] as RoutingPublishKind[],
  layout: 'grid' as RoutingLayout,
  latency: 'standard' as RoutingLatency,
} as const;

/** Template placeholders accepted in `destination.template`. */
export const ROUTING_TEMPLATE_VARS = [
  'tenantId',
  'routeId',
  'edgeId',
  'roomId',
  'tag',
  'sourceId',
  'participantId',
] as const;
export type RoutingTemplateVar = (typeof ROUTING_TEMPLATE_VARS)[number];

/* ------------------------------------------------------------------ */
/* Schemas: source                                                     */
/* ------------------------------------------------------------------ */

const ruleIdRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const edgeIdRe = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const roomIdRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const tagRe = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export const routingRuleIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(ruleIdRe, 'must be 1..64 URL-safe characters (letters, digits, . _ -)');
export const routingEdgeIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(edgeIdRe, 'must be 1..64 characters (letters, digits, . _ : -)');
export const routingRoomIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(roomIdRe, 'must be 1..64 URL-safe characters (letters, digits, . _ -)');
export const routingTagSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(tagRe, 'must be 1..40 lowercase characters (letters, digits, . _ -)');

/**
 * Where a rule applies.
 *
 *  - `edge`        matches an enrolled Edge device; `edgeId`/`tag` are optional
 *                  selectors, so a tenant-wide default edge rule is possible;
 *  - `room`        matches one exact room id (required);
 *  - `participant` matches a participant tag and/or room (participant tags are
 *                  not emitted by the baseline yet — see docs/routing.md).
 */
export const routingRuleSourceSchema = z
  .object({
    type: routingSourceTypeSchema,
    edgeId: routingEdgeIdSchema.optional(),
    roomId: routingRoomIdSchema.optional(),
    tag: routingTagSchema.optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (source.type === 'edge') {
      if (source.roomId !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['roomId'], message: 'roomId is not valid for an edge source' });
      }
      return;
    }
    if (source.type === 'room') {
      if (source.edgeId !== undefined || source.tag !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'edgeId/tag are not valid for a room source (use roomId)',
        });
      }
      if (!source.roomId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['roomId'], message: 'roomId is required for a room source' });
      }
      return;
    }
    if (source.edgeId !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edgeId'], message: 'edgeId is not valid for a participant source' });
    }
    if (!source.roomId && !source.tag) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a participant source requires roomId and/or tag',
      });
    }
  });
export type RoutingRuleSource = z.infer<typeof routingRuleSourceSchema>;

/** Deep-partial source patch (validated after merging over the current rule). */
export const routingRuleSourcePatchSchema = z
  .object({
    type: routingSourceTypeSchema.optional(),
    edgeId: routingEdgeIdSchema.nullable().optional(),
    roomId: routingRoomIdSchema.nullable().optional(),
    tag: routingTagSchema.nullable().optional(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Schemas: destinations                                               */
/* ------------------------------------------------------------------ */

export const routingDestinationTypeSchema = z.enum(['room', 'stream']);
export type RoutingDestinationType = z.infer<typeof routingDestinationTypeSchema>;

const templateRe = /^[A-Za-z0-9{][A-Za-z0-9._{}:-]*$/;

/**
 * Validates a room-id template. Templates may only contain room-id characters
 * plus `{var}` placeholders from {@link ROUTING_TEMPLATE_VARS}; the expanded id
 * is validated as a room id at evaluation time.
 */
export function validateRoutingTemplate(template: unknown): string | null {
  if (typeof template !== 'string' || template.length === 0) return 'template is empty';
  if (template.length > ROUTING_MAX_TEMPLATE_LENGTH) return `template is longer than ${ROUTING_MAX_TEMPLATE_LENGTH} characters`;
  if (!templateRe.test(template)) {
    return 'template may contain letters, digits, ".", "_", "-", ":" and {placeholders}';
  }
  const withoutVars = template.replace(/\{[^}]*\}/g, '');
  if (withoutVars.includes('{') || withoutVars.includes('}')) return 'template has unbalanced braces';
  for (const match of template.matchAll(/\{([^}]*)\}/g)) {
    const name = match[1] ?? '';
    if (!(ROUTING_TEMPLATE_VARS as readonly string[]).includes(name)) {
      return `unknown template variable {${name}} (allowed: ${ROUTING_TEMPLATE_VARS.join(', ')})`;
    }
  }
  return null;
}

/** True when a room destination uses a template instead of a literal id. */
export function isRoutingTemplate(value: string): boolean {
  return /\{[^}]+\}/.test(value);
}

/** Expands `{var}` placeholders. Unknown placeholders are left verbatim. */
export function expandRoutingTemplate(template: string, vars: Partial<Record<RoutingTemplateVar, string>>): string {
  return template.replace(/\{([^}]*)\}/g, (match, name: string) => {
    const value = (vars as Record<string, string | undefined>)[name];
    return typeof value === 'string' ? value : match;
  });
}

/**
 * One destination. The object is intentionally flat (a discriminated union
 * cannot be deep-patched), and every cross-field rule is enforced in the
 * refinement below.
 */
export const routingDestinationSchema = z
  .object({
    type: routingDestinationTypeSchema,
    // room destination
    roomId: routingRoomIdSchema.optional(),
    template: z.string().max(ROUTING_MAX_TEMPLATE_LENGTH).optional(),
    role: roleSchema.optional(),
    publish: z.array(routingPublishKindSchema).max(ROUTING_PUBLISH_KINDS.length).optional(),
    // stream destination
    provider: routingStreamProviderSchema.optional(),
    url: z.string().max(ROUTING_MAX_URL_LENGTH).optional(),
    secretRef: z.string().max(100).optional(),
    layout: routingLayoutSchema.optional(),
    latency: routingLatencySchema.optional(),
  })
  .strict()
  .superRefine((destination, ctx) => {
    if (destination.type === 'room') {
      if (destination.provider !== undefined || destination.url !== undefined || destination.secretRef !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'provider/url/secretRef are not valid for a room destination',
        });
      }
      if (destination.layout !== undefined || destination.latency !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'layout/latency are not valid for a room destination',
        });
      }
      if (!destination.roomId && !destination.template) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roomId'],
          message: 'a room destination requires roomId or template',
        });
      }
      if (destination.roomId && destination.template) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a room destination takes roomId or template, not both',
        });
      }
      if (destination.template) {
        const issue = validateRoutingTemplate(destination.template);
        if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['template'], message: issue });
      }
      if (destination.publish && new Set(destination.publish).size !== destination.publish.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['publish'], message: 'publish kinds must be unique' });
      }
      return;
    }
    if (!destination.provider) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['provider'], message: 'a stream destination requires provider' });
      return;
    }
    if (destination.roomId !== undefined || destination.template !== undefined || destination.role !== undefined || destination.publish !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'roomId/template/role/publish are not valid for a stream destination',
      });
    }
    if (destination.provider === 'hls') {
      if (destination.url !== undefined || destination.secretRef !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'hls is produced by the egress worker; url/secretRef are not allowed',
        });
      }
      return;
    }
    // rtmp: exactly one credential source.
    if (!destination.url && !destination.secretRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'an rtmp destination requires url or secretRef',
      });
    }
    if (destination.url && destination.secretRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an rtmp destination takes url or secretRef, not both',
      });
    }
    if (destination.secretRef && !isAllowedTenantSecretEnv(destination.secretRef, 'route')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secretRef'],
        message: 'secretRef must be a server-owned AGIL_ROUTE_SECRET_* variable',
      });
    }
  });
export type RoutingDestination = z.infer<typeof routingDestinationSchema>;
export type RoutingRoomDestination = RoutingDestination & { type: 'room' };
export type RoutingStreamDestination = RoutingDestination & { type: 'stream' };

/** Deep-partial destination patch; entries merge by array position. */
export const routingDestinationPatchSchema = z
  .object({
    type: routingDestinationTypeSchema.optional(),
    roomId: routingRoomIdSchema.nullable().optional(),
    template: z.string().max(ROUTING_MAX_TEMPLATE_LENGTH).nullable().optional(),
    role: roleSchema.nullable().optional(),
    publish: z.array(routingPublishKindSchema).max(ROUTING_PUBLISH_KINDS.length).nullable().optional(),
    provider: routingStreamProviderSchema.nullable().optional(),
    url: z.string().max(ROUTING_MAX_URL_LENGTH).nullable().optional(),
    secretRef: z.string().max(100).nullable().optional(),
    layout: routingLayoutSchema.nullable().optional(),
    latency: routingLatencySchema.nullable().optional(),
  })
  .strict();
export type RoutingDestinationPatch = z.infer<typeof routingDestinationPatchSchema>;

/** Optional RTMP/HLS egress recording of the routed room. */
export const routingRecordingSchema = z
  .object({
    enabled: z.boolean(),
    layout: routingLayoutSchema.optional(),
    audioOnly: z.boolean().optional(),
  })
  .strict();
export type RoutingRecording = z.infer<typeof routingRecordingSchema>;

export const routingRecordingPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    layout: routingLayoutSchema.nullable().optional(),
    audioOnly: z.boolean().nullable().optional(),
  })
  .strict();

/**
 * Create-input form of `recording`: `true` is shorthand for
 * `{enabled:true}`; the server materialises the object form before storing.
 */
export const routingRecordingInputSchema = z.union([z.boolean(), routingRecordingSchema]);

/** Patch form of `recording`: `null` removes it, `true/false` toggles it. */
export const routingRecordingPatchInputSchema = z.union([z.boolean(), routingRecordingPatchSchema]).nullable();

/* ------------------------------------------------------------------ */
/* Schemas: rule + run record                                          */
/* ------------------------------------------------------------------ */

export const routingRunJobSchema = z.object({
  kind: z.enum(['room', 'rtmp', 'hls', 'recording']),
  status: routingStatusSchema,
  /** Destination index for room/stream jobs (absent for recording). */
  index: z.number().int().min(0).max(ROUTING_MAX_DESTINATIONS - 1).optional(),
  egressId: z.string().max(200).optional(),
  /** Sanitized error text; never contains a stream URL/secret. */
  error: z.string().max(300).optional(),
});
export type RoutingRunJob = z.infer<typeof routingRunJobSchema>;

export const routingRunRecordSchema = z.object({
  at: z.number().int().nonnegative(),
  trigger: routingTriggerSchema,
  status: routingRunStatusSchema,
  roomId: routingRoomIdSchema.optional(),
  jobs: z.array(routingRunJobSchema).max(ROUTING_MAX_DESTINATIONS + 1),
  /** Aggregate sanitized error (no URL/secret). */
  error: z.string().max(300).optional(),
});
export type RoutingRunRecord = z.infer<typeof routingRunRecordSchema>;

/**
 * A rule may target at most one room: an Edge publishes media exactly once into
 * one room, and egress derives every stream/recording from that room.
 */
function atMostOneRoomDestination(destinations: RoutingDestination[]): string | null {
  const rooms = destinations.filter((destination) => destination.type === 'room');
  return rooms.length > 1 ? 'a rule may target at most one room destination' : null;
}

export const routingRuleSchema = z
  .object({
    id: routingRuleIdSchema,
    tenantId: z.string().min(1).max(64),
    name: z.string().max(120).optional(),
    description: z.string().max(500).optional(),
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(ROUTING_MAX_PRIORITY),
    source: routingRuleSourceSchema,
    destinations: z.array(routingDestinationSchema).min(1).max(ROUTING_MAX_DESTINATIONS),
    recording: routingRecordingSchema.optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    /** Last evaluation of this rule (diagnostics; contains no secrets). */
    lastRun: routingRunRecordSchema.optional(),
  })
  .superRefine((rule, ctx) => {
    const issue = atMostOneRoomDestination(rule.destinations);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['destinations'], message: issue });
  });
export type RoutingRule = z.infer<typeof routingRuleSchema>;

/** POST /v1/admin/routes body. Defaults are applied server-side. */
export const routingRuleCreateSchema = z
  .object({
    id: routingRuleIdSchema.optional(),
    name: z.string().max(120).optional(),
    description: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(ROUTING_MAX_PRIORITY).optional(),
    source: routingRuleSourceSchema,
    destinations: z.array(routingDestinationSchema).min(1).max(ROUTING_MAX_DESTINATIONS),
    recording: routingRecordingInputSchema.optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const issue = atMostOneRoomDestination(rule.destinations);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['destinations'], message: issue });
  });
export type RoutingRuleCreate = z.infer<typeof routingRuleCreateSchema>;

/**
 * PATCH /v1/admin/routes/:id body: a deep-partial patch.
 *
 * Scalars merge, `source` merges field-by-field, `destinations` replaces the
 * list but each entry is deep-merged by array position (so a shorter list drops
 * trailing destinations, a longer list appends complete ones), and `recording`
 * merges (send `null` to remove it). The merged rule is re-validated.
 */
export const routingRulePatchSchema = z
  .object({
    name: z.string().max(120).nullable().optional(),
    description: z.string().max(500).nullable().optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(ROUTING_MAX_PRIORITY).optional(),
    source: routingRuleSourcePatchSchema.optional(),
    destinations: z.array(routingDestinationPatchSchema).max(ROUTING_MAX_DESTINATIONS).optional(),
    recording: routingRecordingPatchInputSchema.optional(),
  })
  .strict();
export type RoutingRulePatch = z.infer<typeof routingRulePatchSchema>;

/* ------------------------------------------------------------------ */
/* Rule normalisation / matching / selection                           */
/* ------------------------------------------------------------------ */

function uniquePublish(publish: RoutingPublishKind[] | undefined): RoutingPublishKind[] {
  if (!publish || publish.length === 0) return [...ROUTING_DEFAULTS.publish];
  return [...new Set(publish)];
}

/** Materialises destination defaults (`role`, `publish`, `layout`, `latency`). */
export function normalizeRoutingDestination(destination: RoutingDestination): RoutingDestination {
  if (destination.type === 'room') {
    return {
      ...destination,
      role: destination.role ?? ROUTING_DEFAULTS.roomRole,
      publish: uniquePublish(destination.publish),
    };
  }
  return {
    ...destination,
    layout: destination.layout ?? ROUTING_DEFAULTS.layout,
    latency: destination.latency ?? ROUTING_DEFAULTS.latency,
  };
}

/** Materialises rule defaults before it is validated/stored. */
export function normalizeRoutingRule(draft: {
  name?: string;
  description?: string;
  enabled?: boolean;
  priority?: number;
  source: RoutingRuleSource;
  destinations: RoutingDestination[];
  recording?: boolean | RoutingRecording;
}): Omit<RoutingRule, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'> {
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  const description = typeof draft.description === 'string' ? draft.description.trim() : '';
  const recording = typeof draft.recording === 'boolean' ? { enabled: draft.recording } : draft.recording;
  return {
    ...(name ? { name: name.slice(0, 120) } : {}),
    ...(description ? { description: description.slice(0, 500) } : {}),
    enabled: draft.enabled ?? ROUTING_DEFAULTS.enabled,
    priority: draft.priority ?? ROUTING_DEFAULTS.priority,
    source: { ...draft.source },
    destinations: draft.destinations.map(normalizeRoutingDestination),
    ...(recording
      ? {
          recording: {
            enabled: Boolean(recording.enabled),
            layout: recording.layout ?? ROUTING_DEFAULTS.layout,
            audioOnly: Boolean(recording.audioOnly),
          },
        }
      : {}),
  };
}

export interface RoutingSourceIdentity {
  type: RoutingSourceType;
  edgeId?: string;
  roomId?: string;
  tag?: string;
}

/**
 * True when a rule's source matches an evaluation identity. Missing selectors
 * are wildcards only for `edge`; `room` requires the exact id; `participant`
 * matches every provided selector (room and/or tag).
 */
export function matchesRoutingSource(source: RoutingRuleSource, identity: RoutingSourceIdentity): boolean {
  if (source.type !== identity.type) return false;
  if (source.type === 'edge') {
    if (source.edgeId !== undefined && source.edgeId !== identity.edgeId) return false;
    if (source.tag !== undefined && source.tag !== identity.tag) return false;
    return true;
  }
  if (source.type === 'room') return Boolean(source.roomId && source.roomId === identity.roomId);
  if (source.roomId !== undefined && source.roomId !== identity.roomId) return false;
  if (source.tag !== undefined && source.tag !== identity.tag) return false;
  return true;
}

/** Stable ordering: lower priority first, then older, then id. */
export function compareRoutingRules(a: RoutingRule, b: RoutingRule): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

/**
 * Selects the effective rule for an identity: enabled, source-matching, highest
 * priority (lowest number). Returns `null` when nothing matches.
 */
export function selectRoutingRule(rules: readonly RoutingRule[], identity: RoutingSourceIdentity): RoutingRule | null {
  const matches = rules.filter((rule) => rule.enabled && matchesRoutingSource(rule.source, identity));
  matches.sort(compareRoutingRules);
  return matches[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Secret-safe redaction helpers                                       */
/* ------------------------------------------------------------------ */

/**
 * Host-only form of an RTMP/HTTP URL (`rtmp://live.example:1935/…`). Never
 * returns userinfo, path, query or fragment — stream keys usually live there.
 */
export function routingUrlHost(raw: string | undefined): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const url = new URL(raw.trim());
    if (!url.hostname) return '…';
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '/' : '/…'}`;
  } catch {
    return '…';
  }
}

/** Secret-free view of one destination (safe for admin/Edge responses). */
export type RoutingDestinationView =
  | {
      type: 'room';
      roomId?: string;
      template?: string;
      role: Role;
      publish: RoutingPublishKind[];
    }
  | {
      type: 'stream';
      provider: RoutingStreamProvider;
      layout: RoutingLayout;
      latency: RoutingLatency;
      /** Host only; the stream key/URL is never returned. */
      urlHost?: string;
      secretRef?: string;
      hasSecret: boolean;
    };

export function routingDestinationView(destination: RoutingDestination): RoutingDestinationView {
  if (destination.type === 'room') {
    return {
      type: 'room',
      ...(destination.roomId ? { roomId: destination.roomId } : {}),
      ...(destination.template ? { template: destination.template } : {}),
      role: destination.role ?? ROUTING_DEFAULTS.roomRole,
      publish: uniquePublish(destination.publish),
    };
  }
  const hasSecret = Boolean(destination.url || destination.secretRef);
  return {
    type: 'stream',
    provider: destination.provider ?? 'rtmp',
    layout: destination.layout ?? ROUTING_DEFAULTS.layout,
    latency: destination.latency ?? ROUTING_DEFAULTS.latency,
    ...(destination.url ? { urlHost: routingUrlHost(destination.url) } : {}),
    ...(destination.secretRef ? { secretRef: destination.secretRef } : {}),
    hasSecret,
  };
}

/** Secret-free view of a rule. The raw `url` never leaves the server. */
export interface RoutingRuleView {
  id: string;
  tenantId: string;
  name?: string;
  description?: string;
  enabled: boolean;
  priority: number;
  source: RoutingRuleSource;
  destinations: RoutingDestinationView[];
  recording?: RoutingRecording;
  createdAt: number;
  updatedAt: number;
  lastRun?: RoutingRunRecord;
}

export function routingRuleView(rule: RoutingRule): RoutingRuleView {
  return {
    id: rule.id,
    tenantId: rule.tenantId,
    ...(rule.name ? { name: rule.name } : {}),
    ...(rule.description ? { description: rule.description } : {}),
    enabled: rule.enabled,
    priority: rule.priority,
    source: { ...rule.source },
    destinations: rule.destinations.map(routingDestinationView),
    ...(rule.recording ? { recording: { ...rule.recording } } : {}),
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    ...(rule.lastRun ? { lastRun: rule.lastRun } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Deep-partial patch merge                                            */
/* ------------------------------------------------------------------ */

/** Raised by {@link mergeRoutingRule}; the server maps it to 400 validation_failed. */
export class RoutingPatchError extends Error {
  readonly issues: Array<{ path: string; message: string }>;
  constructor(issues: Array<{ path: string; message: string }>) {
    super('routing_patch_invalid');
    this.name = 'RoutingPatchError';
    this.issues = issues;
  }
}

function definedPatchFields<T extends Record<string, unknown>>(patch: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function mergeSource(current: RoutingRuleSource, patch: NonNullable<RoutingRulePatch['source']>): RoutingRuleSource {
  const type = patch.type ?? current.type;
  // A type change starts from scratch: selectors of the old type are meaningless.
  const base: Record<string, unknown> = current.type === type ? { ...current } : { type };
  const merged = { ...base, ...definedPatchFields(patch as Record<string, unknown>) };
  for (const key of ['edgeId', 'roomId', 'tag'] as const) {
    if (merged[key] === null) delete merged[key];
  }
  return merged as unknown as RoutingRuleSource;
}

function mergeDestination(
  index: number,
  current: RoutingDestination | undefined,
  patch: RoutingDestinationPatch,
  issues: Array<{ path: string; message: string }>,
): RoutingDestination {
  const type = patch.type ?? current?.type;
  if (!type) {
    issues.push({ path: `destinations.${index}.type`, message: 'type is required for a new destination' });
    return { type: 'stream', provider: 'hls' } as RoutingDestination;
  }
  if (patch.type && current && patch.type !== current.type) {
    // A type change drops fields that belong to the old destination kind.
    const fresh: Record<string, unknown> = { type };
    const fields = definedPatchFields(patch as Record<string, unknown>);
    for (const [key, value] of Object.entries(fields)) {
      if (key !== 'type' && value !== null) fresh[key] = value;
    }
    return fresh as unknown as RoutingDestination;
  }
  const base = current && current.type === type ? { ...current } : { type };
  const fields = definedPatchFields(patch as Record<string, unknown>);
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'type') continue;
    if (value === null) {
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }
  // RTMP→HLS (or back) changes the credential model: a URL for one provider is
  // meaningless for the other, so drop it unless the patch sets it explicitly.
  if (
    type === 'stream' &&
    current &&
    current.type === 'stream' &&
    patch.provider !== undefined &&
    patch.provider !== current.provider &&
    patch.url === undefined &&
    patch.secretRef === undefined
  ) {
    delete merged.url;
    delete merged.secretRef;
  }
  return merged as unknown as RoutingDestination;
}

/**
 * Applies a deep-partial patch to a stored rule and returns the merged candidate
 * (still to be validated with {@link routingRuleSchema}).
 *
 * `destinations` semantics: the patched array defines the new list length; each
 * entry merges by position with the current entry at that index.
 */
export function mergeRoutingRule(
  current: RoutingRule,
  patch: RoutingRulePatch,
  now = Date.now(),
): RoutingRule {
  const issues: Array<{ path: string; message: string }> = [];
  const next: RoutingRule = {
    ...current,
    destinations: current.destinations.map((destination) => ({ ...destination })),
    ...(current.recording ? { recording: { ...current.recording } } : {}),
    updatedAt: now,
  };
  if (patch.name !== undefined) {
    if (patch.name === null) delete next.name;
    else {
      const name = patch.name.trim();
      if (name) next.name = name.slice(0, 120);
      else delete next.name;
    }
  }
  if (patch.description !== undefined) {
    if (patch.description === null) delete next.description;
    else {
      const description = patch.description.trim();
      if (description) next.description = description.slice(0, 500);
      else delete next.description;
    }
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.source !== undefined) next.source = mergeSource(current.source, patch.source);
  if (patch.destinations !== undefined) {
    next.destinations = patch.destinations.map((destinationPatch, index) =>
      mergeDestination(index, current.destinations[index], destinationPatch, issues),
    );
  }
  if (patch.recording !== undefined) {
    if (patch.recording === null) {
      delete next.recording;
    } else {
      const recordingPatch = typeof patch.recording === 'boolean' ? { enabled: patch.recording } : patch.recording;
      const base = current.recording
        ? { ...current.recording }
        : { enabled: false, layout: ROUTING_DEFAULTS.layout, audioOnly: false };
      for (const [key, value] of Object.entries(definedPatchFields(recordingPatch as Record<string, unknown>))) {
        if (value === null) delete (base as Record<string, unknown>)[key];
        else (base as Record<string, unknown>)[key] = value;
      }
      next.recording = base as RoutingRecording;
    }
  }
  if (issues.length > 0) throw new RoutingPatchError(issues);
  return next;
}

/* ------------------------------------------------------------------ */
/* Edge enrollment + join/test DTOs                                    */
/* ------------------------------------------------------------------ */

/** Admin request that issues a one-time (or N-use) Edge enrollment token. */
export const edgeEnrollmentCreateRequestSchema = z
  .object({
    name: z.string().max(80).optional(),
    /** Bind the token to one Edge id (body `edgeId` is then ignored). */
    edgeId: routingEdgeIdSchema.optional(),
    /** Bind the token to an Edge tag used by rule selectors. */
    tag: routingTagSchema.optional(),
    ttlSec: z.number().int().min(60).max(30 * 24 * 3600).optional(),
    uses: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type EdgeEnrollmentCreateRequest = z.infer<typeof edgeEnrollmentCreateRequestSchema>;

export interface EdgeEnrollmentTokenSummary {
  id: string;
  tenantId: string;
  name: string;
  edgeId?: string;
  tag?: string;
  createdAt: number;
  expiresAt: number;
  uses: number;
  used: number;
  revokedAt?: number;
  lastUsedAt?: number;
  status: RoutingEdgeTokenStatus;
}

export interface EdgeEnrollmentCreatedResponse {
  /** Plaintext enrollment token, returned exactly once. */
  token: string;
  enrollment: EdgeEnrollmentTokenSummary;
}

export interface EdgeEnrollmentListResponse {
  tokens: EdgeEnrollmentTokenSummary[];
}

/** `POST /v1/edge/join` body. The token is the only credential. */
export const edgeJoinRequestSchema = z
  .object({
    token: z.string().min(20).max(200),
    edgeId: routingEdgeIdSchema.optional(),
    tag: routingTagSchema.optional(),
    /** Display name for the Edge participant. */
    name: z.string().max(80).optional(),
  })
  .strict();
export type EdgeJoinRequest = z.infer<typeof edgeJoinRequestSchema>;

/** One resolved destination returned by an Edge join or a route test. */
export interface RoutingEffectiveDestination {
  index: number;
  type: 'room' | 'stream';
  /** Resolved room id for a room destination. */
  roomId?: string;
  role?: Role;
  publish?: RoutingPublishKind[];
  provider?: RoutingStreamProvider;
  layout?: RoutingLayout;
  latency?: RoutingLatency;
  /** Host-only stream URL; the stream key is never returned. */
  urlHost?: string;
  secretRef?: string;
  hasSecret?: boolean;
  status: RoutingStatus;
  egressId?: string;
  error?: string;
}

export interface RoutingEgressSummary {
  status: RoutingRunStatus;
  /** Stable machine-readable code for a degraded/failed run. */
  code?: 'egress_unavailable' | 'egress_failed' | 'partial_failure';
  jobs: number;
  destinations: number;
  errors: string[];
  /** First sanitized error (same text as `errors[0]`). */
  error?: string;
}

/**
 * `POST /v1/edge/join` response.
 *
 * The Edge publishes media **once** into `roomId`; any stream/recording
 * destinations are derived server-side by egress from that same room. The
 * response therefore never contains an RTMP URL with its stream key.
 */
export interface EdgeJoinResponse {
  tenantId: string;
  edgeId: string;
  routeId: string;
  /** Set when the join was resolved by a generic flow (`routeId` is the flow id). */
  flowId?: string;
  /** Always `room`: the single publish target of an Edge device. */
  publishTarget: 'room';
  roomId: string;
  room: {
    id: string;
    tenantId: string;
    name: string;
    mediaMode: string;
    maxParticipants: number;
  };
  joinToken: string;
  expiresAt: number;
  publisher: {
    role: Role;
    publish: RoutingPublishKind[];
  };
  destinations: RoutingEffectiveDestination[];
  egress: RoutingEgressSummary;
  limitations: string[];
}

/**
 * Partial join result produced by the generic flow evaluator
 * (`docs/flows.md`). `RoutingService` turns it into an {@link EdgeJoinResponse}
 * so an Edge can be enrolled and joined by a flow even when the tenant has no
 * legacy route. Media destinations are projected onto
 * {@link RoutingEffectiveDestination}; webhook/recording steps are reported by
 * `POST /v1/admin/flows/:id/status` and the flow's `lastRun` instead.
 */
export interface FlowEdgeJoinResult {
  flowId: string;
  roomId: string;
  room: { id: string; tenantId: string; name: string; mediaMode: string; maxParticipants: number };
  role: Role;
  publish: RoutingPublishKind[];
  joinToken: string;
  expiresAt: number;
  destinations: RoutingEffectiveDestination[];
  egress: RoutingEgressSummary;
  limitations: string[];
}

/** `POST /v1/admin/routes/:id/test` body. */
export const routingTestRequestSchema = z  .object({
    /** Target room for a room-source rule (defaults to `source.roomId`). */
    roomId: routingRoomIdSchema.optional(),
    /** Identity for an edge-source rule (defaults to the rule's selector). */
    edgeId: routingEdgeIdSchema.optional(),
    tag: routingTagSchema.optional(),
    /** `false` = dry run: resolve destinations, create/start nothing. */
    apply: z.boolean().optional(),
  })
  .strict();
export type RoutingTestRequest = z.infer<typeof routingTestRequestSchema>;

export interface RoutingTestResponse {
  routeId: string;
  matched: boolean;
  disabled: boolean;
  applied: boolean;
  /** Set when a higher-priority enabled rule shadows this one for the identity. */
  shadowedBy?: string;
  source: RoutingRuleSource;
  sourceIdentity: RoutingSourceIdentity;
  roomId?: string;
  roomCreated?: boolean;
  destinations: RoutingEffectiveDestination[];
  egress: RoutingEgressSummary;
  errors: string[];
  limitations: string[];
}

export interface RoutingRuleListResponse {
  routes: RoutingRuleView[];
}

export interface RoutingRuleResponse {
  route: RoutingRuleView;
}

export interface RoutingRuleDeletedResponse {
  deleted: true;
  id: string;
}

/** Baseline limitations surfaced by the API and `docs/routing.md`. */
export const ROUTING_LIMITATIONS: readonly string[] = [
  'edge: no Edge agent/firmware ships in this repository — the contract (enrollment token, `POST /v1/edge/join`, room publish) is implemented server-side only',
  'egress: RTMP/HLS needs a LiveKit egress worker (`AGIL_EGRESS_*`); without it runs report `egress_unavailable` and the call keeps working',
  'egress: one egress job per layout group (all RTMP destinations of the same layout share one job); HLS is produced by the worker, not by the Edge',
  'idempotency: egress jobs are deduplicated per process (tenant+room+route+destination signature); a Core restart may start a job that is already running — use `POST /v1/admin/egress/cleanup` or stop it explicitly',
  'participant sources are stored/validated but the baseline has no participant tags, so they are not selected at join time',
  'rooms: routing uses the in-memory room registry (rooms are not replicated across Cores); routes are a per-Core JSON file, not a shared database',
] as const;

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

export const routingPaths = {
  /** Tenant-scoped admin CRUD. */
  routes: '/v1/admin/routes',
  route: (routeId: string) => `/v1/admin/routes/${encodeURIComponent(routeId)}`,
  routeTest: (routeId: string) => `/v1/admin/routes/${encodeURIComponent(routeId)}/test`,
  /** Edge enrollment tokens (tenant admin). */
  edgeTokens: '/v1/admin/routes/edge-tokens',
  edgeToken: (tokenId: string) => `/v1/admin/routes/edge-tokens/${encodeURIComponent(tokenId)}`,
  /** Machine surface (enrollment token only, no admin key). */
  edgeJoin: '/v1/edge/join',
} as const;
