/**
 * Generic configurable media flow routing (`/v1/admin/flows`, `docs/flows.md`).
 *
 * The baseline in `routing.ts` models *one* source → room/stream/recording. A
 * **flow** generalises that shape:
 *
 * ```
 * sources[] ──► processors[] ──► sinks[]
 * room / edge /       layout grid     room (publish / another room)
 * participant /       audio mix       rtmp / hls / srt / recording
 * rtmp|srt|hls        transcode       cdn / webhook
 * ingest / file / sip (optional)
 * ```
 *
 * Design rules encoded here:
 *  - **No faking.** Every source/sink/processor kind advertises an *adapter
 *    capability*: `supported` means this build can execute it (LiveKit egress or
 *    the webhook dispatcher); `pending` means the shape is validated and stored
 *    but never executed — the evaluator reports `pending` and starts nothing
 *    that would misrepresent the configured media path. Transcode profiles and
 *    cross-room mixing are `pending` too.
 *  - **Branching and fan-in.** Several sinks derive from one mix (one encode,
 *    many outputs). Several sources are mixed only when they resolve to the
 *    *same* room; a single room-composite egress cannot mix two LiveKit rooms,
 *    so a cross-room fan-in is reported as `pending` (mixer adapter missing).
 *  - **Fallback.** `fallbackFlowId` names another flow of the same tenant. The
 *    evaluator tries the selected flow and, when it cannot deliver, the chain
 *    (depth-limited, cycle-safe). A flow never falls back to itself.
 *  - **Secrets stay server-side.** `url` is credential-bearing for RTMP/SRT and
 *    ingest pull endpoints (stream keys live in the path/query). Views expose
 *    only `urlHost` + `hasSecret`; a `secretRef` must be a server-owned
 *    `AGIL_ROUTE_SECRET_*` variable. SSRF/endpoint policy is enforced by the
 *    server on write and again at start.
 *
 * This module is browser-safe (zod + pure helpers); the server owns execution.
 */
import { z } from 'zod';
import { isAllowedTenantSecretEnv } from './secret-env.js';
import { roleSchema, type Role } from './signaling.js';
import {
  ROUTING_DEFAULTS,
  ROUTING_MAX_PRIORITY,
  ROUTING_MAX_TEMPLATE_LENGTH,
  ROUTING_MAX_URL_LENGTH,
  ROUTING_TEMPLATE_VARS,
  expandRoutingTemplate,
  routingEdgeIdSchema,
  routingLayoutSchema,
  routingLatencySchema,
  routingPublishKindSchema,
  routingRoomIdSchema,
  routingRunStatusSchema,
  routingStatusSchema,
  routingTagSchema,
  routingUrlHost,
  validateRoutingTemplate,
  type RoutingLayout,
  type RoutingLatency,
  type RoutingPublishKind,
  type RoutingRunStatus,
  type RoutingStatus,
  type RoutingTemplateVar,
} from './routing.js';

/* ------------------------------------------------------------------ */
/* Enumerations & limits                                               */
/* ------------------------------------------------------------------ */

/** Where media comes from. Only `room`/`edge`/`participant` are executable. */
export const FLOW_SOURCE_KINDS = [
  'room',
  'edge',
  'participant',
  'rtmp_ingest',
  'srt_ingest',
  'hls_ingest',
  'file',
  'sip',
] as const;
export const flowSourceKindSchema = z.enum(FLOW_SOURCE_KINDS);
export type FlowSourceKind = z.infer<typeof flowSourceKindSchema>;

/** Where media goes. */
export const FLOW_SINK_KINDS = ['room', 'rtmp', 'hls', 'srt', 'recording', 'cdn', 'webhook'] as const;
export const flowSinkKindSchema = z.enum(FLOW_SINK_KINDS);
export type FlowSinkKind = z.infer<typeof flowSinkKindSchema>;

/** What happens between sources and sinks. */
export const FLOW_PROCESSOR_KINDS = ['layout', 'audio_mix', 'transcode'] as const;
export const flowProcessorKindSchema = z.enum(FLOW_PROCESSOR_KINDS);
export type FlowProcessorKind = z.infer<typeof flowProcessorKindSchema>;

/** What starts a flow. */
export const FLOW_TRIGGER_KINDS = ['manual', 'room_start', 'edge_online', 'schedule'] as const;
export const flowTriggerKindSchema = z.enum(FLOW_TRIGGER_KINDS);
export type FlowTriggerKind = z.infer<typeof flowTriggerKindSchema>;

/** Identity types an evaluator can match (ingest adapters are not identities). */
export const FLOW_IDENTITY_TYPES = ['room', 'edge', 'participant'] as const;
export const flowIdentityTypeSchema = z.enum(FLOW_IDENTITY_TYPES);
export type FlowIdentityType = z.infer<typeof flowIdentityTypeSchema>;

export const FLOW_ID_PREFIX = 'fl_';
export const FLOW_MAX_FLOWS_PER_TENANT = 100;
export const FLOW_MAX_URL_LENGTH = ROUTING_MAX_URL_LENGTH;
export const FLOW_MAX_SOURCES = 8;
export const FLOW_MAX_SINKS = 12;
export const FLOW_MAX_PROCESSORS = 4;
export const FLOW_MAX_TRIGGERS = 4;
export const FLOW_MAX_PRIORITY = ROUTING_MAX_PRIORITY;
export const FLOW_DEFAULT_PRIORITY = ROUTING_DEFAULTS.priority;
export const FLOW_DEFAULT_LAYOUT: RoutingLayout = ROUTING_DEFAULTS.layout;
export const FLOW_DEFAULT_LATENCY: RoutingLatency = ROUTING_DEFAULTS.latency;
export const FLOW_DEFAULT_PUBLISH: RoutingPublishKind[] = [...ROUTING_DEFAULTS.publish];
export const FLOW_DEFAULT_ROLE: Role = ROUTING_DEFAULTS.roomRole;
export const FLOW_MIN_SCHEDULE_SEC = 30;
export const FLOW_MAX_SCHEDULE_SEC = 24 * 3600;
export const FLOW_MAX_FALLBACK_DEPTH = 3;
export const FLOW_MAX_LABEL_LENGTH = 80;
/** Recording containers the worker can produce today. */
export const FLOW_RECORDING_FORMATS = ['mp4', 'webm'] as const;
export const flowRecordingFormatSchema = z.enum(FLOW_RECORDING_FORMATS);
export type FlowRecordingFormat = z.infer<typeof flowRecordingFormatSchema>;
/** Webhook sink events. `started` fires after egress jobs were requested. */
export const FLOW_WEBHOOK_EVENTS = ['started', 'failed'] as const;
export const flowWebhookEventSchema = z.enum(FLOW_WEBHOOK_EVENTS);
export type FlowWebhookEvent = z.infer<typeof flowWebhookEventSchema>;
/** Object-storage providers a CDN sink may target (adapter pending). */
export const FLOW_CDN_PROVIDERS = ['s3', 'gcs', 'azure'] as const;
export const flowCdnProviderSchema = z.enum(FLOW_CDN_PROVIDERS);
/** Adapter-profile identifiers for the optional transcode processor (pending). */
export const FLOW_TRANSCODE_PROFILES = [
  'h264_720p30',
  'h264_1080p30',
  'hevc_1080p30',
  'aac_128k',
] as const;
export const flowTranscodeProfileSchema = z.enum(FLOW_TRANSCODE_PROFILES);
export type FlowTranscodeProfile = z.infer<typeof flowTranscodeProfileSchema>;
/** Audio-mix modes. `mix` is what a room-composite egress already does. */
export const FLOW_AUDIO_MIX_MODES = ['mix'] as const;
export const flowAudioMixModeSchema = z.enum(FLOW_AUDIO_MIX_MODES);
export type FlowAudioMixMode = z.infer<typeof flowAudioMixModeSchema>;

