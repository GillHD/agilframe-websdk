/**
 * Scale-out configuration: media plane mode, multi-node signaling, TURN pool,
 * SFU, webinar/streaming, CDN and the optional SIP/PSTN gateway.
 *
 * Declares the multi-node/SFU/TURN topology (configs + admin API + generated
 * welcome ICE servers); defaults keep a single-node mesh install working.
 */
import { z } from 'zod';
import { clusterIdSchema, managedNodeIdSchema } from './cluster.js';
import { deepPartialObject } from './patch-schema.js';

export const mediaModeSchema = z.enum(['mesh', 'sfu', 'broadcast']);
export type MediaMode = z.infer<typeof mediaModeSchema>;

export const scaleNodeSchema = z.object({
  id: z.string().min(1).max(64),
  /** Public/internal base URL of the signaling+API node (https://...). */
  url: z.string().max(300),
  region: z.string().max(64),
  weight: z.number().int().min(1).max(100),
  healthy: z.boolean().optional(),
});
export type ScaleNode = z.infer<typeof scaleNodeSchema>;

export const turnServerSchema = z.object({
  id: z.string().min(1).max(64),
  /** Optional enrolled node whose managed TURN module serves this relay. */
  nodeId: clusterIdSchema.optional(),
  urls: z.array(z.string().max(300)).min(1).max(10),
  credentialMode: z.enum(['static', 'rest']).optional(),
  username: z.string().max(200),
  /** Env variable name holding the TURN credential (never the secret itself). */
  credentialEnv: z.string().max(100),
  region: z.string().max(64),
  weight: z.number().int().min(1).max(100),
});
export type TurnServerConfig = z.infer<typeof turnServerSchema>;

export const turnNodeStates = [
  'ready', 'node_not_found', 'node_disabled', 'node_offline', 'node_draining',
  'module_management_disabled', 'docker_unavailable', 'inventory_stale',
  'turn_feature_disabled', 'module_disabled', 'turn_not_installed', 'turn_not_running', 'turn_unhealthy', 'turn_endpoint_missing',
] as const;
export type TurnNodeState = (typeof turnNodeStates)[number];

/**
 * Capacity profiles size the *client* gallery video budget for the deployed
 * media plane.
 *
 * The video numbers are remote videos a client subscribes per gallery page
 * *above 8 participants* (small rooms keep all visible videos); every profile
 * is still capped by `scale.maxVideoSubscriptions` (default 36) and by the
 * per-tenant `limits.galleryVideoBudget` / `scale.maxVisibleVideos` override.
 */
export const sfuCapacityProfileSchema = z.enum(['low', 'standard', 'high']);
export type SfuCapacityProfile = z.infer<typeof sfuCapacityProfileSchema>;

export interface SfuCapacityProfileSpec {
  profile: SfuCapacityProfile;
  /** Planned vCPU range for the media plane (documentation only). */
  vcpu: string;
  /** Planned RAM in GB (documentation only). */
  memoryGb: number;
  /** Participants one SFU node of this size should carry. */
  participants: number;
  /** Remote videos a client subscribes per page above 8 participants. */
  remoteVideosPerClient: number;
  /** Honest sizing caveat shown in status/docs. */
  note: string;
}

/**
 * Planning table, not a benchmark: measured capacity must be re-validated per
 * deployment.
 */
export const SFU_CAPACITY_PROFILES: Record<SfuCapacityProfile, SfuCapacityProfileSpec> = {
  low: {
    profile: 'low',
    vcpu: '1-2',
    memoryGb: 2,
    participants: 25,
    remoteVideosPerClient: 2,
    note: 'Current 1 vCPU / 2 GB pilot: 2 remote videos per client above 8 participants (pinned + active speaker).',
  },
  standard: {
    profile: 'standard',
    vcpu: '8-16',
    memoryGb: 16,
    participants: 50,
    remoteVideosPerClient: 6,
    note: 'Default for new deployments: 8-16 vCPU / 16 GB, 6 remote videos per client, ~50 participants per node.',
  },
  high: {
    profile: 'high',
    vcpu: '16-32',
    memoryGb: 32,
    participants: 200,
    remoteVideosPerClient: 12,
    note: '16-32 vCPU / 32 GB, 12 remote videos per client, 100-200 participants per node. A 50-video client budget needs cascading/more nodes.',
  },
};

