/**
 * Public types of `@agil/calls-embed`.
 *
 * The shapes mirror the hosted `/embed.html` postMessage contract
 * (`agil/core/docs/contract.md` §7) so events can be forwarded to hosts with minimal
 * translation. They are intentionally framework-agnostic: no React/Vue types,
 * no DOM-only types in the data model.
 */
import type { ConnectionUpdate, ParticipantUpdate } from './large-room.js';

/** Large-room limits; `maxParticipants` defaults to the 200-participant profile. */
export interface AgilLimits {
  /** 2..200; values outside the range are clamped to 200. */
  maxParticipants?: number;
}

/** Theme scheme understood by `/embed.html` (`?theme=`). */
export type AgilThemeScheme = 'light' | 'dark' | 'auto';

/** UI locale; `embed.html` currently localizes `ru` and `en`. */
export type AgilLanguage = 'ru' | 'en' | (string & {});

/** Role used by the widget for anonymous (token-less) joins (`role=`). */
export type AgilRole = 'host' | 'moderator' | 'guest';

/** Partial theme patch accepted by the widget through `agil:theme`. */
export interface AgilThemePatch {
  scheme?: AgilThemeScheme;
  [key: string]: unknown;
}

/** A theme can be a scheme shortcut or a full/partial theme patch. */
export type AgilThemeSetting = AgilThemeScheme | AgilThemePatch;

/** Capabilities reported by the widget in `agil:ready`. */
export interface AgilCapabilities {
  media: boolean;
  blur: boolean;
  screenShare: boolean;
  captions: boolean;
  recording: boolean;
  videoUpgrade?: boolean;
}

/** Chat message shape emitted by `embed.html` (`agil:chat`). */
export interface AgilChatMessage {
  text: string;
  id?: string;
  participantId?: string;
  participantName?: string;
  ts?: number;
  [key: string]: unknown;
}

/** Snapshot periodically posted by `embed.html` (`agil:state`). */
export interface AgilCallState {
  phase?: string;
  audioOnly?: boolean;
  videoUpgrade?: { requestId: string; participantId: string; direction: 'incoming' | 'outgoing' } | null;
  participants?: number;
  /**
   * Removed by the Stage 3b large-room digest: `agil-state` never carries the
   * full array (use `agil-participants`). Declared `never` so TypeScript hosts
   * that still read or assign it get a compile error.
   */
  participantIds?: never;
  /** Authoritative participant count (large-room digest). */
  participantCount?: number;
  /** Monotonic revision of the participant digest. */
  participantRevision?: number;
  reconnect?: { attempt?: number; delayMs?: number; since?: number };
  quality?: { tier?: string; score?: number };
  connectionState?: string;
  /** The current participant is recording locally. */
  recording?: boolean;
  /** Another participant in the call is recording. */
  remoteRecording?: boolean;
  minimized?: boolean;
  chatMode?: string;
  fullscreen?: boolean;
  layoutMode?: string;
  settings?: {
    mic?: boolean;
    camera?: boolean;
    screen?: boolean;
    blur?: string;
    panel?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Error codes emitted by the element (`agil-error` detail). */
export type AgilCallErrorCode =
  | 'invalid-config'
  | 'missing-room'
  | 'load-timeout'
  | 'bridge-timeout'
  | 'bridge-error'
  | 'iframe-error'
  | 'widget-error'
  | 'action-denied'
  | 'destroyed';

/**
 * Safe error detail. `message` is always redacted (tokens/URL secrets are
 * removed) and `code` is a stable identifier suitable for analytics.
 */
export interface AgilCallErrorDetail {
  code: AgilCallErrorCode;
  message: string;
  fatal: boolean;
  /** Original widget error code, when the iframe reported one. */
  widgetCode?: string;
}

/** Detail of the `agil-ready` event. */
export interface AgilReadyDetail {
  capabilities: AgilCapabilities;
  room?: string;
}

/** Detail of `agil-joined` / `agil-left`. */
export interface AgilLifecycleDetail {
  payload?: unknown;
}

/** Detail of `agil-chat`. */
export interface AgilChatDetail {
  message: AgilChatMessage;
}

/** Detail of `agil-state`. */
export interface AgilCallStateDetail {
  state: AgilCallState;
}

/** Detail of `agil-participants`: one compact snapshot/delta (never 200 ids/tick). */
export interface AgilParticipantsDetail {
  participants: ParticipantUpdate;
}

/** Detail of `agil-connection`: deduplicated connection/reconnect transition. */
export interface AgilConnectionDetail {
  connection: ConnectionUpdate;
}

/** Detail of `agil-minimized`; mirrors the mobile SDKs' `{ minimized }`. */
export interface AgilMinimizedDetail {
  minimized: boolean;
}

/** Detail of `agil-fullscreen`; mirrors the mobile SDKs' `{ fullscreen }`. */
export interface AgilFullscreenDetail {
  fullscreen: boolean;
}

/**
 * @deprecated Use {@link AgilMinimizedDetail} / {@link AgilFullscreenDetail}.
 * The old shared `{ value }` shape is no longer emitted.
 */
export type AgilToggleDetail = AgilMinimizedDetail | AgilFullscreenDetail;

/** Detail of a forwarded generic `agil:event` (participant/quality/connection/…). */
export interface AgilGenericEventDetail {
  /** Widget event name, e.g. `participant-joined`, `quality-changed`. */
  name: string;
  payload?: unknown;
}

/** Options accepted by the standalone URL builder. */
export interface BuildEmbedUrlOptions {
  /** AgilFrame server, e.g. `https://calls.example.com` (http/https only). */
  serverUrl?: string;
  /** Widget page path, default `embed.html` relative to the server path. */
  widgetPath?: string;
  room: string;
  audioOnly?: boolean;
  token?: string;
  /** Corporate OIDC token passed as `identity_token`. */
  identityToken?: string;
  /** Role for anonymous joins (`role=`). */
  role?: AgilRole;
  tenant?: string;
  name?: string;
  theme?: AgilThemeScheme;
  language?: string;
  relayOnly?: boolean;
  /** Allow a non-loopback `http://` server URL. Development only. */
  allowInsecure?: boolean;
}

/** Result of {@link buildEmbedUrl}. */
export interface EmbedTarget {
  /** Absolute iframe URL (contains the token, per the embed contract). */
  url: string;
  /** Canonical `scheme://host[:port]` of `url` — the only allowed targetOrigin. */
  origin: string;
  /** Normalized server URL without a trailing slash. */
  serverUrl: string;
}

/** Public lifecycle status of an `<agil-call>` element. */
export type AgilCallStatus =
  | 'idle'
  | 'loading'
  | 'connected'
  | 'joined'
  | 'left'
  | 'error'
  | 'destroyed';

/** Detail of `agil-error`. */
export interface AgilCallEventDetailMap {
  'agil-ready': AgilReadyDetail;
  'agil-joined': AgilLifecycleDetail;
  'agil-left': AgilLifecycleDetail;
  'agil-chat': AgilChatDetail;
  'agil-state': AgilCallStateDetail;
  'agil-participants': AgilParticipantsDetail;
  'agil-connection': AgilConnectionDetail;
  'agil-minimized': AgilMinimizedDetail;
  'agil-fullscreen': AgilFullscreenDetail;
  'agil-event': AgilGenericEventDetail;
  'agil-error': AgilCallErrorDetail;
}