export const FLOW_DEFAULTS = {
  enabled: true,
  priority: FLOW_DEFAULT_PRIORITY,
  role: FLOW_DEFAULT_ROLE,
  publish: FLOW_DEFAULT_PUBLISH,
  layout: FLOW_DEFAULT_LAYOUT,
  latency: FLOW_DEFAULT_LATENCY,
  recordingFormat: 'mp4' as FlowRecordingFormat,
  webhookEvents: [...FLOW_WEBHOOK_EVENTS] as FlowWebhookEvent[],
} as const;

/* ------------------------------------------------------------------ */
/* Adapter capability matrix (single source of truth)                  */
/* ------------------------------------------------------------------ */

/**
 * `supported`  — this build executes the kind (egress composite / webhook POST);
 * `pending`    — modelled and validated only; evaluation reports `pending`
 *                with `reason` and never pretends the step happened.
 */
export type FlowAdapterState = 'supported' | 'pending';
export type FlowExecutionChannel = 'egress' | 'webhook' | 'none';

export interface FlowAdapterCapability {
  state: FlowAdapterState;
  /** How a supported adapter executes. */
  execution: FlowExecutionChannel;
  /** Why a pending adapter is pending (stable, user-facing English). */
  reason?: string;
}

export const FLOW_SOURCE_ADAPTERS: Record<FlowSourceKind, FlowAdapterCapability> = {
  room: {
    state: 'supported',
    execution: 'egress',
  },
  edge: {
    state: 'supported',
    execution: 'egress',
  },
  participant: {
    state: 'pending',
    execution: 'none',
    reason: 'participant-level media selection needs participant tags, which this build does not emit',
  },
  rtmp_ingest: {
    state: 'pending',
    execution: 'none',
    reason: 'use the managed RTMP push receiver API to publish into a room',
  },
  srt_ingest: {
    state: 'pending',
    execution: 'none',
    reason: 'use the managed SRT pull receiver API with an operator-registered listener',
  },
  hls_ingest: {
    state: 'pending',
    execution: 'none',
    reason: 'use the managed HLS pull receiver API with an operator-registered gateway source',
  },
  file: {
    state: 'pending',
    execution: 'none',
    reason: 'file/asset playback into a room needs a playback adapter; it is not installed by this build',
  },
  sip: {
    state: 'pending',
    execution: 'none',
    reason: 'SIP media legs are bridged into a room by the external LiveKit SIP service; a SIP flow source is not modelled yet',
  },
};

export const FLOW_SINK_ADAPTERS: Record<FlowSinkKind, FlowAdapterCapability> = {
  room: {
    state: 'supported',
    execution: 'egress',
  },
  rtmp: {
    state: 'supported',
    execution: 'egress',
  },
  hls: {
    state: 'supported',
    execution: 'egress',
  },
  recording: {
    state: 'supported',
    execution: 'egress',
  },
  webhook: {
    state: 'supported',
    execution: 'webhook',
  },
  srt: {
    state: 'pending',
    execution: 'none',
    reason: 'the egress client in this build exposes RTMP and HLS outputs only; SRT output needs a worker/adapter upgrade',
  },
  cdn: {
    state: 'pending',
    execution: 'none',
    reason: 'per-flow CDN/object-storage output needs a worker storage mapping; HLS storage is deployment-wide today',
  },
};

export const FLOW_PROCESSOR_ADAPTERS: Record<FlowProcessorKind, FlowAdapterCapability> = {
  layout: {
    state: 'supported',
    execution: 'egress',
  },
  audio_mix: {
    state: 'supported',
    execution: 'egress',
  },
  transcode: {
    state: 'pending',
    execution: 'none',
    reason: 'per-flow transcode profiles are not exposed by the egress client; the composite uses worker defaults',
  },
};

export const FLOW_TRIGGER_ADAPTERS: Record<FlowTriggerKind, FlowAdapterCapability> = {
  manual: { state: 'supported', execution: 'none' },
  room_start: { state: 'supported', execution: 'egress' },
  edge_online: { state: 'supported', execution: 'egress' },
  schedule: { state: 'supported', execution: 'egress' },
};

/** Extra capability notes for a *second* room sink (room → another room). */
export const FLOW_ROOM_FORWARD_REASON =
  'room → another room needs a room-output/participant egress (a forwarding adapter); the composite egress in this build produces RTMP/HLS/file outputs only';

/** Why a flow with sources in two different rooms cannot be mixed today. */
export const FLOW_CROSS_ROOM_MIX_REASON =
  'a room-composite egress mixes exactly one LiveKit room; sources in different rooms need a mixer adapter that is not installed';

/** Why an edge source cannot be resolved during a manual/dry-run evaluation. */
export const FLOW_EDGE_OFFLINE_REASON =
  'the edge is not online in a room; trigger the flow from an edge join or supply the roomId/edgeId of a live room';

/* ------------------------------------------------------------------ */
/* Schemas: source                                                     */
/* ------------------------------------------------------------------ */

const labelSchema = z.string().max(FLOW_MAX_LABEL_LENGTH);

/**
 * One media source.
 *
 * Field meaning depends on `kind` (validated below):
 *  - `room`        — `roomId` required; that LiveKit room is the mix input;
 *  - `edge`        — optional `edgeId`/`tag` selectors (wildcards when absent);
 *                    the Edge is a participant of the room it joined;
 *  - `participant` — optional `participantId`/`tag`/`roomId` selectors;
 *  - `*_ingest`    — `url` XOR `secretRef` (a pull endpoint), optional `roomId`
 *                    (the room the adapter would publish into);
 *  - `file`        — `assetId` XOR `url`, optional `roomId`;
 *  - `sip`         — `roomId` required (where SIP legs land), optional `tag`.
 */
export const flowSourceSchema = z
  .object({
    kind: flowSourceKindSchema,
    mode: z.enum(['push', 'pull']).optional(),
    sourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
    roomId: routingRoomIdSchema.optional(),
    edgeId: routingEdgeIdSchema.optional(),
    tag: routingTagSchema.optional(),
    participantId: z.string().min(1).max(64).optional(),
    url: z.string().max(ROUTING_MAX_URL_LENGTH).optional(),
    secretRef: z.string().max(100).optional(),
    assetId: z.string().min(1).max(128).optional(),
    label: labelSchema.optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    const forbid = (field: keyof typeof source, allowed: readonly string[]): void => {
      if (!allowed.includes(field) && source[field] !== undefined) {
        issue(String(field), `${String(field)} is not valid for a ${source.kind} source`);
      }
    };
    if (source.secretRef !== undefined && !isAllowedTenantSecretEnv(source.secretRef, 'route')) {
      issue('secretRef', 'secretRef must be a server-owned AGIL_ROUTE_SECRET_* variable');
    }
    if (source.mode !== 'pull') forbid('sourceId', []);
    if (source.mode === 'push') {
      if (source.kind !== 'rtmp_ingest') issue('mode', 'push is only available for an RTMP source');
      for (const field of ['edgeId', 'tag', 'participantId', 'assetId', 'url', 'secretRef'] as const) forbid(field, []);
      if (!source.roomId) issue('roomId', 'an RTMP push source requires a roomId');
      return;
    }
    if (source.mode === 'pull') {
      if (source.kind !== 'srt_ingest' && source.kind !== 'hls_ingest') issue('mode', 'managed pull is only available for SRT or HLS');
      for (const field of ['edgeId', 'tag', 'participantId', 'assetId', 'url', 'secretRef'] as const) forbid(field, []);
      if (!source.roomId) issue('roomId', 'a pull source requires a roomId');
      if (!source.sourceId) issue('sourceId', 'a pull source requires an operator-registered sourceId');
      return;
    }
    switch (source.kind) {
      case 'room':
        for (const field of ['edgeId', 'tag', 'participantId', 'url', 'secretRef', 'assetId'] as const) forbid(field, []);
        if (!source.roomId) issue('roomId', 'a room source requires roomId');
        return;
      case 'edge':
        for (const field of ['roomId', 'participantId', 'url', 'secretRef', 'assetId'] as const) forbid(field, []);
        return;
      case 'participant':
        for (const field of ['edgeId', 'url', 'secretRef', 'assetId'] as const) forbid(field, []);
        if (!source.roomId && !source.tag && !source.participantId) {
          issue('tag', 'a participant source requires roomId, tag and/or participantId');
        }
        return;
      case 'rtmp_ingest':
      case 'srt_ingest':
      case 'hls_ingest':
        for (const field of ['edgeId', 'tag', 'participantId', 'assetId'] as const) forbid(field, []);
        if (!source.url && !source.secretRef) issue('url', `a ${source.kind} source requires url or secretRef`);
        if (source.url && source.secretRef) issue('url', `a ${source.kind} source takes url or secretRef, not both`);
        return;
      case 'file':
        for (const field of ['edgeId', 'tag', 'participantId', 'secretRef', 'url'] as const) forbid(field, []);
        if (!source.assetId && !source.url) issue('assetId', 'a file source requires assetId or url');
        if (source.assetId && source.url) issue('assetId', 'a file source takes assetId or url, not both');
        return;
      case 'sip':
        for (const field of ['edgeId', 'participantId', 'url', 'secretRef', 'assetId'] as const) forbid(field, []);
        if (!source.roomId) issue('roomId', 'a sip source requires roomId (where the SIP legs land)');
        return;
    }
  });