/** Deployment default when nothing else is configured. */
export const DEFAULT_SFU_CAPACITY_PROFILE: SfuCapacityProfile = 'standard';

/** Normalises a configured/env profile; unknown values fall back to `standard`. */
export function resolveSfuCapacityProfile(value: unknown): SfuCapacityProfile {
  return value === 'low' || value === 'standard' || value === 'high'
    ? value
    : DEFAULT_SFU_CAPACITY_PROFILE;
}

/** Which configured limit decided the effective participant cap. */
export type CapacityLimit = 'room' | 'scale' | 'profile' | 'sfu';

/**
 * Effective participant cap for one room.
 *
 * The server is the capacity authority: the smaller of the room's own
 * `maxParticipants`, the tenant `scale.maxParticipants`, the effective SFU
 * capacity profile (`SFU_CAPACITY_PROFILES[profile].participants`) and
 * `scale.sfu.maxParticipants`. `limit` names the binding constraint so the API
 * can explain a `room_full` rejection.
 *
 * Mesh rooms are not limited by the SFU profile/sfu cap (P2P); for them the
 * binding limit is the smaller of `room` and `scale`.
 */
export interface ParticipantCapacity {
  effectiveMaxParticipants: number;
  /** The smallest limit; ties prefer `profile` → `sfu` → `scale` → `room`. */
  limit: CapacityLimit;
  profile: SfuCapacityProfile;
  profileParticipants: number;
  roomMaxParticipants: number;
  scaleMaxParticipants: number;
  sfuMaxParticipants: number;
}

export const sfuConfigSchema = z.object({
  provider: z.enum(['livekit', 'mediasoup', 'external']),
  url: z.string().max(300),
  apiKeyEnv: z.string().max(100),
  apiSecretEnv: z.string().max(100),
  region: z.string().max(64),
  maxParticipants: z.number().int().min(2).max(50000),
  /**
   * Gallery capacity profile. Unset = deployment default (`AGIL_SFU_PROFILE`
   * env, else `standard`). The env wins when both are set.
   */
  capacityProfile: sfuCapacityProfileSchema.optional(),
});
export type SfuConfig = z.infer<typeof sfuConfigSchema>;

export const loadBalancerSchema = z.object({
  strategy: z.enum(['round-robin', 'least-rooms', 'geo', 'weighted']),
  healthPath: z.string().max(200),
  stickyCookie: z.string().max(120),
});

export const webinarConfigSchema = z.object({
  enabled: z.boolean(),
  /** Only hosts/moderators publish audio/video; viewers are receive-only. */
  hostOnlyPublish: z.boolean(),
  viewerLimit: z.number().int().min(2).max(50000),
  chatMode: z.enum(['moderated', 'open']),
  reactions: z.boolean(),
  raiseHandQueue: z.boolean(),
});

export const streamingConfigSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['none', 'rtmp', 'hls', 'webrtc']),
  rtmpUrl: z.string().max(300),
  hlsUrl: z.string().max(300),
  playbackProtocol: z.enum(['hls', 'whep']).default('hls'),
  whepUrl: z.string().max(300).default(''),
  latencyMode: z.enum(['low', 'standard']),
});

export const cdnConfigSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().max(300),
  provider: z.string().max(64),
});

/** E.164 phone number: `+`, a non-zero country code and 7..14 more digits. */
export const E164_RE = /^\+[1-9]\d{6,14}$/;

export const e164Schema = z
  .string()
  .max(16)
  .regex(E164_RE, 'must be an E.164 phone number (+<country><number>)');

/** True when `value` is a syntactically valid E.164 number. */
export function isE164(value: unknown): value is string {
  return typeof value === 'string' && E164_RE.test(value);
}

export const sipProviderSchema = z.enum(['livekit-sip']);
export type SipProvider = z.infer<typeof sipProviderSchema>;

