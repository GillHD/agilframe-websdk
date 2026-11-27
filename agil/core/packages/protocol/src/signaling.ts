/**
 * Signaling protocol for AgilFrame.
 *
 * Transport: one WebSocket per participant (`/ws`). The server relays SDP/ICE
 * between peers (mesh topology), keeps presence, and stores room chat history.
 *
 * The chat is not tied to media: it flows over the signaling socket and stays
 * available when the media path degrades. A WebRTC data channel may duplicate
 * it for latency, never replace it.
 */
import { z } from 'zod';
import { tenantConfigSchema } from './config.js';
import { mediaModeSchema } from './scaling.js';
import {
  MAX_ANNOTATION_POINTS_PER_STROKE,
  MAX_WHITEBOARD_CLOSE_REASON,
  MAX_WHITEBOARD_POINTS_PER_STROKE,
  WHITEBOARD_MAX_WIDTH,
  WHITEBOARD_MIN_WIDTH,
  whiteboardColorSchema,
  whiteboardPointSchema,
  whiteboardToolSchema,
  type AnnotationSnapshot,
  type AnnotationStroke,
  type WhiteboardAuthor,
  type WhiteboardSnapshot,
  type WhiteboardStroke,
  type WhiteboardSyncReason,
} from './whiteboard.js';

export type Role = 'host' | 'moderator' | 'guest';
export const roleSchema = z.enum(['host', 'moderator', 'guest']);

export type MediaState = 'on' | 'off';
export const mediaStateSchema = z.enum(['on', 'off']);

export interface ParticipantState {
  mic: MediaState;
  cam: MediaState;
  screen: boolean;
  handRaised: boolean;
  network: 'good' | 'fair' | 'poor';
  /**
   * The participant's local recorder is running. Broadcast as a partial
   * `state` message so every client can show a persistent recording indicator;
   * `undefined`/`false` means not recording.
   */
  recording?: boolean;
  /**
   * Recording start on the recorder's clock (ms). Lets a guest that joined
   * later render an accurate timer. `null` clears it on stop.
   */
  recordingStartedAt?: number | null;
}

export const participantStateSchema = z.object({
  mic: mediaStateSchema,
  cam: mediaStateSchema,
  screen: z.boolean(),
  handRaised: z.boolean(),
  network: z.enum(['good', 'fair', 'poor']),
  recording: z.boolean().optional(),
  recordingStartedAt: z.number().int().nonnegative().nullable().optional(),
});

/** Authenticity / anti-deepfake signal shown next to a participant. */
export type ParticipantIntegrity = 'unknown' | 'verified' | 'suspicious';
export const participantIntegritySchema = z.enum(['unknown', 'verified', 'suspicious']);

/**
 * Location of a participant.
 *
 * Never an exact position: media/ICE does not provide one (masked candidates,
 * TURN relays hide the path). The available signals are the WebSocket
 * connection IP, an optional consent-based browser Geolocation fix, and a
 * TURN-relay heuristic. The source and a `vpnSuspected` flag are exposed; only
 * moderators/dashboard see the details.
 */
export interface ParticipantLocation {
  /** ISO-3166 alpha-2. */
  country?: string;
  city?: string;
  source: 'ip' | 'gps' | 'none';
  vpnSuspected?: boolean;
  /** GPS accuracy in meters (only for source 'gps'). */
  accuracyM?: number;
}

export const participantLocationSchema = z.object({
  country: z.string().length(2).optional(),
  city: z.string().max(120).optional(),
  source: z.enum(['ip', 'gps', 'none']),
  vpnSuspected: z.boolean().optional(),
  accuracyM: z.number().min(0).max(100000).optional(),
});

