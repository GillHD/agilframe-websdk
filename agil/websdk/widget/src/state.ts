/**
 * Single observable store for the whole widget. Every UI component reads from
 * here, every controller writes here — no component talks to a controller
 * directly for rendering.
 */
import type { TenantConfig } from '@agil/protocol';
import { configuredVideoSubscriptionLimit, resolveGalleryVideoBudgetForConfig, resolvePageSize } from './call/large-room.js';
import type {
  BreakoutState,
  CallSettingsState,
  CallState,
  GalleryState,
  QualityState,
  RecordingState,
} from './types.js';

export function createInitialQuality(config: TenantConfig): QualityState {
  const enter = config.fallback.lowBandwidth.enterThreshold;
  return {
    tier: 'good',
    score: 100,
    rttMs: enter.rttMs,
    packetLossPct: 0,
    jitterMs: 0,
    inboundBitrateKbps: 0,
    availableOutgoingBitrateKbps: 0,
    fps: 0,
    width: 0,
    height: 0,
  };
}

export function createInitialSettings(config: TenantConfig): CallSettingsState {
  return {
    micEnabled: !config.session.joinWithMicOff,
    camEnabled: !config.session.joinWithCamOff,
    screenSharing: false,
    handRaised: false,
    blurMode: config.session.defaultBlurMode,
    blurStrength: config.session.blurStrength,
    backgroundImageUrl: '',
    blurDegraded: false,
    locale: config.session.defaultLocale,
    scheme: config.theme.scheme,
    preset: config.theme.scheme === 'dark' ? 'dark' : 'light',
    chatOpen: config.layout.chatDefaultOpen,
    panel: config.layout.chatDefaultOpen ? 'chat' : 'none',
    chatMode: config.session.chat.ui,
    minimized: false,
    chrome: config.layout.chrome,
    layoutMode: config.layout.mode,
    mediaMode: config.scale.mediaMode,
    sfuStatus: 'off',
    viewer: false,
    fullscreen: false,
    videoQuality: 'auto',
    pinnedId: null,
    statsOpen: false,
    captionsVisible: config.session.transcription.showCaptionsByDefault,
    degraded: false,
    micDeviceId: null,
    camDeviceId: null,
  };
}

export function createInitialRecording(): RecordingState {
  return {
    active: false,
    startedAt: null,
    consentPending: false,
    degraded: false,
    remoteActive: false,
    remoteStartedAt: null,
    remoteByName: null,
  };
}

export function createInitialGallery(config: TenantConfig): GalleryState {
  const pageSize = resolvePageSize(typeof window !== 'undefined' ? window.innerWidth : 1280);
  const maxVideoSubscriptions = configuredVideoSubscriptionLimit(config.limits.maxVideoSubscriptions, config.scale.maxVideoSubscriptions);
  return {
    page: 0,
    pageSize,
    pageCount: 1,
    total: 0,
    followSpeaker: true,
    speakerId: null,
    maxVideoSubscriptions,
    // Before the roster arrives, size the budget from the configured room cap
    // (200 by default → 2, active-speaker mode). `syncGallery()` recomputes it
    // from the live roster.
    videoBudget: resolveGalleryVideoBudgetForConfig(config, config.limits.maxParticipants),
    promotedVideoIds: [],
  };
}

export function createInitialLobby(): CallState['lobby'] {
  return {
    status: 'idle',
    requestId: null,
    expiresAt: null,
    pollAfterMs: 2000,
    startedAt: null,
    elapsedSec: 0,
  };
}

export function createInitialBreakout(): BreakoutState {
  return {
    plan: null,
    assignment: null,
    unavailable: false,
    loading: false,
    busy: false,
    switching: false,
    error: null,
    remainingSec: 0,
    names: {},
  };
}

export function createInitialWhiteboard(config: TenantConfig): CallState['whiteboard'] {
  return {
    available: config.features.whiteboard,
    visible: false,
    open: false,
    locked: false,
    strokes: 0,
  };
}

