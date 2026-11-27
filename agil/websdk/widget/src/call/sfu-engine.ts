/**
 * SFU media engine (LiveKit) — the P0 path for calls with 50+ participants.
 *
 * The signaling WebSocket stays the control plane (presence, chat, state,
 * captions, assistant, polls, lobby, breakout). This engine only owns the media
 * plane:
 *
 *  - `room.connect(url, token)` with a short-lived join token issued by the
 *    backend (`WelcomeMessage.media` / `JoinRoomResponse.media`);
 *  - publish the local camera/mic/screen tracks (respecting the widget state);
 *  - subscribe remote audio/video and expose one `MediaStream` per participant
 *    identity (`identity === AGIL participantId`, enforced by the server token);
 *  - connection quality via LiveKit `ConnectionQuality` + per-track `getStats`.
 *
 * `livekit-client` is loaded with a dynamic `import()` so mesh-only rooms never
 * pay for it during the initial widget load (Vite emits it as a separate chunk).
 *
 * Security: the LiveKit token lives only in this class. It is never put into the
 * DOM, never put into the observable state and never logged — error messages are
 * scrubbed before they reach `console`/toasts.
 */
import { evaluateQuality, type QualityDecision, type QualitySnapshot, type QualityTier, type SfuMediaSession, type TenantConfig } from '@agil/protocol';
import { selectedVideoCodec } from './encoding.js';
import {
  clampVideoSubscriptions,
  configuredVideoSubscriptionLimit,
  normalizeVideoQuality,
  videoQualityDimensions,
  type VideoQualityPreference,
} from './large-room.js';
import E2EEWorker from 'livekit-client/e2ee-worker?worker';
import type {
  DisconnectReason,
  LocalTrackPublication,
  Participant as LiveKitParticipant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room as LiveKitRoom,
  Track as LiveKitTrack,
} from 'livekit-client';

type LiveKitModule = typeof import('livekit-client');

let liveKitModule: LiveKitModule | null = null;

/** Dynamic import; cached so a fallback → retry cycle does not re-download the chunk. */
async function loadLiveKit(): Promise<LiveKitModule> {
  if (!liveKitModule) liveKitModule = await import('livekit-client');
  return liveKitModule;
}

export type SfuErrorCode =
  | 'unsupported'
  | 'invalid_session'
  | 'token_expired'
  | 'connect_failed'
  | 'e2ee_failed'
  | 'publish_failed'
  | 'not_connected'
  | 'disconnected';

/** Normalized SFU failure. The message never contains the access token. */
export class SfuError extends Error {
  readonly code: SfuErrorCode;

  constructor(code: SfuErrorCode, message: string) {
    super(message);
    this.name = 'SfuError';
    this.code = code;
  }
}

export type SfuConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export interface SfuParticipantState {
  mic: 'on' | 'off';
  cam: 'on' | 'off';
  screen: boolean;
}

export interface SfuEngineCallbacks {
  /** Stream composed from the local tracks that are currently published. */
  onLocalStream: (stream: MediaStream) => void;
  onRemoteStream: (participantId: string, stream: MediaStream) => void;
  onRemoteStreamRemoved: (participantId: string) => void;
  onParticipantJoined: (participantId: string, name: string | undefined) => void;
  onParticipantLeft: (participantId: string) => void;
  onParticipantState: (participantId: string, state: SfuParticipantState) => void;
  onSpeaking: (participantId: string, speaking: boolean) => void;
  onActiveSpeaker?: (participantId: string) => void;
  onConnectionState: (state: SfuConnectionState) => void;
  onQuality: (decision: QualityDecision, snapshot: QualitySnapshot) => void;
  /** Fatal: the caller decides between mesh fallback, retry or an error state. */
  onDisconnected: (reason: string, error?: SfuError) => void;
  onE2EE?: (status: 'enabling' | 'enabled' | 'failed', detail?: { keyIndex?: number; error?: string }) => void;
  onError: (error: SfuError) => void;
}

export interface SfuEngineOptions {
  session: SfuMediaSession;
  selfId: string;
  config: TenantConfig;
  callbacks: SfuEngineCallbacks;
  /** Initial local tracks (already acquired by `MediaController`). */
  audioTrack?: MediaStreamTrack | null;
  videoTrack?: MediaStreamTrack | null;
  screenTrack?: MediaStreamTrack | null;
  screenAudioTrack?: MediaStreamTrack | null;
  videoOverride?: MediaStreamTrack | null;
  micEnabled: boolean;
  camEnabled: boolean;
  /** Hard cap for remote video subscriptions (`scale.maxVideoSubscriptions`). */
  maxVideoSubscriptions?: number;
  registerAudioOutput?: (element: HTMLMediaElement) => () => void;
}

export interface SfuAggregateStats {
  snapshot: QualitySnapshot;
  outboundBitrateKbps: number;
  peers: number;
  iceRestarts: number;
}

/**
 * Which remote videos the client should receive right now. Audio is always
 * subscribed for every participant — only video is budgeted.
 */
export interface SfuVideoSubscriptionPolicy {
  /** Participants rendered on the current gallery page. */
  visibleIds: readonly string[];
  /** Pinned participant (always allowed to keep its video). */
  pinnedId?: string | null;
  /** Active speaker, when speaker-follow is enabled. */
  speakerId?: string | null;
  /** Overrides `scale.maxVideoSubscriptions` (never above the configured cap). */
  maxSubscriptions?: number;
  /** Pace ordinary video requests on large galleries. */
  pace?: boolean;
  /** Explicitly requested videos that should start immediately. */
  immediateVideoIds?: readonly string[];
  /** Actual mounted tile dimensions in CSS pixels for automatic quality. */
  tileDimensions?: ReadonlyMap<string, { width: number; height: number }>;
}

export interface SfuSubscriptionStats {
  videoSubscribed: number;
  videoEnabled: number;
  audioSubscribed: number;
  desiredVideo: number;
  maxVideoSubscriptions: number;
  quality: VideoQualityPreference;
}

interface TrackBaseline {
  bytesReceived: number;
  bytesSent: number;
  packetsLost: number;
  packetsReceived: number;
}

interface RemoteTrackEntry {
  track: RemoteTrack;
  publication: RemoteTrackPublication;
  source: string;
  kind: string;
}

const STATS_INTERVAL_MS = 2000;
const VIDEO_SUBSCRIPTION_INTERVAL_MS = 150;

interface InboundStatsLike extends RTCStats {
  kind?: string;
  bytesReceived?: number;
  packetsLost?: number;
  packetsReceived?: number;
  jitter?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
}

interface OutboundStatsLike extends RTCStats {
  bytesSent?: number;
  packetsSent?: number;
}

interface RemoteInboundStatsLike extends RTCStats {
  roundTripTime?: number;
  jitter?: number;
  packetsLost?: number;
}

interface CandidatePairStatsLike extends RTCStats {
  nominated?: boolean;
  state?: string;
  currentRoundTripTime?: number;
  availableOutgoingBitrate?: number;
}