export type FlowSource = z.infer<typeof flowSourceSchema>;

export function managedRtmpRoom(sources: FlowSource[]): string | undefined {
  return sources.find((source) => source.kind === 'rtmp_ingest' && source.mode === 'push')?.roomId;
}

export type ManagedPullTransport = 'srt' | 'hls';

export function managedPullSource(sources: FlowSource[]): { transport: ManagedPullTransport; roomId: string; sourceId: string } | undefined {
  const source = sources.find((item) => (item.kind === 'srt_ingest' || item.kind === 'hls_ingest') && item.mode === 'pull');
  return source?.roomId && source.sourceId
    ? { transport: source.kind === 'hls_ingest' ? 'hls' : 'srt', roomId: source.roomId, sourceId: source.sourceId }
    : undefined;
}

/* ------------------------------------------------------------------ */
/* Schemas: sinks                                                      */
/* ------------------------------------------------------------------ */

/**
 * One media destination.
 *
 *  - `room`      — a publish target (the first room sink) or "another room"
 *                  forward (additional room sinks, adapter pending);
 *  - `rtmp`      — `url` XOR `secretRef`; grouped with same-layout RTMP sinks
 *                  into one composite encode;
 *  - `hls`       — produced by the egress worker (no URL);
 *  - `recording` — an egress file output; `layout`, `audioOnly`, `format`;
 *  - `webhook`   — signed JSON POST on flow started/failed (not media egress);
 *  - `srt`, `cdn` — modelled adapters, pending.
 */
export const flowSinkSchema = z
  .object({
    kind: flowSinkKindSchema,
    label: labelSchema.optional(),
    // room sink
    roomId: routingRoomIdSchema.optional(),
    template: z.string().max(ROUTING_MAX_TEMPLATE_LENGTH).optional(),
    role: roleSchema.optional(),
    publish: z.array(routingPublishKindSchema).max(3).optional(),
    // credential-bearing sinks (rtmp, srt, webhook signing)
    url: z.string().max(ROUTING_MAX_URL_LENGTH).optional(),
    secretRef: z.string().max(100).optional(),
    // composite outputs
    layout: routingLayoutSchema.optional(),
    latency: routingLatencySchema.optional(),
    // recording
    audioOnly: z.boolean().optional(),
    format: flowRecordingFormatSchema.optional(),
    // cdn
    provider: flowCdnProviderSchema.optional(),
    bucket: z.string().max(200).optional(),
    pathPrefix: z.string().max(200).optional(),
    // webhook
    events: z.array(flowWebhookEventSchema).max(FLOW_WEBHOOK_EVENTS.length).optional(),
  })
  .strict()
  .superRefine((sink, ctx) => {
    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    if (sink.secretRef !== undefined && !isAllowedTenantSecretEnv(sink.secretRef, 'route')) {
      issue('secretRef', 'secretRef must be a server-owned AGIL_ROUTE_SECRET_* variable');
    }
    if (sink.events && new Set(sink.events).size !== sink.events.length) {
      issue('events', 'webhook events must be unique');
    }
    if (sink.publish && new Set(sink.publish).size !== sink.publish.length) {
      issue('publish', 'publish kinds must be unique');
    }
    const forbid = (allowed: readonly string[]): void => {
      for (const field of Object.keys(sink) as Array<keyof typeof sink>) {
        if (allowed.includes(field) || field === 'kind' || field === 'label') continue;
        if (sink[field] !== undefined) {
          issue(String(field), `${String(field)} is not valid for a ${sink.kind} sink`);
        }
      }
    };
    switch (sink.kind) {
      case 'room': {
        forbid(['roomId', 'template', 'role', 'publish']);
        if (!sink.roomId && !sink.template) issue('roomId', 'a room sink requires roomId or template');
        if (sink.roomId && sink.template) issue('roomId', 'a room sink takes roomId or template, not both');
        if (sink.template) {
          const templateIssue = validateRoutingTemplate(sink.template);
          if (templateIssue) issue('template', templateIssue);
        }
        return;
      }
      case 'rtmp':
      case 'srt': {
        forbid(['url', 'secretRef', 'layout', 'latency']);
        if (!sink.url && !sink.secretRef) issue('url', `a ${sink.kind} sink requires url or secretRef`);
        if (sink.url && sink.secretRef) issue('url', `a ${sink.kind} sink takes url or secretRef, not both`);
        return;
      }
      case 'hls': {
        forbid(['layout', 'latency']);
        return;
      }
      case 'recording': {
        forbid(['layout', 'audioOnly', 'format']);
        return;
      }
      case 'cdn': {
        forbid(['provider', 'bucket', 'pathPrefix', 'secretRef']);
        if (!sink.provider) issue('provider', 'a cdn sink requires provider');
        return;
      }
      case 'webhook': {
        forbid(['url', 'secretRef', 'events']);
        if (!sink.url) issue('url', 'a webhook sink requires url');
        return;
      }
    }
  });
export type FlowSink = z.infer<typeof flowSinkSchema>;
export type FlowRoomSink = FlowSink & { kind: 'room' };
export type FlowRtmpSink = FlowSink & { kind: 'rtmp' };
export type FlowHlsSink = FlowSink & { kind: 'hls' };
export type FlowSrtSink = FlowSink & { kind: 'srt' };
export type FlowRecordingSink = FlowSink & { kind: 'recording' };
export type FlowCdnSink = FlowSink & { kind: 'cdn' };
export type FlowWebhookSink = FlowSink & { kind: 'webhook' };

/* ------------------------------------------------------------------ */
/* Schemas: processors                                                 */
/* ------------------------------------------------------------------ */

/**
 * A processor step. `layout` and `audio_mix` are native to the room-composite
 * egress; `transcode` is an adapter placeholder (pending) so a flow never
 * claims an encoding profile the worker did not apply.
 */