export function createInitialAnnotation(config: TenantConfig): CallState['annotation'] {
  return {
    available: config.features.annotations,
    active: false,
    presenterId: null,
    selfSharing: false,
    strokes: 0,
  };
}

export function createInitialState(config: TenantConfig, locale: 'ru' | 'en'): CallState {
  const settings = createInitialSettings(config);
  settings.locale = locale;
  return {
    phase: 'loading',
    connection: 'idle',
    wsState: 'idle',
    resumeStatus: 'idle',
    quality: createInitialQuality(config),
    room: null,
    self: null,
    participants: [],
    gallery: createInitialGallery(config),
    localStream: null,
    screenStream: null,
    remoteStreams: {},
    iceInfo: undefined,
    e2ee: { status: 'disabled' },
    mediaError: null,
    chat: [],
    chatUnread: 0,
    captions: [],
    transcripts: [],
    recording: createInitialRecording(),
    notes: null,
    findings: [],
    permissions: null,
    backgrounds: config.session.virtualBackgrounds.map((background) => ({ ...background })),
    assistant: {
      available: config.session.knowledgeAgent.enabled,
      asking: false,
      entries: [],
      denyMessage: config.session.knowledgeAgent.denyMessage,
    },
    inCallAssistant: {
      available: config.session.inCallAgent.enabled,
      busy: false,
      messages: [],
    },
    integrity: {},
    security: {
      passwordProtected: config.security.passwordRequired,
      geoEnabled: config.security.geo.enabled,
      integrityEnabled: config.security.mediaIntegrity.enabled,
      e2ee: config.security.e2ee,
      auditLog: config.security.auditLog,
    },
    lobby: createInitialLobby(),
    lobbyQueue: [],
    breakout: createInitialBreakout(),
    whiteboard: createInitialWhiteboard(config),
    annotation: createInitialAnnotation(config),
    settings,
    config,
    error: null,
    durationSec: 0,
    serverOnline: true,
    capabilities: {
      media: typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function',
      screenShare: typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function',
      blur: typeof MediaStreamTrack !== 'undefined',
      captions: typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window),
      recording: typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined',
      fileShare: true,
    },
  };
}

export type StoreSubscriber = (state: CallState, changed: ReadonlySet<string>) => void;

export class CallStore {
  private state: CallState;
  private subscribers = new Set<StoreSubscriber>();

  constructor(state: CallState) {
    this.state = state;
  }

  getState(): CallState {
    return this.state;
  }

  setState(patch: Partial<CallState> | ((state: CallState) => Partial<CallState>)): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    const changed = new Set<string>();
    for (const key of Object.keys(next) as Array<keyof CallState>) {
      const value = next[key];
      if (value === undefined) continue;
      if (this.state[key] !== value) changed.add(key);
      (this.state as unknown as Record<string, unknown>)[key] = value;
    }
    if (changed.size === 0) return;
    this.emit(changed);
  }

  /** Nested update for a section (`settings`, `quality`, `recording`, `security`). */
  patchSection<K extends 'settings' | 'quality' | 'recording' | 'security' | 'capabilities'>(
    key: K,
    patch: Partial<CallState[K]>,
  ): void {
    let changed = false;
    const section = this.state[key] as unknown as Record<string, unknown>;
    for (const [prop, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (section[prop] !== value) {
        section[prop] = value;
        changed = true;
      }
    }
    if (changed) this.emit(new Set([key]));
  }

  subscribe(subscriber: StoreSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Drops every listener, including host `subscribe()` callbacks. Used by `destroy()`. */
  clearSubscribers(): void {
    this.subscribers.clear();
  }

  private emit(changed: Set<string>): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(this.state, changed);
      } catch (error) {
        console.error('[agil] store subscriber failed', error);
      }
    }
  }
}