export interface Participant {
  id: string;
  name: string;
  role: Role;
  joinedAt: number;
  state: ParticipantState;
  /** ISO-3166 alpha-2 country resolved from the connection IP (server-side). */
  country?: string;
  /** Identity was asserted by a trusted issuer (corporate SSO / signed token). */
  verified: boolean;
  /** Liveness / deepfake heuristics verdict. */
  integrity: ParticipantIntegrity;
  /** Effective feature permissions resolved server-side (see access.ts). */
  permissions?: string[];
  /** Display name of a company-defined custom role (if issued with roleId). */
  roleName?: string;
  /** Location details (moderators/dashboard only; not broadcast to everyone). */
  location?: ParticipantLocation;
  /**
   * Live presence. Absent means `online`; `reconnecting` is set while the
   * server holds a resume-grace lease after a socket drop (docs/call-continuity.md).
   */
  presence?: 'online' | 'reconnecting';
}

export const participantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  role: roleSchema,
  joinedAt: z.number(),
  state: participantStateSchema,
  country: z.string().length(2).optional(),
  verified: z.boolean(),
  integrity: participantIntegritySchema,
  permissions: z.array(z.string()).optional(),
  roleName: z.string().max(80).optional(),
  location: participantLocationSchema.optional(),
  presence: z.enum(['online', 'reconnecting']).optional(),
});

export type RoomMode = 'direct' | 'group';

/**
 * Explicit media transport for a **direct** (1:1) room.
 *
 * - `p2p` — browser-to-browser WebRTC (room `mediaMode:'mesh'`, exactly 2 seats,
 *   no server media; see `docs/p2p.md`);
 * - `sfu` — the tenant's existing SFU media plane (current behaviour: a direct
 *   room uses SFU when the tenant is configured for it);
 * - omitted — current behaviour, identical to `sfu`.
 *
 * Rejected for `mode:'group'`: group calls always follow `scale.mediaMode`.
 */
export const roomTransportSchema = z.enum(['p2p', 'sfu']);
export type RoomTransport = z.infer<typeof roomTransportSchema>;

/**
 * Messenger context: handy for calls started from a corporate chat.
 * For a 1:1 call the room is `mode:'direct'` with `maxParticipants:2`.
 */
export interface RoomContext {
  /** free-form: telegram | slack | teams | matrix | corp-messenger */
  messenger?: string;
  conversationId?: string;
  /** Participant id of the other side for direct calls (optional). */
  directPeerId?: string;
  title?: string;
}

export const roomContextSchema = z.object({
  messenger: z.string().max(64).optional(),
  conversationId: z.string().max(128).optional(),
  directPeerId: z.string().max(64).optional(),
  title: z.string().max(120).optional(),
});

export interface RoomInfo {
  id: string;
  tenantId: string;
  name: string;
  createdAt: number;
  locked: boolean;
  /** 'direct' = 1:1 call from a messenger chat, 'group' = group conversation. */
  mode?: RoomMode;
  context?: RoomContext;
  /** Effective media plane for this room (mesh/sfu/broadcast). */
  mediaMode?: 'mesh' | 'sfu' | 'broadcast';
  /** Per-room participant cap (thousands for webinars/streams). */
  maxParticipants?: number;
  /**
   * True while the room's SFU node is draining. The room stays joinable: new
   * and returning participants are admitted, only new allocations are stopped
   * (docs/call-continuity.md).
   */
  draining?: boolean;
  /** SFU node this room is pinned to (persisted room snapshot; diagnostics). */
  sfuNodeId?: string;
}

export const roomInfoSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  name: z.string().max(120),
  createdAt: z.number(),
  locked: z.boolean(),
  mode: z.enum(['direct', 'group']).optional(),
  context: roomContextSchema.optional(),
  mediaMode: mediaModeSchema.optional(),
  maxParticipants: z.number().int().min(2).max(50000).optional(),
  draining: z.boolean().optional(),
  sfuNodeId: z.string().max(64).optional(),
});