export const flowProcessorSchema = z
  .object({
    kind: flowProcessorKindSchema,
    layout: routingLayoutSchema.optional(),
    mode: flowAudioMixModeSchema.optional(),
    audioOnly: z.boolean().optional(),
    profile: flowTranscodeProfileSchema.optional(),
  })
  .strict()
  .superRefine((processor, ctx) => {
    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    const forbid = (allowed: readonly string[]): void => {
      for (const field of Object.keys(processor) as Array<keyof typeof processor>) {
        if (allowed.includes(field) || field === 'kind') continue;
        if (processor[field] !== undefined) {
          issue(String(field), `${String(field)} is not valid for a ${processor.kind} processor`);
        }
      }
    };
    switch (processor.kind) {
      case 'layout':
        forbid(['layout']);
        if (!processor.layout) issue('layout', 'a layout processor requires layout');
        return;
      case 'audio_mix':
        forbid(['mode', 'audioOnly']);
        return;
      case 'transcode':
        forbid(['profile']);
        if (!processor.profile) issue('profile', 'a transcode processor requires profile');
        return;
    }
  });
export type FlowProcessor = z.infer<typeof flowProcessorSchema>;

/* ------------------------------------------------------------------ */
/* Schemas: triggers                                                   */
/* ------------------------------------------------------------------ */

export const flowTriggerSchema = z
  .object({
    kind: flowTriggerKindSchema,
    /** `schedule`: fire every N seconds (30 s … 24 h). */
    everySec: z.number().int().min(FLOW_MIN_SCHEDULE_SEC).max(FLOW_MAX_SCHEDULE_SEC).optional(),
    /** `schedule`: fire once at an absolute epoch-ms instant. */
    at: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((trigger, ctx) => {
    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    if (trigger.kind === 'schedule') {
      if (trigger.everySec === undefined && trigger.at === undefined) {
        issue('everySec', 'a schedule trigger requires everySec or at');
      }
      if (trigger.everySec !== undefined && trigger.at !== undefined) {
        issue('everySec', 'a schedule trigger takes everySec or at, not both');
      }
      return;
    }
    if (trigger.everySec !== undefined || trigger.at !== undefined) {
      issue('everySec', `everySec/at are only valid for a schedule trigger (${trigger.kind})`);
    }
  });
export type FlowTrigger = z.infer<typeof flowTriggerSchema>;

/* ------------------------------------------------------------------ */
/* Schemas: flow + create/patch DTOs                                   */
/* ------------------------------------------------------------------ */

const flowIdRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const flowIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(flowIdRe, 'must be 1..64 URL-safe characters (letters, digits, . _ -)');

/** Validates source/trigger consistency and processor uniqueness. */
function validateFlowShape(flow: {
  id?: string;
  sources: FlowSource[];
  processors?: FlowProcessor[];
  sinks: FlowSink[];
  triggers?: FlowTrigger[];
  fallbackFlowId?: string;
}, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: path ? path.split('.') : [], message });
  };
  if (flow.fallbackFlowId !== undefined && flow.id !== undefined && flow.fallbackFlowId === flow.id) {
    issue('fallbackFlowId', 'a flow cannot fall back to itself');
  }
  const triggers = flow.triggers ?? [];
  const triggerKinds = triggers.map((trigger) => trigger.kind);
  if (new Set(triggerKinds).size !== triggerKinds.length) issue('triggers', 'trigger kinds must be unique');
  // Processor uniqueness: one layout, one audio mix, at most two transcode profiles.
  const processors = flow.processors ?? [];
  const managedRoom = managedRtmpRoom(flow.sources) ?? managedPullSource(flow.sources)?.roomId;
  if (managedRoom) {
    const [sink] = flow.sinks;
    if (flow.sources.length !== 1) issue('sources', 'managed ingress requires one source');
    if (flow.sinks.length !== 1 || sink?.kind !== 'room' || sink.roomId !== managedRoom) {
      issue('sinks', 'managed ingress requires a single sink in the same room');
    } else {
      if (sink.role && sink.role !== FLOW_DEFAULTS.role) issue('sinks.0.role', 'managed ingress uses the default room role');
      if (sink.publish?.length && (new Set(sink.publish).size !== FLOW_DEFAULT_PUBLISH.length
        || FLOW_DEFAULT_PUBLISH.some((kind) => !sink.publish?.includes(kind)))) {
        issue('sinks.0.publish', 'managed ingress publishes the encoder tracks');
      }
    }
    if (triggerKinds.some((kind) => kind !== 'manual')) issue('triggers', 'managed ingress uses the manual receiver API');
    if (processors.length) issue('processors', 'managed ingress does not use flow processors');
    if (flow.fallbackFlowId) issue('fallbackFlowId', 'managed ingress has no fallback');
  }
  const processorKinds = processors.map((processor) => processor.kind);
  if (processorKinds.filter((kind) => kind === 'layout').length > 1) issue('processors', 'at most one layout processor');
  if (processorKinds.filter((kind) => kind === 'audio_mix').length > 1) issue('processors', 'at most one audio_mix processor');
  if (processorKinds.filter((kind) => kind === 'transcode').length > 2) issue('processors', 'at most two transcode processors');

  const hasSource = (predicate: (source: FlowSource) => boolean): boolean => flow.sources.some(predicate);
  if (triggerKinds.includes('room_start') && !hasSource((source) => source.kind === 'room' || source.kind === 'participant')) {
    issue('triggers', 'a room_start trigger requires a room or participant source');
  }
  if (triggerKinds.includes('edge_online') && !hasSource((source) => source.kind === 'edge')) {
    issue('triggers', 'an edge_online trigger requires an edge source');
  }
  if (
    triggerKinds.includes('schedule') &&
    !hasSource((source) => (source.kind === 'room' || source.kind === 'sip' || source.kind === 'participant') && Boolean(source.roomId))
  ) {
    issue('triggers', 'a schedule trigger requires a source bound to a room (room/participant/sip with roomId)');
  }
  // A flow that can be triggered by a room needs a room target: a room sink or
  // a room-bound source. Without one, evaluation cannot resolve a mix room.
  const hasRoomTarget =
    flow.sinks.some((sink) => sink.kind === 'room' && Boolean(sink.roomId || sink.template)) ||
    hasSource((source) => Boolean(source.roomId)) ||
    // An edge source can resolve an implicit `edge-<edgeId>` publish room.
    hasSource((source) => source.kind === 'edge');
  if (!hasRoomTarget) issue('sinks', 'a flow requires a room target: a room sink or a room-bound source');

  // Secret-bearing sink kinds: ensure the credential model is unambiguous.
  for (const [index, sink] of flow.sinks.entries()) {
    if (sink.kind === 'webhook' && sink.url) {
      const urlIssue = validateWebhookSinkUrl(sink.url);
      if (urlIssue) issue(`sinks.${index}.url`, urlIssue);
    }
  }
}

/** Shape-only webhook URL check (scheme/credentials); the server applies SSRF. */
export function validateWebhookSinkUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'webhook url is malformed';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `unsupported webhook scheme ${url.protocol}`;
  if (url.username || url.password) return 'webhook url must not contain credentials';
  return null;
}

export const flowSchema = z
  .object({
    id: flowIdSchema,
    tenantId: z.string().min(1).max(64),
    name: z.string().max(120).optional(),
    description: z.string().max(500).optional(),
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(FLOW_MAX_PRIORITY),
    sources: z.array(flowSourceSchema).min(1).max(FLOW_MAX_SOURCES),
    processors: z.array(flowProcessorSchema).max(FLOW_MAX_PROCESSORS),
    sinks: z.array(flowSinkSchema).min(1).max(FLOW_MAX_SINKS),
    triggers: z.array(flowTriggerSchema).min(1).max(FLOW_MAX_TRIGGERS),
    fallbackFlowId: flowIdSchema.optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    lastFiredAt: z.number().int().nonnegative().optional(),
    lastRun: z.lazy(() => flowRunRecordSchema).optional(),
  })
  .strict()
  .superRefine(validateFlowShape);
export type Flow = z.infer<typeof flowSchema>;