/**
 * Optional SIP/PSTN gateway (LiveKit SIP). Off by default: enabling it requires
 * a deployed LiveKit SIP service, a trunk and (for calling) PSTN termination.
 * `dialInNumbers` are the published DID numbers, `callerId` the outbound From
 * number; credentials never live in the config — only env (`AGIL_SIP_*`).
 */
export const sipConfigSchema = z.object({
  enabled: z.boolean(),
  provider: sipProviderSchema,
  /** Optional enrolled gateway dependency for new Core-originated calls. */
  nodeId: managedNodeIdSchema.optional(),
  /** WebSocket URL of the LiveKit deployment (informational). */
  wsUrl: z.string().max(300),
  /** HTTP(S) base URL of the LiveKit API used for Twirp calls. */
  httpUrl: z.string().max(300),
  /** LiveKit SIP trunk id (`ST_...`); creates calls through this trunk. */
  trunkId: z.string().max(120),
  /** Published PSTN numbers (DIDs) for inbound dial-in. */
  dialInNumbers: z.array(e164Schema).max(20),
  /** Outbound caller id (From number); empty = trunk default. */
  callerId: z.union([z.literal(''), e164Schema]),
  /** Max concurrent SIP participants per room (baseline guard, best effort). */
  maxConcurrent: z.number().int().min(1).max(1000),
  /** Hard cap for one PSTN call (`max_call_duration` sent to LiveKit SIP). */
  maxCallDurationSec: z.number().int().min(60).max(86400).default(3600),
  region: z.string().max(64),
});
export type SipConfig = z.infer<typeof sipConfigSchema>;

/** Deep-partial of `scale.sip` (used by the tenant-config PATCH contract). */
export const sipConfigPatchSchema = deepPartialObject(sipConfigSchema);

export const DEFAULT_SIP_CONFIG: SipConfig = {
  enabled: false,
  provider: 'livekit-sip',
  wsUrl: '',
  httpUrl: '',
  trunkId: '',
  dialInNumbers: [],
  callerId: '',
  maxConcurrent: 10,
  maxCallDurationSec: 3600,
  region: '',
};

/** Fresh default (arrays must not be shared between tenant configs). */
export function defaultSipConfig(): SipConfig {
  return { ...DEFAULT_SIP_CONFIG, dialInNumbers: [] };
}

export const scaleConfigSchema = z.object({
  /** mesh = P2P; sfu = one SFU hop; broadcast = webinar/streaming. */
  mediaMode: mediaModeSchema,
  /** Default per-room participant cap (used when the room does not override). */
  maxParticipants: z.number().int().min(2).max(50000),
  maxVideoSubscriptions: z.number().int().min(1).max(1000),
  /**
   * Optional gallery video budget alias (`limits.galleryVideoBudget` wins).
   * Unset = adaptive: ≤8 participants all visible videos, 9+ → the active
   * capacity profile's budget (`scale.sfu.capacityProfile`, env
   * `AGIL_SFU_PROFILE`, default standard: 2/6/12 for low/standard/high). Never
   * above `maxVideoSubscriptions`. See `agil/core/docs/large-rooms.md`.
   */
  maxVisibleVideos: z.number().int().min(1).max(1000).optional(),
  signaling: z.object({
    nodeId: z.string().max(64),
    /** Redis-compatible pub/sub endpoint for cross-node broadcast (empty = single node). */
    redisUrl: z.string().max(300),
    pubsubChannel: z.string().max(120),
    stickySessions: z.boolean(),
    nodes: z.array(scaleNodeSchema).max(100),
  }),
  sfu: sfuConfigSchema,
  /** TURN pool: every server is advertised to clients in `welcome.iceServers`. */
  turn: z.array(turnServerSchema).max(20),
  loadBalancer: loadBalancerSchema,
  webinar: webinarConfigSchema,
  streaming: streamingConfigSchema,
  cdn: cdnConfigSchema,
  /**
   * Optional SIP/PSTN gateway (off by default).
   * `.default()` keeps persisted configs without `scale.sip` loadable; PATCH
   * remains deep-partial through `scaleConfigPatchSchema` below.
   */
  sip: sipConfigSchema.default(defaultSipConfig),
});