export interface ChatAttachment {
  name: string;
  size: number;
  mime: string;
  url: string;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  from: { id: string; name: string; role: Role };
  text: string;
  ts: number;
  kind: 'text' | 'system' | 'file';
  attachment?: ChatAttachment;
}

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  roomId: z.string().min(1),
  from: z.object({ id: z.string().min(1), name: z.string().max(120), role: roleSchema }),
  text: z.string().max(4000),
  ts: z.number(),
  kind: z.enum(['text', 'system', 'file']),
  attachment: z
    .object({ name: z.string(), size: z.number(), mime: z.string(), url: z.string() })
    .optional(),
});

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export interface SdpDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

export const sdpDescriptionSchema = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().min(1),
});

export interface IceCandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export const iceCandidateSchema = z.object({
  candidate: z.string(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Client -> server                                                    */
/* ------------------------------------------------------------------ */

export const VIDEO_UPGRADE_TTL_MS = 30_000;
const videoUpgradeAction = z.enum(['request', 'accept', 'decline']);

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), name: z.string().min(1).max(120).optional(), locale: z.enum(['ru', 'en']).optional() }),
  z.object({ type: z.literal('sdp'), to: z.string().min(1), description: sdpDescriptionSchema }),
  z.object({ type: z.literal('ice'), to: z.string().min(1), candidate: iceCandidateSchema }),
  z.object({ type: z.literal('video-upgrade'), to: z.string().min(1).max(128),
    requestId: z.string().uuid(), action: videoUpgradeAction }),
  z.object({
    type: z.literal('chat'),
    id: z.string().min(1).max(64),
    acknowledge: z.boolean().optional(),
    text: z.string().min(1).max(4000),
    attachment: z
      .object({ name: z.string().max(255), size: z.number().min(0), mime: z.string().max(128), url: z.string().max(2048) })
      .optional(),
  }),
  z.object({ type: z.literal('state'), state: participantStateSchema.partial() }),
  z.object({ type: z.literal('conversation-review.consent'), revision: z.string().uuid(), allowed: z.boolean() }),
  z.object({ type: z.literal('reaction'), emoji: z.string().min(1).max(8), ts: z.number().optional() }),
  z.object({
    type: z.literal('caption'),
    text: z.string().min(1).max(2000),
    isFinal: z.boolean(),
    lang: z.enum(['ru', 'en']).optional(),
  }),
  z.object({
    type: z.literal('integrity'),
    status: participantIntegritySchema,
    score: z.number().min(0).max(1).optional(),
    flags: z.array(z.string()).max(20).optional(),
  }),
  z.object({ type: z.literal('ping'), ts: z.number(), refreshIce: z.boolean().optional(), refreshSfu: z.boolean().optional() }),
  z.object({ type: z.literal('bye') }),
  z.object({ type: z.literal('history'), limit: z.number().int().min(1).max(500).optional() }),
  z.object({ type: z.literal('analysis-request'), sinceTs: z.number().optional() }),
  z.object({
    type: z.literal('assistant-query'),
    id: z.string().min(1).max(64),
    question: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal('location'),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).max(100000).optional(),
    consent: z.literal(true),
  }),
  /* ---- whiteboard (optional, `features.whiteboard`) ---- */
  z.object({ type: z.literal('whiteboard.open') }),
  z.object({
    type: z.literal('whiteboard.close'),
    reason: z.string().max(MAX_WHITEBOARD_CLOSE_REASON).optional(),
  }),
  z.object({
    type: z.literal('whiteboard.stroke'),
    /** Client-generated id: the server dedupes retries and echoes it back. */
    id: z.string().min(1).max(64).optional(),
    tool: whiteboardToolSchema,
    color: whiteboardColorSchema.optional(),
    width: z.number().min(WHITEBOARD_MIN_WIDTH).max(WHITEBOARD_MAX_WIDTH).optional(),
    points: z.array(whiteboardPointSchema).max(MAX_WHITEBOARD_POINTS_PER_STROKE).optional(),
  }),
  /** Ask for a fresh room snapshot (reconnect / panel reopened). */
  z.object({ type: z.literal('whiteboard.sync') }),
  /* ---- screen-share annotations (optional, `features.annotations`) ---- */
  z.object({
    type: z.literal('annotation.stroke'),
    id: z.string().min(1).max(64).optional(),
    tool: z.enum(['pen', 'eraser']),
    color: whiteboardColorSchema.optional(),
    width: z.number().min(WHITEBOARD_MIN_WIDTH).max(WHITEBOARD_MAX_WIDTH).optional(),
    points: z.array(whiteboardPointSchema).min(1).max(MAX_ANNOTATION_POINTS_PER_STROKE),
  }),
  z.object({ type: z.literal('annotation.clear') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];

/* ------------------------------------------------------------------ */
/* Server -> client                                                    */
/* ------------------------------------------------------------------ */

export interface SfuMediaSession {
  mode: 'sfu';
  url: string;
  /** Shared ingress for the same LiveKit deployment and room. */
  fallbackUrl?: string;
  token: string;
  /** LiveKit room name (tenantId + roomId). */
  room: string;
  canPublish: boolean;
  expiresAt: number;
  /**
   * End-to-end encryption material for SFU media. The key is delivered only to
   * authorized room participants over TLS and never put in the LiveKit JWT.
   */
  e2ee?: {
    key: string;
    algorithm: 'AES-GCM';
    keyIndex: number;
  };
}

export interface WelcomeMessage {
  chatAcknowledgements?: true;
  type: 'welcome';
  self: Participant;
  room: RoomInfo;
  participants: Participant[];
  config: z.infer<typeof tenantConfigSchema>;
  iceServers: IceServerConfig[];
  serverTime: number;
  history: ChatMessage[];
  /** Present when the room runs on the SFU (LiveKit); absent for mesh. */
  media?: SfuMediaSession;
  /** Current whiteboard state (only when `features.whiteboard` is enabled). */
  whiteboard?: WhiteboardSnapshot;
  /** Current screen-share annotations (only when `features.annotations` is enabled). */
  annotations?: AnnotationSnapshot;
  /**
   * True when this socket resumed an existing participant instead of joining:
   * peers were not re-announced and the room state (join time, media state) was
   * kept (docs/call-continuity.md).
   */
  resumed?: boolean;
  /**
   * Short-lived resume capability for the next socket drop. The client offers
   * it back in the `Sec-WebSocket-Protocol` header, never in the URL; it is
   * never logged or persisted client-side beyond the session.
   */
  resume?: { token: string; expiresAt: number; graceSec: number };
}

export type ServerMessage =
  | { type: 'conversation-review'; revision: string | null; consent: 'pending' | 'allowed' | 'declined' }
  | WelcomeMessage
  | { type: 'peer-joined'; participant: Participant }
  | { type: 'peer-left'; participantId: string; reason?: string }
  /**
   * Presence transition without a leave/join: `reconnecting` while a resume
   * lease is held, `online` once the participant resumed.
   */
  | { type: 'presence'; participantId: string; presence: 'online' | 'reconnecting'; ts: number }
  | { type: 'sdp'; from: string; description: SdpDescription }
  | { type: 'ice'; from: string; candidate: IceCandidatePayload }
  | { type: 'video-upgrade'; from: string; requestId: string; action: z.infer<typeof videoUpgradeAction> }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'chat-result'; id: string; message: ChatMessage }
  | { type: 'chat-result'; id: string; error: 'unauthorized' | 'delivery_failed' }
  | { type: 'chat-history'; messages: ChatMessage[] }
  | { type: 'state'; participantId: string; state: Partial<ParticipantState> }
  | { type: 'reaction'; participantId: string; emoji: string; ts: number }
  | {
      type: 'caption';
      participantId: string;
      text: string;
      isFinal: boolean;
      ts: number;
      /** Stable server segment id (present when the segment was stored). */
      segmentId?: string;
      /** Machine translation of `text`, delivered in a follow-up frame. */
      translation?: string;
      translationLang?: 'ru' | 'en';
      translationProvider?: 'local' | 'llm' | 'stub';
      /** Marks a follow-up frame that only attaches a translation. */
      translated?: boolean;
    }
  | {
      type: 'integrity';
      participantId: string;
      status: ParticipantIntegrity;
      score?: number;
      flags: string[];
      ts: number;
    }
  | { type: 'room'; room: RoomInfo; participants: Participant[] }
  | {
      type: 'analysis';
      roomId: string;
      findings: import('./compliance.js').ComplianceFinding[];
      summary?: string;
      ts: number;
    }
  | {
      type: 'assistant-answer';
      id: string;
      answer: string;
      citations: import('./compliance.js').KnowledgeCitation[];
      confidence?: number;
      error?: string;
      ts: number;
    }
  | { type: 'location'; participantId: string; location: ParticipantLocation; ts: number }
  | { type: 'lobby.pending'; request: { id: string; name: string; country?: string; createdAt: number; expiresAt: number; status: 'pending' } }
  | { type: 'lobby.queue'; requests: Array<{ id: string; name: string; country?: string; createdAt: number; expiresAt: number; status: 'pending' }> }
  | { type: 'lobby.admitted'; requestId: string; participant: Participant }
  | { type: 'lobby.rejected'; requestId: string; reason?: string }
  | { type: 'poll.updated'; roomId: string; poll: import('./poll.js').RoomPoll; reason: 'created' | 'voted' | 'closed' }
  | { type: 'breakout.started'; plan: import('./breakout.js').BreakoutPlan }
  | { type: 'breakout.assigned'; assignment: import('./breakout.js').BreakoutAssignedMessage }
  | { type: 'breakout.closed'; plan: import('./breakout.js').BreakoutPlan }
  | {
      type: 'whiteboard.open';
      roomId: string;
      by: WhiteboardAuthor;
      ts: number;
    }
  | {
      type: 'whiteboard.close';
      roomId: string;
      by: WhiteboardAuthor;
      reason: string;
      ts: number;
    }
  | {
      type: 'whiteboard.sync';
      roomId: string;
      snapshot: WhiteboardSnapshot;
      reason: WhiteboardSyncReason;
      ts: number;
    }
  | {
      type: 'whiteboard.stroke';
      roomId: string;
      stroke: WhiteboardStroke;
      revision: number;
      ts: number;
      /** True when older strokes were evicted to stay inside the room limits. */
      trimmed?: boolean;
    }
  | { type: 'annotation.sync'; roomId: string; snapshot: AnnotationSnapshot; ts: number }
  | {
      type: 'annotation.stroke';
      roomId: string;
      stroke: AnnotationStroke;
      revision: number;
      ts: number;
      trimmed?: boolean;
    }
  | {
      type: 'annotation.clear';
      roomId: string;
      by?: WhiteboardAuthor;
      presenterId: string | null;
      reason: import('./whiteboard.js').AnnotationClearReason;
      ts: number;
    }
  | { type: 'config'; config: z.infer<typeof tenantConfigSchema> }
  | { type: 'error'; code: ServerErrorCode; message: string; fatal?: boolean }
  | { type: 'pong'; ts: number; iceServers?: IceServerConfig[]; sfuMedia?: SfuMediaSession | null }
  | { type: 'bye'; reason: string };

export type ServerErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'room_full'
  | 'room_locked'
  | 'unknown_peer'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'consent_required'
  | 'chat_storage_unavailable'
  | 'internal_error';

/** Encodes a server message as a compact JSON string. */
export function encodeMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

/** Parses an incoming client frame; never throws. */
export function parseClientMessage(raw: string): { ok: true; message: ClientMessage } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  const result = clientMessageSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
  }
  return { ok: true, message: result.data };
}

export const PROTOCOL_VERSION = 1;