/** POST /v1/admin/flows body. Defaults are materialised server-side. */
export const flowCreateSchema = z
  .object({
    id: flowIdSchema.optional(),
    name: z.string().max(120).optional(),
    description: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(FLOW_MAX_PRIORITY).optional(),
    sources: z.array(flowSourceSchema).min(1).max(FLOW_MAX_SOURCES),
    processors: z.array(flowProcessorSchema).max(FLOW_MAX_PROCESSORS).optional(),
    sinks: z.array(flowSinkSchema).min(1).max(FLOW_MAX_SINKS),
    triggers: z.array(flowTriggerSchema).min(1).max(FLOW_MAX_TRIGGERS).optional(),
    fallbackFlowId: flowIdSchema.optional(),
  })
  .strict()
  .superRefine(validateFlowShape);
export type FlowCreate = z.infer<typeof flowCreateSchema>;

/**
 * PATCH /v1/admin/flows/:id body — a deep-partial patch.
 *
 * Scalars merge; `sources`, `processors`, `sinks` and `triggers` **replace the
 * whole list** (send complete entries), and `fallbackFlowId: null` removes the
 * fallback. The merged flow is re-validated. Replacement (instead of the
 * baseline's positional merge) avoids silently turning an RTMP sink into an HLS
 * sink by index when the list is reordered.
 */
export const flowPatchSchema = z
  .object({
    name: z.string().max(120).nullable().optional(),
    description: z.string().max(500).nullable().optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(FLOW_MAX_PRIORITY).optional(),
    sources: z.array(flowSourceSchema).min(1).max(FLOW_MAX_SOURCES).optional(),
    processors: z.array(flowProcessorSchema).max(FLOW_MAX_PROCESSORS).optional(),
    sinks: z.array(flowSinkSchema).min(1).max(FLOW_MAX_SINKS).optional(),
    triggers: z.array(flowTriggerSchema).min(1).max(FLOW_MAX_TRIGGERS).optional(),
    fallbackFlowId: flowIdSchema.nullable().optional(),
  })
  .strict();
export type FlowPatch = z.infer<typeof flowPatchSchema>;

/* ------------------------------------------------------------------ */
/* Run + evaluation DTOs                                               */
/* ------------------------------------------------------------------ */

export const FLOW_RUN_JOB_KINDS = ['room', 'mixer', 'rtmp', 'hls', 'srt', 'recording', 'cdn', 'webhook'] as const;
export const flowRunJobKindSchema = z.enum(FLOW_RUN_JOB_KINDS);
export type FlowRunJobKind = z.infer<typeof flowRunJobKindSchema>;

export const flowRunJobSchema = z.object({
  kind: flowRunJobKindSchema,
  status: routingStatusSchema,
  /** Sink index for sink jobs (absent for `mixer`). */
  index: z.number().int().min(0).max(FLOW_MAX_SINKS - 1).optional(),
  egressId: z.string().max(200).optional(),
  /** Sanitized error text; never contains a URL/secret. */
  error: z.string().max(300).optional(),
  /** Why a pending adapter did not execute. */
  pendingReason: z.string().max(300).optional(),
});
export type FlowRunJob = z.infer<typeof flowRunJobSchema>;

export const flowRunPendingSchema = z.object({
  path: z.string().max(120),
  kind: z.string().max(40),
  reason: z.string().max(300),
});
export type FlowRunPending = z.infer<typeof flowRunPendingSchema>;

/** Run outcomes persisted as `lastRun` (never `ready`: a run is not a room). */
export const FLOW_RUN_STATUSES = ['started', 'pending', 'partial', 'unavailable', 'failed', 'skipped'] as const;
export const flowRunStatusSchema = z.enum(FLOW_RUN_STATUSES);
export type FlowRunStatus = z.infer<typeof flowRunStatusSchema>;

export const flowRunRecordSchema = z.object({
  at: z.number().int().nonnegative(),
  trigger: flowTriggerKindSchema,
  status: flowRunStatusSchema,
  roomId: routingRoomIdSchema.optional(),
  jobs: z.array(flowRunJobSchema).max(FLOW_MAX_SINKS + 1),
  pending: z.array(flowRunPendingSchema).max(FLOW_MAX_SOURCES + FLOW_MAX_SINKS + FLOW_MAX_PROCESSORS),
  /** Aggregate sanitized error (no URL/secret). */
  error: z.string().max(300).optional(),
  /** Flow id that produced this run when it was a fallback. */
  fallbackOf: z.string().max(64).optional(),
});
export type FlowRunRecord = z.infer<typeof flowRunRecordSchema>;

/** Stable machine-readable run summary codes. */
export const FLOW_SUMMARY_CODES = [
  'egress_unavailable',
  'egress_failed',
  'partial_failure',
  'adapter_pending',
  'source_pending',
  'webhook_failed',
] as const;
export type FlowSummaryCode = (typeof FLOW_SUMMARY_CODES)[number];

export interface FlowRunSummary {
  status: FlowRunStatus;
  code?: FlowSummaryCode;
  /** Egress jobs requested (excluding webhook deliveries). */
  jobs: number;
  sinks: number;
  errors: string[];
  error?: string;
  pending: FlowRunPending[];
}

/** Secret-free view of one source. */
export type FlowSourceView = Omit<FlowSource, 'url'> & {
  /** Host-only redaction of an ingest `url`; the URL/key is never returned. */
  urlHost?: string;
  hasSecret: boolean;
};

/** Secret-free view of one sink. */
export type FlowSinkView = Omit<FlowSink, 'url'> & {
  /** Host-only redaction of an `rtmp`/`srt`/`webhook` `url`. */
  urlHost?: string;
  hasSecret: boolean;
};

/** Pure, capability-based execution plan of a flow (no I/O, no room registry). */
export interface FlowPlanPart {
  index: number;
  kind: string;
  state: FlowAdapterState;
  reason?: string;
}

export interface FlowPlanPending {
  path: string;
  kind: string;
  reason: string;
}

export interface FlowExecutionPlan {
  /** False when a required adapter is pending (nothing can be started safely). */
  executable: boolean;
  /** Adapter-level pending reasons (sources, sinks, processors). */
  pending: FlowPlanPending[];
  sources: FlowPlanPart[];
  sinks: FlowPlanPart[];
  processors: FlowPlanPart[];
  /** Effective composite layout (`layout` processor, else default). */
  layout: RoutingLayout;
  audioMix: boolean;
  transcodeProfiles: FlowTranscodeProfile[];
  /** Sinks that would execute today. */
  executableSinkIndexes: number[];
  /** Webhook sink indexes (delivered by the webhook dispatcher, not egress). */
  webhookSinkIndexes: number[];
  /** Room sink indexes; the first is the publish target, the rest are forwards. */
  roomSinkIndexes: number[];
}

/** Flow view returned by admin CRUD (never contains a URL/secret). */
export interface FlowView {
  id: string;
  tenantId: string;
  name?: string;
  description?: string;
  enabled: boolean;
  priority: number;
  sources: FlowSourceView[];
  processors: FlowProcessor[];
  sinks: FlowSinkView[];
  triggers: FlowTrigger[];
  fallbackFlowId?: string;
  createdAt: number;
  updatedAt: number;
  lastFiredAt?: number;
  lastRun?: FlowRunRecord;
  /** What this build can and cannot execute for the stored configuration. */
  plan: FlowExecutionPlan;
}

/** Effective result of one sink after an evaluation. */
export interface FlowEffectiveSink {
  index: number;
  kind: FlowSinkKind;
  status: RoutingStatus;
  execution: FlowExecutionChannel;
  roomId?: string;
  role?: Role;
  publish?: RoutingPublishKind[];
  layout?: RoutingLayout;
  latency?: RoutingLatency;
  urlHost?: string;
  secretRef?: string;
  hasSecret?: boolean;
  egressId?: string;
  /** Webhook delivery outcome (`delivered`/`failed`) when applicable. */
  delivery?: 'delivered' | 'failed';
  error?: string;
  pendingReason?: string;
}