/**
 * One SFU room. The signaling client keeps running independently: the widget
 * only needs this engine for media tracks.
 */
export class SfuEngine {
  private readonly session: SfuMediaSession;
  private selfId: string;
  private config: TenantConfig;
  private readonly callbacks: SfuEngineCallbacks;
  private readonly browserSupported: boolean;
  private room: LiveKitRoom | null = null;
  private module: LiveKitModule | null = null;
  private connectionState: SfuConnectionState = 'idle';
  private closing = false;
  private disposed = false;
  private connected = false;

  private audioTrack: MediaStreamTrack | null;
  private videoTrack: MediaStreamTrack | null;
  private screenTrack: MediaStreamTrack | null;
  private screenAudioTrack: MediaStreamTrack | null;
  private videoOverride: MediaStreamTrack | null;
  private micEnabled: boolean;
  private camEnabled: boolean;

  private audioPublication: LocalTrackPublication | null = null;
  private videoPublication: LocalTrackPublication | null = null;
  private screenPublication: LocalTrackPublication | null = null;
  private screenAudioPublication: LocalTrackPublication | null = null;
  private readonly publishQueue: Promise<void>[] = [];

  private readonly streams = new Map<string, MediaStream>();
  private readonly remoteTracks = new Map<string, RemoteTrackEntry[]>();
  /** Hidden audio elements: remote audio must play even when its tile is virtualized out. */
  private readonly audioElements = new Map<string, { element: HTMLAudioElement; release?: () => void }>();
  private readonly registerAudioOutput?: (element: HTMLMediaElement) => () => void;
  private readonly knownParticipants = new Set<string>();
  private speakingParticipants = new Set<string>();
  private activeSpeaker: string | undefined;
  /**
   * Large rooms: never keep 200 video subscriptions. The controller updates
   * this policy whenever the page/pin/speaker changes; audio stays subscribed.
   */
  private visibleVideoIds = new Set<string>();
  private pinnedVideoId: string | null = null;
  private activeSpeakerId: string | null = null;
  /** `scale.maxVideoSubscriptions` — the ceiling a policy can never exceed. */
  private configuredMaxVideoSubscriptions: number;
  /** Effective budget of the current page/pin/speaker plan. */
  private maxVideoSubscriptions: number;
  private qualityPreference: VideoQualityPreference = 'auto';
  /** Serialises the async stats/quality re-application; policy calls are sync. */
  private applyingSubscriptions = false;
  private paceVideoSubscriptions = false;
  private tileDimensions: SfuVideoSubscriptionPolicy['tileDimensions'];
  private immediateVideoIds = new Set<string>();
  private videoSubscriptionTimer: ReturnType<typeof setTimeout> | null = null;
  private nextVideoSubscriptionAt = 0;

  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastTier: QualityTier | undefined;
  private networkVideoLimit: 'low' | 'very-low' | 'off' | null = null;
  private lastStatsAt = 0;
  private readonly baselines = new Map<string, TrackBaseline>();
  private lastReport: SfuAggregateStats = {
    snapshot: {
      rttMs: 0,
      packetLossPct: 0,
      jitterMs: 0,
      inboundBitrateKbps: 0,
      availableOutgoingBitrateKbps: 0,
      fps: 0,
      width: 0,
      height: 0,
    },
    outboundBitrateKbps: 0,
    peers: 0,
    iceRestarts: 0,
  };

  constructor(options: SfuEngineOptions) {
    this.session = options.session;
    this.selfId = options.selfId;
    this.config = options.config;
    this.callbacks = options.callbacks;
    this.registerAudioOutput = options.registerAudioOutput;
    this.audioTrack = options.audioTrack ?? null;
    this.videoTrack = options.videoTrack ?? null;
    this.screenTrack = options.screenTrack ?? null;
    this.screenAudioTrack = options.screenAudioTrack ?? null;
    this.videoOverride = options.videoOverride ?? null;
    this.micEnabled = options.micEnabled;
    this.camEnabled = options.camEnabled;
    const configuredLimit = configuredVideoSubscriptionLimit(this.config.limits.maxVideoSubscriptions, this.config.scale.maxVideoSubscriptions);
    this.configuredMaxVideoSubscriptions = Math.min(configuredLimit, clampVideoSubscriptions(options.maxVideoSubscriptions ?? configuredLimit));
    this.maxVideoSubscriptions = this.configuredMaxVideoSubscriptions;
    this.qualityPreference = 'auto';
    this.browserSupported = typeof window !== 'undefined' && typeof RTCPeerConnection !== 'undefined';
  }

  get state(): SfuConnectionState {
    return this.connectionState;
  }

  get isConnected(): boolean {
    return this.connected && Boolean(this.room);
  }

  get canPublish(): boolean {
    return this.session.canPublish;
  }

  get peersCount(): number {
    return this.room?.remoteParticipants.size ?? this.knownParticipants.size;
  }

  get participantIds(): string[] {
    return [...(this.room?.remoteParticipants.keys() ?? this.knownParticipants)];
  }

  get local(): MediaStream | null {
    return this.composeLocalStream();
  }

  setConfig(config: TenantConfig): void {
    this.config = config;
    if (!config.fallback.lowBandwidth.enabled) this.applyNetworkVideoLimit(null);
    this.setMaxVideoSubscriptions(configuredVideoSubscriptionLimit(config.limits.maxVideoSubscriptions, config.scale.maxVideoSubscriptions));
  }

  setSelfId(id: string): void {
    this.selfId = id;
  }

  /**
   * Updates the visible video set (gallery page + pinned/active speaker) and
   * applies it to LiveKit. Off-page video publications are unsubscribed; all
   * remote audio publications remain subscribed.
   */
  setVideoSubscriptionPolicy(policy: SfuVideoSubscriptionPolicy): void {
    const limit = Math.min(
      this.configuredMaxVideoSubscriptions,
      policy.maxSubscriptions === undefined
        ? this.configuredMaxVideoSubscriptions
        : clampVideoSubscriptions(policy.maxSubscriptions),
    );
    const ordered: string[] = [];
    const add = (id: string | null | undefined): void => {
      if (!id || id === this.selfId || ordered.includes(id)) return;
      ordered.push(id);
    };
    add(policy.pinnedId);
    add(policy.speakerId);
    for (const id of policy.visibleIds) add(id);
    this.visibleVideoIds = new Set(ordered.slice(0, limit));
    this.pinnedVideoId = policy.pinnedId ?? null;
    this.activeSpeakerId = policy.speakerId ?? null;
    this.maxVideoSubscriptions = limit;
    this.paceVideoSubscriptions = policy.pace ?? false;
    this.tileDimensions = policy.tileDimensions;
    this.immediateVideoIds = new Set(policy.immediateVideoIds);
    if (policy.pinnedId) this.immediateVideoIds.add(policy.pinnedId);
    if (policy.speakerId) this.immediateVideoIds.add(policy.speakerId);
    this.applyVideoSubscriptions();
  }