export type ScaleConfig = z.infer<typeof scaleConfigSchema>;

/**
 * Deep-partial of `ScaleConfig` for PATCH-style writes. `scale.sip` is spelled
 * out explicitly so a patch like `{enabled, trunkId}` merges into the stored
 * value instead of being replaced by the schema default.
 */
export const scaleConfigPatchSchema = deepPartialObject(scaleConfigSchema).extend({
  sip: sipConfigPatchSchema.optional(),
});

/**
 * Large-room profile: one room up to 200 participants, while a client keeps
 * only one gallery page (25–36 tiles) of video subscriptions. Defaults, not a
 * guarantee — operators must size the SFU/TURN nodes for the real bitrate.
 */
export const LARGE_ROOM_MAX_PARTICIPANTS = 200;
export const LARGE_ROOM_MAX_VIDEO_SUBSCRIPTIONS = 36;
export const LARGE_ROOM_MIN_PAGE_TILES = 25;
export const LARGE_ROOM_MAX_PAGE_TILES = 36;

export const DEFAULT_SCALE: ScaleConfig = {
  mediaMode: 'mesh',
  maxParticipants: LARGE_ROOM_MAX_PARTICIPANTS,
  maxVideoSubscriptions: LARGE_ROOM_MAX_VIDEO_SUBSCRIPTIONS,
  signaling: {
    nodeId: 'node-1',
    redisUrl: '',
    pubsubChannel: 'agil:signaling',
    stickySessions: false,
    nodes: [],
  },
  sfu: {
    provider: 'livekit',
    url: '',
    apiKeyEnv: 'AGIL_SFU_API_KEY',
    apiSecretEnv: 'AGIL_SFU_API_SECRET',
    region: '',
    maxParticipants: 5000,
    capacityProfile: DEFAULT_SFU_CAPACITY_PROFILE,
  },
  turn: [],
  loadBalancer: {
    strategy: 'round-robin',
    healthPath: '/v1/health',
    stickyCookie: 'agil_node',
  },
  webinar: {
    enabled: false,
    hostOnlyPublish: true,
    viewerLimit: 10000,
    chatMode: 'moderated',
    reactions: true,
    raiseHandQueue: true,
  },
  streaming: {
    enabled: false,
    provider: 'none',
    rtmpUrl: '',
    hlsUrl: '',
    playbackProtocol: 'hls',
    whepUrl: '',
    latencyMode: 'low',
  },
  cdn: {
    enabled: false,
    baseUrl: '',
    provider: '',
  },
  sip: defaultSipConfig(),
};

/** Resolves the effective media mode for a room (broadcast wins for webinars). */
export function effectiveMediaMode(scale: ScaleConfig, roomMode?: 'direct' | 'group'): MediaMode {
  if (scale.webinar.enabled && scale.mediaMode !== 'mesh') return 'broadcast';
  if (roomMode === 'direct') return scale.mediaMode === 'sfu' ? 'sfu' : 'mesh';
  return scale.mediaMode;
}

/** Builds the ICE server list advertised in `welcome` from the TURN pool + STUN. */
export function iceServersFromScale(
  scale: ScaleConfig,
  extraStun: string[] = ['stun:stun.l.google.com:19302'],
  resolveCredential: (envName: string) => string | undefined = () => undefined,
  issueRestCredential?: (turn: TurnServerConfig) => { username: string; credential: string } | undefined,
): Array<{ urls: string | string[]; username?: string; credential?: string }> {
  const servers: Array<{ urls: string | string[]; username?: string; credential?: string }> = extraStun.map((urls) => ({ urls }));
  for (const turn of scale.turn) {
    const urls = turn.urls.length === 1 ? (turn.urls[0] ?? '') : turn.urls;
    if (turn.credentialMode === 'rest') {
      const credentials = issueRestCredential?.(turn);
      if (credentials) servers.push({ urls, ...credentials });
      continue;
    }
    const credential = resolveCredential(turn.credentialEnv);
    servers.push({
      urls,
      username: turn.username || undefined,
      credential: credential || undefined,
    });
  }
  return servers;
}