/** Mixer/processor state of one evaluation. */
export interface FlowMixerState {
  status: FlowRunStatus;
  layout: RoutingLayout;
  audioMix: boolean;
  /** Configured transcode profiles (all pending adapters today). */
  transcodeProfiles: FlowTranscodeProfile[];
  sourceCount: number;
  /** Rooms that fed the mix; more than one room is a pending adapter. */
  roomIds: string[];
  reason?: string;
}

export interface FlowTestRequest {
  /** `false` = dry run: resolve the plan, start/notify nothing. */
  apply?: boolean;
  /** Simulated trigger (default `manual`). Must be declared for non-manual. */
  trigger?: FlowTriggerKind;
  /** Identity overrides for room/participant/sip/edge sources. */
  roomId?: string;
  edgeId?: string;
  tag?: string;
  participantId?: string;
}

export const flowTestRequestSchema = z
  .object({
    apply: z.boolean().optional(),
    trigger: flowTriggerKindSchema.optional(),
    roomId: routingRoomIdSchema.optional(),
    edgeId: routingEdgeIdSchema.optional(),
    tag: routingTagSchema.optional(),
    participantId: z.string().min(1).max(64).optional(),
  })
  .strict();

/** Identity used by selection/evaluation. */
export interface FlowSourceIdentity {
  type: FlowIdentityType;
  edgeId?: string;
  roomId?: string;
  tag?: string;
  participantId?: string;
}

export interface FlowTestResponse {
  flowId: string;
  matched: boolean;
  disabled: boolean;
  applied: boolean;
  trigger: FlowTriggerKind;
  /** Set when a higher-priority enabled flow shadows this one. */
  shadowedBy?: string;
  sourceIdentity: FlowSourceIdentity;
  roomId?: string;
  roomCreated?: boolean;
  mixer: FlowMixerState;
  sinks: FlowEffectiveSink[];
  summary: FlowRunSummary;
  /** Flow id that actually produced this evaluation (fallback). */
  fallbackOf?: string;
  errors: string[];
  limitations: string[];
}

export interface FlowStatus {
  flowId: string;
  tenantId: string;
  enabled: boolean;
  priority: number;
  plan: FlowExecutionPlan;
  triggers: Array<{ kind: FlowTriggerKind; supported: boolean; nextRunAt?: number; reason?: string }>;
  fallbackChain: string[];
  /** Rooms currently known to the registry that this flow would mix. */
  activeRoomIds: string[];
  lastFiredAt?: number;
  lastRun?: FlowRunRecord;
}

export interface FlowListResponse {
  flows: FlowView[];
}

export interface FlowResponse {
  flow: FlowView;
}

export interface FlowDeletedResponse {
  deleted: true;
  id: string;
}