  /** Applies the effective room and scaling subscription ceiling. */
  setMaxVideoSubscriptions(value: unknown): void {
    this.configuredMaxVideoSubscriptions = clampVideoSubscriptions(value);
    if (this.visibleVideoIds.size > this.configuredMaxVideoSubscriptions) {
      this.visibleVideoIds = new Set([...this.visibleVideoIds].slice(0, this.configuredMaxVideoSubscriptions));
    }
    this.maxVideoSubscriptions = this.configuredMaxVideoSubscriptions;
    this.applyVideoSubscriptions();
  }

  /** Manual quality selector: `auto` uses adaptive tile dimensions. */
  setVideoQuality(quality: VideoQualityPreference): void {
    this.qualityPreference = normalizeVideoQuality(quality);
    this.applyVideoQuality();
  }

  get quality(): VideoQualityPreference {
    return this.qualityPreference;
  }

  get subscriptionStats(): SfuSubscriptionStats {
    const room = this.room;
    let videoSubscribed = 0;
    let videoEnabled = 0;
    let audioSubscribed = 0;
    for (const participant of room?.remoteParticipants.values() ?? []) {
      for (const publication of participant.videoTrackPublications.values()) {
        if (publication.isSubscribed) videoSubscribed += 1;
        if (publication.isEnabled) videoEnabled += 1;
      }
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.isSubscribed) audioSubscribed += 1;
      }
    }
    return {
      videoSubscribed,
      videoEnabled,
      audioSubscribed,
      desiredVideo: this.visibleVideoIds.size,
      maxVideoSubscriptions: this.configuredMaxVideoSubscriptions,
      quality: this.qualityPreference,
    };
  }

  /** Subscribes all remote audio; used after connect and for late publishers. */
  private subscribeParticipantAudio(participant: RemoteParticipant): void {
    if (participant.identity === this.selfId) return;
    for (const publication of participant.audioTrackPublications.values()) this.subscribePublication(publication);
  }

  private subscribePublication(publication: RemoteTrackPublication): void {
    try {
      if (!publication.isSubscribed) publication.setSubscribed(true);
      publication.setEnabled(true);
    } catch {
      /* the publication may be ended/replaced; the next event retries */
    }
  }

  private applyVideoSubscriptions(): void {
    const room = this.room;
    if (!room || this.closing || this.disposed || this.connectionState === 'disconnected' || this.applyingSubscriptions) return;
    this.clearVideoSubscriptionTimer();
    this.applyingSubscriptions = true;
    try {
      const selected = new Map<string, RemoteTrackPublication>();
      for (const participant of room.remoteParticipants.values()) {
        if (participant.identity === this.selfId) continue;
        const publications = [...participant.videoTrackPublications.values()];
        const chosen = this.visibleVideoIds.has(participant.identity) ? this.preferredVideoPublication(publications) : null;
        if (chosen) selected.set(participant.identity, chosen);
        for (const publication of publications) {
          if (publication !== chosen) this.disableVideoPublication(publication);
        }
      }

      // Release old subscriptions before issuing new requests, even during a
      // screen-share swap or when the new tiles precede the old tiles in the room map.
      let waiting = false;
      for (const id of this.visibleVideoIds) {
        const publication = selected.get(id);
        if (!publication) continue;
        const paced = this.paceVideoSubscriptions && !this.immediateVideoIds.has(id) && publication.source !== 'screen_share';
        const newSubscription = !publication.isDesired;
        if (paced && newSubscription && Date.now() < this.nextVideoSubscriptionAt) {
          waiting = true;
          continue;
        }
        try {
          if (newSubscription) {
            publication.setSubscribed(true);
            if (paced) this.nextVideoSubscriptionAt = Date.now() + VIDEO_SUBSCRIPTION_INTERVAL_MS;
          }
          if (!publication.isEnabled) publication.setEnabled(true);
          this.applyQualityToPublication(publication, id);
        } catch {
          /* transient tracks are retried on the next room update */
        }
      }
      if (waiting) {
        this.videoSubscriptionTimer = setTimeout(
          () => this.applyVideoSubscriptions(),
          Math.max(0, this.nextVideoSubscriptionAt - Date.now()),
        );
      }
    } finally {
      this.applyingSubscriptions = false;
    }
  }

  private clearVideoSubscriptionTimer(): void {
    if (this.videoSubscriptionTimer === null) return;
    clearTimeout(this.videoSubscriptionTimer);
    this.videoSubscriptionTimer = null;
  }

  /**
   * An unmuted screen share wins over the camera; otherwise an unmuted camera,
   * then any live publication. A muted screen must not hide a live camera.
   */
  private preferredVideoPublication(publications: RemoteTrackPublication[]): RemoteTrackPublication | null {
    const live = publications.filter((publication) => !publication.isMuted);
    const screen = live.find((publication) => publication.source === 'screen_share');
    if (screen) return screen;
    if (this.networkVideoLimit === 'off') return null;
    const camera = live.find((publication) => publication.source === 'camera');
    // No live video: keep nothing subscribed; TrackUnmuted will re-apply.
    return camera ?? live[0] ?? null;
  }

  private disableVideoPublication(publication: RemoteTrackPublication): void {
    try {
      // Stop downlink first, then release the server-side subscription so a
      // 200-person room never holds off-page video streams open.
      if (publication.isEnabled) publication.setEnabled(false);
      if (publication.isDesired) publication.setSubscribed(false);
    } catch {
      /* the publication may be ended/replaced */
    }
  }

  private applyVideoQuality(): void {
    const room = this.room;
    if (!room) return;
    for (const participant of room.remoteParticipants.values()) {
      if (!this.visibleVideoIds.has(participant.identity)) continue;
      for (const publication of participant.videoTrackPublications.values()) {
        if (!publication.isSubscribed) continue;
        this.applyQualityToPublication(publication, participant.identity);
      }
    }
  }

  private applyNetworkVideoLimit(limit: typeof this.networkVideoLimit): void {
    const wasCameraSuspended = this.networkVideoLimit === 'off';
    if (limit === this.networkVideoLimit) return;
    this.networkVideoLimit = limit;
    if (wasCameraSuspended === (limit === 'off')) {
      this.applyVideoQuality();
      return;
    }
    this.applyVideoSubscriptions();
    void this.enqueue(async () => {
      if (!this.isConnected || !this.canPublish) return;
      const camera = this.effectiveVideoTrack();
      if (this.camEnabled && camera?.readyState === 'live') await this.publishVideo(camera);
      else await this.unpublishVideo();
    });
  }

  private applyQualityToPublication(publication: RemoteTrackPublication, participantId: string): void {
    const role = participantId === this.pinnedVideoId || participantId === this.activeSpeakerId ? 'spotlight' : 'grid';
    try {
      const module = this.module;
      if (this.networkVideoLimit === 'very-low' || this.qualityPreference === 'low') {
        if (module) publication.setVideoQuality(module.VideoQuality.LOW);
        return;
      }
      if (this.qualityPreference === 'auto' || this.networkVideoLimit === 'low') {
        // Video is rendered from MediaStreams, so supply the tile measurement
        // explicitly instead of relying on LiveKit Track.attach observers.
        const source = publication.dimensions;
        const aspect = source && source.width > 0 && source.height > 0 ? source.width / source.height : 16 / 9;
        const fallback = videoQualityDimensions('auto', role);
        const tile = (this.qualityPreference === 'auto' && this.tileDimensions?.get(participantId)) || fallback;
        if (!tile) return;
        let { width, height } = tile;
        if (this.networkVideoLimit === 'low') {
          width = Math.min(width, aspect >= 1 ? 320 : 180);
          height = Math.min(height, aspect >= 1 ? 180 : 320);
        }
        publication.setVideoDimensions({
          width: Math.max(1, Math.round(Math.min(width, height * aspect))),
          height: Math.max(1, Math.round(Math.min(height, width / aspect))),
        });
        return;
      }
      if (!module) return;
      const quality = this.qualityPreference === 'high' ? module.VideoQuality.HIGH : module.VideoQuality.MEDIUM;
      publication.setVideoQuality(quality);
    } catch {
      /* quality preferences are best-effort */
    }
  }

  /**
   * Connects to LiveKit and publishes the initial local tracks. Rejects with a
   * scrubbed `SfuError`; callers fall back to mesh or show a retry banner.
   */
  async connect(): Promise<void> {
    if (this.disposed) throw new SfuError('disconnected', 'SFU engine disposed');
    if (!this.browserSupported) throw new SfuError('unsupported', 'WebRTC is not supported by this browser');
    if (!this.session.url || !this.session.token) {
      throw new SfuError('invalid_session', 'SFU session is missing the URL or token');
    }
    if (!/^wss?:\/\//i.test(this.session.url)) {
      throw new SfuError('invalid_session', 'SFU URL must use ws:// or wss://');
    }
    if (this.session.expiresAt && this.session.expiresAt < Date.now() + 5000) {
      throw new SfuError('token_expired', 'SFU access token has expired');
    }
    if (this.room) return;

    this.setState('connecting');
    const lk = await loadLiveKit();
    const hasFallback = Boolean(this.session.fallbackUrl && this.session.fallbackUrl !== this.session.url);
    let e2eeOptions: { keyProvider: unknown; worker: Worker } | undefined;
    if (this.session.e2ee) {
      this.callbacks.onE2EE?.('enabling');
      const supported = (lk as unknown as { isE2EESupported?: () => boolean }).isE2EESupported?.();
      if (supported === false) throw new SfuError('e2ee_failed', 'E2EE is not supported by this browser');
      try {
        const keyProvider = new lk.ExternalE2EEKeyProvider();
        await keyProvider.setKey(this.session.e2ee.key);
        e2eeOptions = { keyProvider, worker: new E2EEWorker() };
      } catch {
        this.callbacks.onE2EE?.('failed', { error: 'key_or_worker' });
        throw new SfuError('e2ee_failed', 'E2EE key/worker could not be initialized');
      }
    }
    this.module = lk;
    // LiveKit's client logger can echo signal payloads; silence it and emit our
    // own scrubbed diagnostics instead. The token never reaches console/DOM.
    lk.setLogLevel(lk.LogLevel.silent);
    const preferredVideoCodec = this.session.e2ee ? 'vp8' : this.videoCodec();
    const room = new lk.Room({
      ...(e2eeOptions ? { encryption: e2eeOptions as never } : {}),
      adaptiveStream: true,
      dynacast: true,
      // SFU forwards the selected codec; never transcodes on the server.
      publishDefaults: {
        ...(preferredVideoCodec ? { videoCodec: preferredVideoCodec } : {}),
        simulcast: this.config.video.simulcast,
        degradationPreference: this.config.video.degradationPreference,
      } as never,
      stopLocalTrackOnUnpublish: false,
      ...(hasFallback ? { reconnectPolicy: {
        nextRetryDelayInMs: ({ retryCount }) => retryCount < 2 ? retryCount * 700 + Math.random() * 400 : null,
      } } : {}),
      // Calls must survive tab backgrounding/freezing (mobile Safari fires
      // `pagehide` when switching apps); the WS close still removes presence.
      disconnectOnPageLeave: false,
    });
    this.room = room;
    this.wireRoom(room, lk);

    try {
      // Large rooms: subscribe audio for everyone, video only for the visible
      // page/pin/speaker (see `applyVideoSubscriptions`). Auto-subscribing 200
      // videos would defeat the whole gallery and saturate the client.
      await room.connect(this.session.url, this.session.token, {
        autoSubscribe: false,
        ...(hasFallback ? { websocketTimeout: 4000, maxRetries: 1 } : {}),
      });
    } catch (error) {
      const failure = new SfuError('connect_failed', this.scrub(error));
      await this.disposeRoom();
      if (!this.closing) this.setState('failed');
      throw failure;
    }
    if (e2eeOptions) {
      try {
        // The room-level E2EE extension enables the manager + local cryptor.
        // Calling only the participant method can encrypt outgoing frames while
        // leaving the room E2EE manager without the shared key for decryption.
        const roomApi = room as unknown as { setE2EEEnabled?: (enabled: boolean) => Promise<void> };
        if (typeof roomApi.setE2EEEnabled === 'function') await roomApi.setE2EEEnabled(true);
        else await room.localParticipant.setE2EEEnabled(true);
        const manager = (room as unknown as { e2eeManager?: { isEnabled?: boolean } }).e2eeManager;
        if (manager && manager.isEnabled === false) throw new Error('e2ee-manager-disabled');
        this.callbacks.onE2EE?.('enabled', { keyIndex: this.session.e2ee?.keyIndex });
      } catch {
        await this.disposeRoom();
        this.callbacks.onE2EE?.('failed', { error: 'enable_failed' });
        throw new SfuError('e2ee_failed', 'E2EE could not be enabled before publishing');
      }
    }
    if (this.disposed || this.closing) {
      await this.disposeRoom();
      return;
    }
    this.connected = true;
    this.setState('connected');
    // Unlock the audio context (join happens after a user gesture).
    try {
      await room.startAudio();
    } catch {
      /* autoplay may still be blocked; the next click retries */
    }
    await this.publishInitialTracks();
    for (const participant of room.remoteParticipants.values()) {
      this.announceParticipant(participant);
      this.subscribeParticipantAudio(participant);
      this.emitParticipantState(participant);
    }
    this.applyVideoSubscriptions();
    this.startStatsLoop();
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.stopStatsLoop();
    await this.disposeRoom();
    this.connected = false;
    if (this.connectionState !== 'disconnected') this.setState('disconnected');
    this.closing = false;
  }

  /** Drops the media plane without waiting for a network teardown (leave/destroy). */
  dispose(): void {
    this.disposed = true;
    this.closing = true;
    this.stopStatsLoop();
    this.clearVideoSubscriptionTimer();
    const room = this.room;
    this.room = null;
    this.connected = false;
    this.cleanupRemoteStreams();
    if (room) {
      try {
        void room.disconnect(false).catch(() => undefined);
      } catch {
        /* already gone */
      }
    }
    this.setState('disconnected');
  }

  /* ------------------------------------------------------------------ */
  /* Local publishing                                                    */
  /* ------------------------------------------------------------------ */

  /** Publishes/unpublishes the microphone (mute = unpublish, per the media plane). */
  async setAudioTrack(track: MediaStreamTrack | null, enabled: boolean): Promise<void> {
    this.audioTrack = track;
    this.micEnabled = enabled;
    await this.enqueue(async () => {
      if (!this.canPublish) return;
      if (enabled && track) await this.publishAudio(track);
      else await this.unpublishAudio();
    });
  }

  /** Stores the camera track; publishes it only while the camera is enabled. */
  async setCameraTrack(track: MediaStreamTrack | null, enabled: boolean): Promise<void> {
    this.videoTrack = track;
    this.camEnabled = enabled;
    await this.enqueue(async () => {
      if (!this.canPublish) return;
      const effective = this.effectiveVideoTrack();
      if (enabled && effective) await this.publishVideo(effective);
      else await this.unpublishVideo();
    });
  }

  /** Background blur: republishes the camera slot with a processed track (or back to raw). */
  async setVideoOverride(track: MediaStreamTrack | null): Promise<void> {
    const changed = this.videoOverride !== track;
    this.videoOverride = track;
    if (!changed) return;
    await this.enqueue(async () => {
      if (!this.canPublish || !this.camEnabled) return;
      const effective = this.effectiveVideoTrack();
      if (effective) await this.publishVideo(effective);
      else await this.unpublishVideo();
    });
  }

  /** Publishes/unpublishes screen share (a separate m-line, camera stays live). */
  async setScreenTrack(track: MediaStreamTrack | null, audio: MediaStreamTrack | null = null): Promise<void> {
    this.screenTrack = track;
    this.screenAudioTrack = track ? audio : null;
    await this.enqueue(async () => {
      if (!this.canPublish) return;
      if (track !== this.screenTrack || (track && audio !== this.screenAudioTrack)) return;
      if (track) await this.publishScreen(track, audio);
      else await this.unpublishScreen();
    });
  }

  /** Viewer/broadcast receive-only mode: stop publishing immediately. */
  async disablePublishing(): Promise<void> {
    this.micEnabled = false;
    this.camEnabled = false;
    await this.enqueue(async () => {
      await this.unpublishAudio();
      await this.unpublishVideo();
      await this.unpublishScreen();
    });
  }

  private effectiveVideoTrack(): MediaStreamTrack | null {
    return this.networkVideoLimit === 'off' ? null : this.videoOverride ?? this.videoTrack;
  }

  private async publishInitialTracks(): Promise<void> {
    if (!this.room || !this.canPublish) {
      this.emitLocalStream();
      return;
    }
    await this.enqueue(async () => {
      if (this.micEnabled && this.audioTrack) await this.publishAudio(this.audioTrack);
      const effective = this.effectiveVideoTrack();
      if (this.camEnabled && effective) await this.publishVideo(effective);
      if (this.screenTrack) await this.publishScreen(this.screenTrack, this.screenAudioTrack);
      this.emitLocalStream();
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.publishQueue[this.publishQueue.length - 1] ?? Promise.resolve();
    const next = run
      .catch(() => undefined)
      .then(task)
      .catch((error: unknown) => {
        this.callbacks.onError(new SfuError('publish_failed', this.scrub(error)));
      });
    this.publishQueue.push(next);
    return next;
  }

  private async publishAudio(track: MediaStreamTrack): Promise<void> {
    const room = this.room;
    const lk = this.module;
    if (!room || !lk) return;
    if (this.audioPublication) {
      const previous = this.audioPublication.track;
      this.audioPublication = null;
      if (previous) await room.localParticipant.unpublishTrack(previous, false).catch(() => undefined);
    }
    const publication = await room.localParticipant.publishTrack(track, {
      source: lk.Track.Source.Microphone,
      dtx: this.config.audio.dtx,
      red: true,
    });
    this.audioPublication = publication;
    this.emitLocalStream();
  }

  private async unpublishAudio(): Promise<void> {
    const room = this.room;
    if (!room || !this.audioPublication) return;
    const publication = this.audioPublication;
    this.audioPublication = null;
    if (publication.track) await room.localParticipant.unpublishTrack(publication.track, false).catch(() => undefined);
    this.emitLocalStream();
  }

  private async publishVideo(track: MediaStreamTrack): Promise<void> {
    const room = this.room;
    const lk = this.module;
    if (!room || !lk) return;
    const currentTrack = this.videoPublication?.track;
    if (currentTrack instanceof lk.LocalVideoTrack) {
      if (currentTrack.mediaStreamTrack !== track) await currentTrack.replaceTrack(track, true);
      this.emitLocalStream();
      return;
    }
    if (this.videoPublication) {
      const previous = this.videoPublication.track;
      this.videoPublication = null;
      if (previous) await room.localParticipant.unpublishTrack(previous, false).catch(() => undefined);
    }
    const videoCodec = this.session.e2ee ? 'vp8' : this.videoCodec();
    const svcCodec = videoCodec === 'vp9' || videoCodec === 'av1';
    const useSvc = svcCodec && this.config.video.scalableVideoCoding;
    const publication = await room.localParticipant.publishTrack(track, {
      source: lk.Track.Source.Camera,
      simulcast: !useSvc && this.config.video.simulcast,
      ...(!svcCodec && this.config.video.simulcast ? { videoSimulcastLayers: [lk.VideoPresets.h90, lk.VideoPresets.h180] } : {}),
      ...(svcCodec ? { scalabilityMode: useSvc ? 'L3T3_KEY' : 'L1T1' } as const : {}),
      degradationPreference: this.config.video.degradationPreference,
      ...(videoCodec ? { videoCodec } : {}),
    });
    this.videoPublication = publication;
    this.emitLocalStream();
  }

  private async unpublishVideo(): Promise<void> {
    const room = this.room;
    if (!room || !this.videoPublication) return;
    const publication = this.videoPublication;
    this.videoPublication = null;
    if (publication.track) await room.localParticipant.unpublishTrack(publication.track, false).catch(() => undefined);
    this.emitLocalStream();
  }

  private async publishScreen(track: MediaStreamTrack, audio: MediaStreamTrack | null): Promise<void> {
    const room = this.room;
    const lk = this.module;
    if (!room || !lk) return;
    if (track.readyState !== 'live') return;
    if (this.screenPublication?.track?.mediaStreamTrack !== track) {
      await this.unpublishScreen();
      this.screenPublication = await room.localParticipant.publishTrack(track, {
        source: lk.Track.Source.ScreenShare,
        simulcast: false,
        screenShareEncoding: { maxBitrate: 3_000_000, maxFramerate: this.config.session.screenShare.maxFps },
      });
    }
    const previousAudio = this.screenAudioPublication?.track;
    if ((previousAudio?.mediaStreamTrack ?? null) === audio) return;
    this.screenAudioPublication = null;
    if (previousAudio) await room.localParticipant.unpublishTrack(previousAudio, false).catch(() => undefined);
    if (audio?.readyState === 'live' && this.screenTrack === track && this.screenAudioTrack === audio) {
      this.screenAudioPublication = await room.localParticipant.publishTrack(audio, {
        source: lk.Track.Source.ScreenShareAudio,
        dtx: false,
        red: true,
      });
    }
  }

  private async unpublishScreen(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const publications = [this.screenPublication, this.screenAudioPublication];
    this.screenPublication = null;
    this.screenAudioPublication = null;
    for (const publication of publications) {
      if (publication?.track) await room.localParticipant.unpublishTrack(publication.track, false).catch(() => undefined);
    }
  }

  /** First codec from the tenant config that LiveKit supports; undefined = SDK default. */
  private videoCodec(): 'vp8' | 'h264' | 'vp9' | 'av1' | undefined {
    // Tenant preference order (video.encoding.preferredCodecs), supported only.
    const chosen = selectedVideoCodec(this.config);
    if (chosen) return chosen;
    return undefined;
  }

  private composeLocalStream(): MediaStream | null {
    const stream = new MediaStream();
    const audio = this.audioPublication?.track?.mediaStreamTrack;
    const video = this.networkVideoLimit === 'off' && this.camEnabled
      ? this.videoOverride ?? this.videoTrack
      : this.videoPublication?.track?.mediaStreamTrack;
    if (audio) stream.addTrack(audio);
    if (video) stream.addTrack(video);
    return stream.getTracks().length > 0 ? stream : null;
  }

  private emitLocalStream(): void {
    const stream = this.composeLocalStream();
    this.callbacks.onLocalStream(stream ?? new MediaStream());
  }

  /* ------------------------------------------------------------------ */
  /* Remote subscriptions                                                */
  /* ------------------------------------------------------------------ */

  private wireRoom(room: LiveKitRoom, lk: LiveKitModule): void {
    room
      .on(lk.RoomEvent.Connected, () => {
        this.connected = true;
        this.setState('connected');
      })
      .on(lk.RoomEvent.Reconnecting, () => this.setState('reconnecting'))
      .on(lk.RoomEvent.Reconnected, () => {
        this.connected = true;
        this.setState('connected');
        // LiveKit resets subscriptions on resume; re-apply audio for everyone
        // and the page/pin/speaker video policy.
        for (const participant of room.remoteParticipants.values()) this.subscribeParticipantAudio(participant);
        this.applyVideoSubscriptions();
      })
      .on(lk.RoomEvent.SignalReconnecting, () => this.setState('reconnecting'))
      .on(lk.RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        this.announceParticipant(participant);
        this.subscribeParticipantAudio(participant);
        this.applyVideoSubscriptions();
        this.emitParticipantState(participant);
      })
      .on(lk.RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        this.knownParticipants.delete(participant.identity);
        if (this.speakingParticipants.delete(participant.identity)) this.callbacks.onSpeaking(participant.identity, false);
        if (this.activeSpeaker === participant.identity) this.activeSpeaker = undefined;
        this.removeRemoteStream(participant.identity);
        this.callbacks.onParticipantLeft(participant.identity);
      })
      .on(lk.RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (publication.kind === 'video' && this.visibleVideoIds.has(participant.identity)) {
          this.applyQualityToPublication(publication, participant.identity);
        }
        this.addRemoteTrack(participant.identity, track, publication);
        this.emitParticipantState(participant);
      })
      .on(lk.RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        this.removeRemoteTrack(participant.identity, track, publication);
        this.emitParticipantState(participant);
      })
      .on(lk.RoomEvent.TrackMuted, (publication, participant) => {
        this.emitParticipantState(participant);
        if (participant.identity === this.selfId) return;
        // A muted screen share may hand the slot back to the live camera.
        if (publication.kind === 'video') this.applyVideoSubscriptions();
        this.rebuildRemoteStream(participant.identity);
      })
      .on(lk.RoomEvent.TrackUnmuted, (publication, participant) => {
        this.emitParticipantState(participant);
        if (participant.identity === this.selfId) return;
        if (publication.kind === 'video') this.applyVideoSubscriptions();
        this.rebuildRemoteStream(participant.identity);
      })
      .on(lk.RoomEvent.TrackPublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        // Audio: every participant stays audible, even off-page.
        if (publication.kind === 'audio') this.subscribePublication(publication);
        // Video: one publication per participant (screen share wins over the
        // camera) and only for the visible page/pin/speaker.
        if (publication.kind === 'video') this.applyVideoSubscriptions();
        this.emitParticipantState(participant);
      })
      .on(lk.RoomEvent.TrackUnpublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (publication.kind === 'video') this.applyVideoSubscriptions();
        this.emitParticipantState(participant);
      })
      .on(lk.RoomEvent.TrackSubscriptionPermissionChanged, (publication, _status, participant) => {
        if (publication.kind === 'video') this.emitParticipantState(participant);
      })
      .on(lk.RoomEvent.ActiveSpeakersChanged, (speakers: LiveKitParticipant[]) => {
        const active = new Set(speakers.map((speaker) => speaker.identity));
        for (const id of this.speakingParticipants) if (!active.has(id)) this.callbacks.onSpeaking(id, false);
        for (const id of active) if (!this.speakingParticipants.has(id)) this.callbacks.onSpeaking(id, true);
        this.speakingParticipants = active;
        // Speaker events are ordered by level. Follow one remote participant
        // per update, even if many microphones are active at the same time.
        const lead = speakers.find((speaker) => speaker.identity !== this.selfId)?.identity;
        const changed = lead !== this.activeSpeaker;
        this.activeSpeaker = lead;
        if (changed && lead) this.callbacks.onActiveSpeaker?.(lead);
      })
      .on(lk.RoomEvent.ParticipantNameChanged, (name: string, participant: LiveKitParticipant) => {
        if (participant.identity !== this.selfId) this.callbacks.onParticipantJoined(participant.identity, name || participant.name);
      })
      .on(lk.RoomEvent.ConnectionStateChanged, () => {
        if (room.state === lk.ConnectionState.Connected) this.setState('connected');
      })
      .on(lk.RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (this.closing || this.disposed) return;
        this.connected = false;
        this.stopStatsLoop();
        this.clearVideoSubscriptionTimer();
        this.cleanupRemoteStreams();
        this.setState('disconnected');
        const text = reason === undefined ? 'disconnected' : `${lk.DisconnectReason[reason] ?? reason}`.toLowerCase();
        this.callbacks.onDisconnected(text);
      });
  }

  private announceParticipant(participant: RemoteParticipant): void {
    if (participant.identity === this.selfId) return;
    const isNew = !this.knownParticipants.has(participant.identity);
    this.knownParticipants.add(participant.identity);
    if (isNew) this.callbacks.onParticipantJoined(participant.identity, participant.name || participant.identity);
  }

  private addRemoteTrack(participantId: string, track: RemoteTrack, publication: RemoteTrackPublication): void {
    if (participantId === this.selfId) return;
    const entries = this.remoteTracks.get(participantId) ?? [];
    if (entries.some((entry) => entry.track.sid === track.sid)) return;
    entries.push({ track, publication, source: publication.source, kind: track.kind });
    this.remoteTracks.set(participantId, entries);
    if (track.kind === 'audio') this.attachRemoteAudio(participantId, track);
    this.rebuildRemoteStream(participantId);
  }

  private removeRemoteTrack(participantId: string, track: RemoteTrack, publication: RemoteTrackPublication): void {
    void publication;
    const entries = this.remoteTracks.get(participantId);
    if (!entries) return;
    if (track.kind === 'audio') this.detachRemoteAudio(participantId, track);
    const remaining = entries.filter((entry) => entry.track.sid !== track.sid);
    if (remaining.length === 0) {
      this.removeRemoteStream(participantId);
      return;
    }
    this.remoteTracks.set(participantId, remaining);
    this.rebuildRemoteStream(participantId);
  }

  /**
   * Each remote audio track has a dedicated playback element so participants
   * remain audible when their tiles are outside the virtualized gallery.
   */
  private attachRemoteAudio(participantId: string, track: RemoteTrack): void {
    if (typeof document === 'undefined' || !track.sid) return;
    const key = `${participantId}:${track.sid}`;
    if (this.audioElements.has(key)) return;
    try {
      const element = track.attach() as HTMLAudioElement;
      element.autoplay = true;
      element.dataset.agilSfuAudio = participantId;
      element.style.display = 'none';
      document.body.appendChild(element);
      void element.play().catch(() => {
        /* autoplay may require the next user gesture; startAudio retries */
      });
      const release = this.registerAudioOutput?.(element);
      this.audioElements.set(key, { element, ...(release ? { release } : {}) });
    } catch {
      /* non-fatal: the tile still receives the audio track */
    }
  }

  private detachRemoteAudio(participantId: string, track: RemoteTrack): void {
    if (!track.sid) return;
    const key = `${participantId}:${track.sid}`;
    const output = this.audioElements.get(key);
    if (!output) return;
    this.audioElements.delete(key);
    output.release?.();
    try {
      track.detach(output.element);
    } catch {
      /* ignore */
    }
    output.element.remove();
  }

  /**
   * Builds one `MediaStream` per participant. Screen share is preferred over
   * the camera when both are live, so the existing tile renders the shared
   * screen without a separate UI path; audio tracks are always included.
   */
  private rebuildRemoteStream(participantId: string): void {
    const entries = this.remoteTracks.get(participantId);
    if (!entries || entries.length === 0) {
      this.removeRemoteStream(participantId);
      return;
    }
    const audio = entries.filter((entry) => entry.kind === 'audio' && !entry.publication.isMuted);
    const videos = entries.filter((entry) => entry.kind === 'video' && !entry.publication.isMuted);
    const screen = videos.find((entry) => entry.source === 'screen_share');
    const camera = videos.find((entry) => entry.source === 'camera');
    const video = screen ?? camera ?? videos[0];
    const stream = new MediaStream();
    for (const entry of audio) stream.addTrack(entry.track.mediaStreamTrack);
    if (video) stream.addTrack(video.track.mediaStreamTrack);
    this.streams.set(participantId, stream);
    this.callbacks.onRemoteStream(participantId, stream);
  }

  private removeRemoteStream(participantId: string): void {
    const stream = this.streams.get(participantId);
    const entries = this.remoteTracks.get(participantId);
    if (!stream && !entries) return;
    for (const entry of entries ?? []) {
      if (entry.kind === 'audio') this.detachRemoteAudio(participantId, entry.track);
    }
    if (stream) {
      for (const track of stream.getTracks()) stream.removeTrack(track);
      this.streams.delete(participantId);
    }
    this.remoteTracks.delete(participantId);
    this.callbacks.onRemoteStreamRemoved(participantId);
  }

  /** Explicit presence removal from the WS plane (peer-left before LiveKit times out). */
  dropRemoteParticipant(participantId: string): void {
    this.knownParticipants.delete(participantId);
    this.removeRemoteStream(participantId);
  }

  private emitParticipantState(participant: LiveKitParticipant): void {
    if (participant.identity === this.selfId) return;
    const state = this.stateFor(participant);
    this.callbacks.onParticipantState(participant.identity, state);
    this.callbacks.onSpeaking(participant.identity, participant.isSpeaking);
  }

  galleryCamera(participantId: string): { publicationId: string; track: MediaStreamTrack | undefined } | null {
    const participant = this.room?.remoteParticipants.get(participantId);
    const sdk = this.module;
    if (!participant || !sdk || !this.connected || this.closing || this.disposed) return null;
    const sources = sdk.Track.Source;
    const screen = participant.getTrackPublication(sources.ScreenShare);
    const camera = participant.getTrackPublication(sources.Camera);
    if ((screen && !screen.isMuted) || !camera || camera.isMuted ||
        camera.permissionStatus !== sdk.TrackPublication.PermissionStatus.Allowed) return null;
    return { publicationId: camera.trackSid, track: camera.track?.mediaStreamTrack };
  }

  private stateFor(participant: LiveKitParticipant): SfuParticipantState {
    const sources = this.module?.Track.Source;
    if (!sources) return { mic: 'off', cam: 'off', screen: false };
    const mic = participant.getTrackPublication(sources.Microphone);
    const camera = participant.getTrackPublication(sources.Camera);
    const screen = participant.getTrackPublication(sources.ScreenShare);
    return {
      mic: mic && !mic.isMuted ? 'on' : 'off',
      cam: camera && !camera.isMuted ? 'on' : 'off',
      screen: Boolean(screen && !screen.isMuted),
    };
  }

  private cleanupRemoteStreams(): void {
    const participants = new Set<string>([...this.streams.keys(), ...this.remoteTracks.keys()]);
    for (const participantId of participants) this.removeRemoteStream(participantId);
    for (const output of this.audioElements.values()) {
      output.release?.();
      output.element.remove();
    }
    this.audioElements.clear();
    this.knownParticipants.clear();
    for (const id of this.speakingParticipants) this.callbacks.onSpeaking(id, false);
    this.speakingParticipants.clear();
    this.activeSpeaker = undefined;
  }

  private async disposeRoom(): Promise<void> {
    this.clearVideoSubscriptionTimer();
    this.nextVideoSubscriptionAt = 0;
    const room = this.room;
    this.room = null;
    this.audioPublication = null;
    this.videoPublication = null;
    this.screenPublication = null;
    this.screenAudioPublication = null;
    this.cleanupRemoteStreams();
    if (!room) return;
    try {
      await room.disconnect(false);
    } catch {
      /* already disconnected */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Quality / stats                                                     */
  /* ------------------------------------------------------------------ */

  startStatsLoop(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      void this.sampleStats(true);
    }, STATS_INTERVAL_MS);
  }

  stopStatsLoop(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  async collectStats(): Promise<SfuAggregateStats> {
    return this.sampleStats(false);
  }

  private async sampleStats(emit: boolean): Promise<SfuAggregateStats> {
    const room = this.room;
    if (!room || !this.connected) return this.lastReport;
    const now = performance.now();
    const deltaSec = this.lastStatsAt > 0 ? Math.max(0.5, (now - this.lastStatsAt) / 1000) : 2;
    let bytesReceivedDelta = 0;
    let bytesSentDelta = 0;
    let packetsLostDelta = 0;
    let packetsReceivedDelta = 0;
    let jitterMs = 0;
    let rttMs = 0;
    let availableOutgoing = 0;
    let fps = 0;
    let width = 0;
    let height = 0;
    let gotStats = false;

    const inboundTracks: Array<{ key: string; track: LiveKitTrack }> = [];
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) inboundTracks.push({ key: `in:${publication.trackSid}`, track: publication.track });
      }
    }
    const outboundTracks: Array<{ key: string; track: LiveKitTrack }> = [];
    for (const publication of room.localParticipant.trackPublications.values()) {
      if (publication.track) outboundTracks.push({ key: `out:${publication.trackSid}`, track: publication.track });
    }

    try {
      for (const entry of [...inboundTracks, ...outboundTracks]) {
        const report = await entry.track.getRTCStatsReport();
        if (!report) continue;
        gotStats = true;
        const inbound = entry.key.startsWith('in:');
        let bytes = 0;
        let lost = 0;
        let received = 0;
        for (const stat of report.values()) {
          if (stat.type === 'inbound-rtp') {
            const value = stat as InboundStatsLike;
            bytes += value.bytesReceived ?? 0;
            lost += value.packetsLost ?? 0;
            received += value.packetsReceived ?? 0;
            if (value.jitter) jitterMs = Math.max(jitterMs, value.jitter * 1000);
            if (value.kind === 'video' || value.frameWidth) {
              width = Math.max(width, value.frameWidth ?? 0);
              height = Math.max(height, value.frameHeight ?? 0);
              fps = Math.max(fps, value.framesPerSecond ?? 0);
            }
          } else if (stat.type === 'outbound-rtp') {
            const value = stat as OutboundStatsLike;
            bytes += value.bytesSent ?? 0;
          } else if (stat.type === 'remote-inbound-rtp') {
            const value = stat as RemoteInboundStatsLike;
            if (value.roundTripTime) rttMs = Math.max(rttMs, value.roundTripTime * 1000);
            if (value.jitter) jitterMs = Math.max(jitterMs, value.jitter * 1000);
            lost += value.packetsLost ?? 0;
          } else if (stat.type === 'candidate-pair') {
            const value = stat as CandidatePairStatsLike;
            if (value.nominated || value.state === 'succeeded') {
              if (value.currentRoundTripTime) rttMs = Math.max(rttMs, value.currentRoundTripTime * 1000);
              if (value.availableOutgoingBitrate) availableOutgoing = Math.max(availableOutgoing, value.availableOutgoingBitrate);
            }
          }
        }
        const previous = this.baselines.get(entry.key) ?? {
          bytesReceived: 0,
          bytesSent: 0,
          packetsLost: 0,
          packetsReceived: 0,
        };
        const deltaBytes = Math.max(0, bytes - (inbound ? previous.bytesReceived : previous.bytesSent));
        if (inbound) {
          bytesReceivedDelta += deltaBytes;
          packetsLostDelta += Math.max(0, lost - previous.packetsLost);
          packetsReceivedDelta += Math.max(0, received - previous.packetsReceived);
          this.baselines.set(entry.key, {
            bytesReceived: bytes,
            bytesSent: previous.bytesSent,
            packetsLost: lost,
            packetsReceived: received,
          });
        } else {
          bytesSentDelta += deltaBytes;
          this.baselines.set(entry.key, {
            bytesReceived: previous.bytesReceived,
            bytesSent: bytes,
            packetsLost: previous.packetsLost,
            packetsReceived: previous.packetsReceived,
          });
        }
      }
    } catch {
      /* stats are best-effort */
    }
    this.lastStatsAt = now;

    const quality = room.localParticipant.connectionQuality;
    if (!gotStats || (rttMs === 0 && jitterMs === 0 && fps === 0)) {
      if (quality === 'poor') {
        rttMs = Math.max(rttMs, 420);
        jitterMs = Math.max(jitterMs, 70);
      } else if (quality === 'lost') {
        rttMs = Math.max(rttMs, 1200);
        jitterMs = Math.max(jitterMs, 180);
        packetsLostDelta = Math.max(packetsLostDelta, 10);
        packetsReceivedDelta = Math.max(packetsReceivedDelta, 40);
      }
    }
    const totalPackets = packetsLostDelta + packetsReceivedDelta;
    const snapshot: QualitySnapshot = {
      connectionState: this.connectionState === 'reconnecting' ? 'disconnected' : 'connected',
      iceConnectionState: this.connectionState === 'reconnecting' ? 'disconnected' : 'connected',
      rttMs: Math.round(rttMs),
      packetLossPct: totalPackets > 0 ? Math.round((packetsLostDelta / totalPackets) * 1000) / 10 : 0,
      jitterMs: Math.round(jitterMs),
      inboundBitrateKbps: Math.round((bytesReceivedDelta * 8) / 1000 / deltaSec),
      availableOutgoingBitrateKbps: Math.round(availableOutgoing / 1000),
      fps: Math.round(fps),
      width,
      height,
    };
    this.lastReport = {
      snapshot,
      outboundBitrateKbps: Math.round((bytesSentDelta * 8) / 1000 / deltaSec),
      peers: room.remoteParticipants.size,
      iceRestarts: 0,
    };
    if (emit) {
      const fallback = this.config.fallback.lowBandwidth;
      const observedLink = {
        ...snapshot,
        rttMs: quality === 'poor' ? Math.max(snapshot.rttMs, fallback.enterThreshold.rttMs + 1) : snapshot.rttMs,
        iceConnectionState: quality === 'lost' ? 'disconnected' : snapshot.iceConnectionState,
      };
      const decision = evaluateQuality(observedLink, fallback, this.lastTier);
      this.lastTier = decision.tier;
      let limit: typeof this.networkVideoLimit = null;
      if (fallback.enabled) {
        if (fallback.strategy !== 'reduce-video' && decision.actions.video === 'off') limit = 'off';
        else if (quality === 'lost' || decision.tier === 'critical' || decision.tier === 'offline') limit = 'very-low';
        else if (quality === 'poor' || decision.tier === 'poor') limit = 'low';
        else if (decision.actions.video === 'off' && this.networkVideoLimit !== 'off') limit = this.networkVideoLimit;
      }
      this.applyNetworkVideoLimit(limit);
      this.callbacks.onQuality(decision, snapshot);
    }
    return this.lastReport;
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  private setState(state: SfuConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.callbacks.onConnectionState(state);
  }

  /** Removes any occurrence of the token from an error message. */
  private scrub(error: unknown): string {
    const raw =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message?: unknown }).message)
            : String(error);
    const token = this.session.token;
    let text = raw;
    if (token && token.length > 8) text = text.split(token).join('[redacted]');
    // Defensive: strip anything that looks like a JWT.
    text = text.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted]');
    return text.slice(0, 400);
  }
}