/** Result of `POST /v1/admin/flows/tick` (also runs in-process every 30 s). */
export interface FlowTickResponse {
  tenantId: string;
  now: number;
  /** Scheduled flows whose next occurrence was due. */
  due: string[];
  evaluated: string[];
  skipped: Array<{ flowId: string; reason: string }>;
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

function uniquePublish(publish: RoutingPublishKind[] | undefined): RoutingPublishKind[] {
  if (!publish || publish.length === 0) return [...FLOW_DEFAULT_PUBLISH];
  return [...new Set(publish)];
}

/** Materialises sink defaults (`role`, `publish`, `layout`, `latency`, `format`, `events`). */
export function normalizeFlowSink(sink: FlowSink): FlowSink {
  switch (sink.kind) {
    case 'room':
      return { ...sink, role: sink.role ?? FLOW_DEFAULTS.role, publish: uniquePublish(sink.publish) };
    case 'recording':
      return {
        ...sink,
        layout: sink.layout ?? FLOW_DEFAULTS.layout,
        audioOnly: sink.audioOnly ?? false,
        format: sink.format ?? FLOW_DEFAULTS.recordingFormat,
      };
    case 'webhook':
      return {
        ...sink,
        events: sink.events && sink.events.length > 0 ? [...new Set(sink.events)] : [...FLOW_DEFAULTS.webhookEvents],
      };
    case 'rtmp':
    case 'hls':
      return { ...sink, layout: sink.layout ?? FLOW_DEFAULTS.layout, latency: sink.latency ?? FLOW_DEFAULTS.latency };
    default:
      return { ...sink };
  }
}

/** Materialises source/trigger defaults. */
export function normalizeFlowSource(source: FlowSource): FlowSource {
  return { ...source };
}

/** Materialises rule defaults before validation/storage. */
export function normalizeFlow(draft: {
  name?: string;
  description?: string;
  enabled?: boolean;
  priority?: number;
  sources: FlowSource[];
  processors?: FlowProcessor[];
  sinks: FlowSink[];
  triggers?: FlowTrigger[];
  fallbackFlowId?: string;
}): Omit<Flow, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'> {
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  const description = typeof draft.description === 'string' ? draft.description.trim() : '';
  return {
    ...(name ? { name: name.slice(0, 120) } : {}),
    ...(description ? { description: description.slice(0, 500) } : {}),
    enabled: draft.enabled ?? FLOW_DEFAULTS.enabled,
    priority: draft.priority ?? FLOW_DEFAULTS.priority,
    sources: draft.sources.map(normalizeFlowSource),
    processors: (draft.processors ?? []).map((processor) => ({ ...processor })),
    sinks: draft.sinks.map(normalizeFlowSink),
    triggers: (draft.triggers ?? [{ kind: 'manual' as const }]).map((trigger) => ({ ...trigger })),
    ...(draft.fallbackFlowId ? { fallbackFlowId: draft.fallbackFlowId } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Selection, fallback and trigger matching                            */
/* ------------------------------------------------------------------ */

/**
 * True when one source selects the identity. Only room/edge/participant
 * sources are identities; ingest/file/sip adapters are not triggered by an
 * identity (they activate through their adapter).
 */
export function flowSourceMatches(source: FlowSource, identity: FlowSourceIdentity): boolean {
  if (source.kind !== identity.type) return false;
  if (source.kind === 'edge') {
    if (source.edgeId !== undefined && source.edgeId !== identity.edgeId) return false;
    if (source.tag !== undefined && source.tag !== identity.tag) return false;
    return true;
  }
  if (source.kind === 'room') return Boolean(source.roomId && source.roomId === identity.roomId);
  // participant: every provided selector must match.
  if (source.roomId !== undefined && source.roomId !== identity.roomId) return false;
  if (source.tag !== undefined && source.tag !== identity.tag) return false;
  if (source.participantId !== undefined && source.participantId !== identity.participantId) return false;
  return true;
}

/** True when any source of the flow selects the identity. */
export function flowMatchesIdentity(flow: Flow, identity: FlowSourceIdentity): boolean {
  return flow.sources.some((source) => flowSourceMatches(source, identity));
}

/**
 * Trigger-aware match used by the live evaluator:
 *  - `room_start` matches a room-bound room/participant source;
 *  - `edge_online` matches an edge source;
 *  - `schedule` has no identity (its target room decides);
 *  - `manual` is always available to an admin diagnostic.
 */
export function flowMatchesTrigger(flow: Flow, trigger: FlowTriggerKind, identity?: FlowSourceIdentity): boolean {
  if (!flow.triggers.some((candidate) => candidate.kind === trigger)) return false;
  if (trigger === 'manual' || trigger === 'schedule') return true;
  if (!identity) return false;
  if (trigger === 'room_start') {
    if (identity.type !== 'room' || !identity.roomId) return false;
    return flow.sources.some(
      (source) => (source.kind === 'room' || source.kind === 'participant') && source.roomId === identity.roomId,
    );
  }
  if (identity.type !== 'edge') return false;
  return flow.sources.some((source) => flowSourceMatches(source, identity));
}

/** Stable ordering: lower priority first, then older, then id. */
export function compareFlows(a: Flow, b: Flow): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

/**
 * Selects the effective enabled flow for a trigger/identity (lowest priority
 * number). Returns `null` when nothing matches.
 */
export function selectFlow(
  flows: readonly Flow[],
  options: { trigger: FlowTriggerKind; identity?: FlowSourceIdentity },
): Flow | null {
  const matches = flows.filter(
    (flow) => flow.enabled && flowMatchesTrigger(flow, options.trigger, options.identity),
  );
  matches.sort(compareFlows);
  return matches[0] ?? null;
}

/**
 * Follows `fallbackFlowId` from `flow` through the tenant's flows. Returns the
 * chain including the starting flow, skipping disabled or missing targets and
 * stopping at a cycle. Depth-limited to {@link FLOW_MAX_FALLBACK_DEPTH} hops.
 */
export function flowFallbackChain(flows: readonly Flow[], flow: Flow): Flow[] {
  const byId = new Map(flows.map((candidate) => [candidate.id, candidate]));
  const chain: Flow[] = [flow];
  const seen = new Set([flow.id]);
  let current = flow;
  for (let hop = 0; hop < FLOW_MAX_FALLBACK_DEPTH; hop += 1) {
    const nextId = current.fallbackFlowId;
    if (!nextId || seen.has(nextId)) break;
    const next = byId.get(nextId);
    if (!next || !next.enabled) break;
    seen.add(next.id);
    chain.push(next);
    current = next;
  }
  return chain;
}

/**
 * Validates `fallbackFlowId` against the tenant's other flows: the target must
 * exist, be a different flow, and the chain must not exceed the depth limit.
 */
export function validateFlowFallback(
  candidate: Pick<Flow, 'id' | 'fallbackFlowId'>,
  others: readonly Flow[],
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const fallbackId = candidate.fallbackFlowId;
  if (!fallbackId) return issues;
  if (fallbackId === candidate.id) {
    issues.push({ path: 'fallbackFlowId', message: 'a flow cannot fall back to itself' });
    return issues;
  }
  const byId = new Map(others.map((flow) => [flow.id, flow]));
  const first = byId.get(fallbackId);
  if (!first) {
    issues.push({ path: 'fallbackFlowId', message: `fallback flow ${fallbackId} does not exist` });
    return issues;
  }
  const seen = new Set([candidate.id]);
  let current: Flow | undefined = first;
  let hops = 0;
  while (current) {
    if (seen.has(current.id)) {
      issues.push({ path: 'fallbackFlowId', message: `fallback chain contains a cycle at ${current.id}` });
      return issues;
    }
    seen.add(current.id);
    hops += 1;
    if (hops > FLOW_MAX_FALLBACK_DEPTH) {
      issues.push({ path: 'fallbackFlowId', message: `fallback chain is deeper than ${FLOW_MAX_FALLBACK_DEPTH}` });
      return issues;
    }
    current = current.fallbackFlowId ? byId.get(current.fallbackFlowId) : undefined;
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* Execution plan (pure)                                               */
/* ------------------------------------------------------------------ */

function capabilityFor(kind: FlowSourceKind | FlowSinkKind | FlowProcessorKind): FlowAdapterCapability {
  if ((FLOW_SOURCE_KINDS as readonly string[]).includes(kind)) {
    return FLOW_SOURCE_ADAPTERS[kind as FlowSourceKind];
  }
  if ((FLOW_SINK_KINDS as readonly string[]).includes(kind)) {
    return FLOW_SINK_ADAPTERS[kind as FlowSinkKind];
  }
  return FLOW_PROCESSOR_ADAPTERS[kind as FlowProcessorKind];
}

/**
 * Computes what this build can execute for a stored flow. Pure and
 * deterministic: no room registry, no egress, no env. The server uses it as the
 * first evaluation gate; the dashboard can render `pending` badges from it.
 */
export function planFlowExecution(flow: Pick<Flow, 'sources' | 'processors' | 'sinks'>): FlowExecutionPlan {
  const pending: FlowPlanPending[] = [];
  const part = (
    index: number,
    kind: FlowSourceKind | FlowSinkKind | FlowProcessorKind,
    path: string,
    extraReason?: string,
  ): FlowPlanPart => {
    const capability = capabilityFor(kind);
    if (extraReason) {
      pending.push({ path, kind, reason: extraReason });
      return { index, kind, state: 'pending', reason: extraReason };
    }
    if (capability.state === 'pending') {
      pending.push({ path, kind, reason: capability.reason ?? 'adapter is not implemented' });
      return { index, kind, state: 'pending', ...(capability.reason ? { reason: capability.reason } : {}) };
    }
    return { index, kind, state: 'supported' };
  };

  const sources = flow.sources.map((source, index) => part(
    index, source.kind, `sources.${index}`,
    source.mode === 'push' ? 'Manage this live receiver through the RTMP Ingress endpoint'
      : source.mode === 'pull' ? 'Manage this source through the SRT Ingress endpoint' : undefined,
  ));
  const processors = flow.processors.map((processor, index) => part(index, processor.kind, `processors.${index}`, undefined));

  const roomSinkIndexes: number[] = [];
  const webhookSinkIndexes: number[] = [];
  const executableSinkIndexes: number[] = [];
  const sinks = flow.sinks.map((sink, index) => {
    let extraReason: string | undefined;
    if (sink.kind === 'room') {
      const forward = roomSinkIndexes.length > 0;
      roomSinkIndexes.push(index);
      if (forward) extraReason = FLOW_ROOM_FORWARD_REASON;
    }
    if (sink.kind === 'recording' && sink.format === 'webm') {
      extraReason = 'the egress client writes MP4 file outputs; WEBM needs a transcoding worker and is pending';
    }
    const result = part(index, sink.kind, `sinks.${index}`, extraReason);
    if (result.state === 'supported') {
      executableSinkIndexes.push(index);
      if (sink.kind === 'webhook') webhookSinkIndexes.push(index);
    }
    return result;
  });

  const layoutProcessor = flow.processors.find((processor) => processor.kind === 'layout');
  const audioMix = flow.processors.some((processor) => processor.kind === 'audio_mix');
  const transcodeProfiles = flow.processors
    .filter((processor) => processor.kind === 'transcode')
    .map((processor) => processor.profile)
    .filter((profile): profile is FlowTranscodeProfile => Boolean(profile));
  const sourcePending = sources.some((source) => source.state === 'pending');
  const processorPending = processors.some((processor) => processor.state === 'pending');
  const executable =
    !sourcePending && !processorPending && executableSinkIndexes.length > 0;
  return {
    executable,
    pending,
    sources,
    sinks,
    processors,
    layout: layoutProcessor?.layout ?? FLOW_DEFAULT_LAYOUT,
    audioMix,
    transcodeProfiles,
    executableSinkIndexes,
    webhookSinkIndexes,
    roomSinkIndexes,
  };
}

/* ------------------------------------------------------------------ */
/* Deep-partial patch merge                                            */
/* ------------------------------------------------------------------ */

/**
 * Applies a PATCH to a stored flow. Scalars merge, `fallbackFlowId: null`
 * removes the fallback, and the list fields (`sources`, `processors`, `sinks`,
 * `triggers`) replace the whole list. The caller re-validates the result with
 * {@link flowSchema}.
 */
export function mergeFlow(current: Flow, patch: FlowPatch, now = Date.now()): Flow {
  const next: Flow = {
    ...current,
    sources: current.sources.map((source) => ({ ...source })),
    processors: current.processors.map((processor) => ({ ...processor })),
    sinks: current.sinks.map((sink) => ({ ...sink })),
    triggers: current.triggers.map((trigger) => ({ ...trigger })),
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
  if (patch.sources !== undefined) next.sources = patch.sources.map((source) => ({ ...source }));
  if (patch.processors !== undefined) next.processors = patch.processors.map((processor) => ({ ...processor }));
  if (patch.sinks !== undefined) next.sinks = patch.sinks.map((sink) => ({ ...sink }));
  if (patch.triggers !== undefined) next.triggers = patch.triggers.map((trigger) => ({ ...trigger }));
  if (patch.fallbackFlowId !== undefined) {
    if (patch.fallbackFlowId === null) delete next.fallbackFlowId;
    else next.fallbackFlowId = patch.fallbackFlowId;
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Secret-safe views                                                   */
/* ------------------------------------------------------------------ */

export function flowSourceView(source: FlowSource): FlowSourceView {
  const { url, ...rest } = source;
  return {
    ...rest,
    ...(url ? { urlHost: routingUrlHost(url) } : {}),
    hasSecret: Boolean(url || source.secretRef),
  };
}

export function flowSinkView(sink: FlowSink): FlowSinkView {
  const { url, ...rest } = sink;
  return {
    ...rest,
    ...(url ? { urlHost: routingUrlHost(url) } : {}),
    hasSecret: Boolean(url || sink.secretRef),
  };
}

export function flowView(flow: Flow): FlowView {
  return {
    id: flow.id,
    tenantId: flow.tenantId,
    ...(flow.name ? { name: flow.name } : {}),
    ...(flow.description ? { description: flow.description } : {}),
    enabled: flow.enabled,
    priority: flow.priority,
    sources: flow.sources.map(flowSourceView),
    processors: flow.processors.map((processor) => ({ ...processor })),
    sinks: flow.sinks.map(flowSinkView),
    triggers: flow.triggers.map((trigger) => ({ ...trigger })),
    ...(flow.fallbackFlowId ? { fallbackFlowId: flow.fallbackFlowId } : {}),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    ...(flow.lastFiredAt !== undefined ? { lastFiredAt: flow.lastFiredAt } : {}),
    ...(flow.lastRun ? { lastRun: flow.lastRun } : {}),
    plan: planFlowExecution(flow),
  };
}

/* ------------------------------------------------------------------ */
/* Schedule helpers                                                    */
/* ------------------------------------------------------------------ */

/** The declared schedule triggers of a flow (usually zero or one). */
export function flowScheduleTriggers(flow: Pick<Flow, 'triggers'>): FlowTrigger[] {
  return flow.triggers.filter((trigger) => trigger.kind === 'schedule');
}

/**
 * Next occurrence for one schedule trigger:
 *  - `at`   — the absolute instant, unless it already fired;
 *  - `everySec` — `max(createdAt, lastFiredAt ?? createdAt) + everySec * 1000`.
 * Returns `null` when the schedule is exhausted or no schedule exists.
 */
export function nextFlowScheduleAt(
  trigger: FlowTrigger,
  options: { createdAt: number; lastFiredAt?: number; now?: number },
): number | null {
  if (trigger.kind !== 'schedule') return null;
  if (trigger.at !== undefined) {
    if (options.lastFiredAt !== undefined && options.lastFiredAt >= trigger.at) return null;
    return trigger.at;
  }
  if (trigger.everySec === undefined) return null;
  const base = Math.max(options.createdAt, options.lastFiredAt ?? options.createdAt);
  return base + trigger.everySec * 1000;
}

/** True when a schedule trigger is due at `now` (never fires twice per boundary). */
export function isFlowScheduleDue(
  flow: Pick<Flow, 'triggers' | 'createdAt' | 'lastFiredAt'>,
  now: number,
): boolean {
  const triggers = flowScheduleTriggers(flow);
  if (triggers.length === 0) return false;
  if (flow.lastFiredAt !== undefined && flow.lastFiredAt >= now) return false;
  return triggers.some((trigger) => {
    const next = nextFlowScheduleAt(trigger, {
      createdAt: flow.createdAt,
      ...(flow.lastFiredAt !== undefined ? { lastFiredAt: flow.lastFiredAt } : {}),
      now,
    });
    return next !== null && next <= now;
  });
}

/** Earliest next occurrence across the flow's schedule triggers (for `status`). */
export function nextFlowRunAt(flow: Pick<Flow, 'triggers' | 'createdAt' | 'lastFiredAt'>): number | null {
  const triggers = flowScheduleTriggers(flow);
  if (triggers.length === 0) return null;
  let best: number | null = null;
  for (const trigger of triggers) {
    const next = nextFlowScheduleAt(trigger, {
      createdAt: flow.createdAt,
      ...(flow.lastFiredAt !== undefined ? { lastFiredAt: flow.lastFiredAt } : {}),
    });
    if (next === null) continue;
    if (best === null || next < best) best = next;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

/**
 * Template variables available to a flow sink. Superset of the routing ones:
 * a flow also knows the flow id and the trigger/identity.
 */
export const FLOW_TEMPLATE_VARS: readonly string[] = [
  ...ROUTING_TEMPLATE_VARS,
  'flowId',
] as const;
export type FlowTemplateVar = RoutingTemplateVar | 'flowId';

export function expandFlowTemplate(
  template: string,
  vars: Partial<Record<FlowTemplateVar, string>>,
): string {
  return expandRoutingTemplate(template, vars);
}

/* ------------------------------------------------------------------ */
/* Limitations + paths                                                 */
/* ------------------------------------------------------------------ */

/** Honest capability statement surfaced by the API and `docs/flows.md`. */
export const FLOW_LIMITATIONS: readonly string[] = [
  'one LiveKit room per composite egress: a flow mixes only sources that resolve to the same room; cross-room fan-in needs a mixer adapter and is reported as pending',
  'the evaluator marks external ingest sources as pending; managed RTMP, SRT and HLS publish into a single room through their receiver APIs',
  'participant selection, file playback, SIP, SRT/CDN sinks, room→another-room forward, transcode, and WEBM recording report pending in the evaluator',
  'webhook sinks are delivered by the Core (signed JSON POST), independent of the media path; they report `delivered`/`failed` per sink',
  'a scheduled flow only evaluates when its target room exists and has participants; otherwise the occurrence is recorded as `skipped`',
  'flows are a per-Core JSON file, like routes; rooms are in the in-memory registry',
  'no automated egress stop when a flow is deleted or its room closes — stop jobs explicitly (`POST /v1/rooms/:roomId/egress/:id/stop` or `/v1/admin/egress/cleanup`)',
  '`/v1/admin/routes` remains the legacy single-source surface; an equivalent flow provides the same egress execution plus branching/fan-in/processors',
] as const;

export const flowPaths = {
  flows: '/v1/admin/flows',
  flow: (flowId: string) => `/v1/admin/flows/${encodeURIComponent(flowId)}`,
  flowTest: (flowId: string) => `/v1/admin/flows/${encodeURIComponent(flowId)}/test`,
  flowStatus: (flowId: string) => `/v1/admin/flows/${encodeURIComponent(flowId)}/status`,
  /** Ops/diagnostic: evaluate due schedule triggers now. */
  flowTick: '/v1/admin/flows/tick',
  /** Edge enrollment tokens for flow-only tenants (alias of the routing surface). */
  flowEdgeTokens: '/v1/admin/flows/edge-tokens',
  flowEdgeToken: (tokenId: string) => `/v1/admin/flows/edge-tokens/${encodeURIComponent(tokenId)}`,
} as const;

/** Statuses a flow evaluation can report (re-exported for dashboard code). */
export const FLOW_STATUSES = ['ready', 'started', 'pending', 'partial', 'unavailable', 'failed', 'skipped'] as const;
