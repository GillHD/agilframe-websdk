// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * `@agil/calls-widget` — public entry point (contract §6).
 *
 * `mountWidget(container, options)` creates the widget root, resolves the tenant
 * config/theme (server → options.config → options.theme), shows the join screen
 * (or stays headless) and returns an instance with the full §6 API.
 */
import {
  defaultConfig,
  browserRecordingEnabled,
  featureKeys,
  parseClientMessage,
  resolveTenantConfig,
  resolveTheme,
  VIDEO_UPGRADE_TTL_MS,
  type AnnotationSnapshot,
  type BreakoutAssignedMessage,
  type BreakoutPlan,
  type BreakoutRoomInfo,
  type ChatMessage,
  type FeatureKey,
  type IceServerConfig,
  type Locale,
  type Participant,
  type ParticipantState,
  type ServerMessage,
  type TenantConfig,
  type TenantConfigPatch,
  type AssistantAction,
  type ThemePatch,
  type ThemePresetName,
  type WelcomeMessage,
  type WhiteboardSnapshot,
  type WhiteboardSyncReason,
  type JoinRoomResponse,
  type LobbyJoinResponse,
  type RoomPoll,
  type QualityDecision,
  type QualitySnapshot,
  type SfuMediaSession,
  type TranscriptSegment,
} from '@agil/protocol';
import { ApiClient, ApiError, isBreakoutFeatureUnavailable, isLobbyJoinResponse, normalizeBaseUrl, type JoinRoomResult, type StartBreakoutInput } from './api.js';
import { applyLocalOverrides, loadConfig } from './config-loader.js';
import { CallRecorder } from './call/recording.js';
import { triggerBlobDownload } from './call/download.js';
import { withWebmDuration } from './call/webm-duration.js';
import { recordingStatePatch, remoteRecordingPatch } from './call/recording-state.js';
import { AssistantController } from './call/assistant.js';
import { InCallAssistantController } from './call/in-call-assistant.js';
import { BackgroundProcessor } from './call/blur.js';
import { CaptionsController } from './call/captions.js';
import { AudioOutput } from './call/audio-output.js';
import { ChatController } from './call/chat.js';
import { IntegrityChecker } from './call/integrity.js';
import { MediaController, MediaAccessError, mapMediaError } from './call/media.js';
import { prepareVideoCodecPreferences } from './call/encoding.js';
import {
  clampGalleryPage,
  configuredVideoSubscriptionLimit,
  galleryPageCount,
  LARGE_ROOM_MAX_PARTICIPANTS,
  normalizeVideoQuality,
  pageForParticipantId,
  pageParticipants,
  galleryPageInfo,
  planVideoSubscriptions,
  resolveGalleryVideoBudgetForConfig,
  resolvePageSize,
  type VideoQualityPreference,
} from './call/large-room.js';
import { NoiseMonitor, type NoiseDetectedEvent } from './call/noise-detection.js';
import { NotesController } from './call/notes.js';
import { applyCustomCss } from './custom-css.js';
import { applyIconOverrides, type IconOverridesHandle } from './custom-icons.js';
import { SignalingClient, SignalingError } from './call/signaling-client.js';
import { ResumeStateMachine } from './call/resume-state.js';
import { SfuEngine, SfuError, type SfuConnectionState } from './call/sfu-engine.js';
import { WebRtcEngine } from './call/webrtc-engine.js';
import { withTurnTcp } from './call/turn.js';
import { formatDuration, h } from './dom.js';
import { Emitter } from './emitter.js';
import { I18n } from './i18n.js';
import { canFeature, canSendChat, resolveChatUi, resolveLocalPermissions } from './permissions.js';
import { normalizeReaction } from './reactions.js';
import { CallStore, createInitialBreakout, createInitialLobby, createInitialState } from './state.js';
import { ThemeApplier } from './theme/apply.js';
import { themeForScheme } from './theme/scheme.js';
import { resolveUiMode } from './ui-mode.js';
import { WidgetApp, type AppActions } from './ui/app.js';
import { HeadlessUi } from './ui/headless.js';
import type { WidgetUi } from './ui/widget-ui.js';
import type { AssistantSpotlightOverlay } from './ui/spotlight.js';
import { PollsPanel, type PollView } from './ui/polls-panel.js';
import type { WhiteboardPanel } from './ui/whiteboard-panel.js';
import type { AnnotationOverlay } from './ui/annotation-overlay.js';
import type { CollaborationSurface } from './ui/collaboration-surface.js';
import { lobbyErrorText } from './ui/lobby-panel.js';
import { breakoutErrorText, type BreakoutStartOptions } from './ui/breakout-panel.js';
import type { JoinInput } from './ui/join-screen.js';
import type {
  AgilCallOptions,
  AgilPoll,
  AgilUiMode,
  AgilWidgetEvent,
  AgilWidgetEventName,
  AgilWidgetInstance,
  BlurMode,
  CallSettingsState,
  CallState,
  CallStats,
  GalleryState,
  ChatMode,
  CreatePollInput,
  MediaMode,
  PanelKind,
  CallPhase,
  LayoutMode,
  ResumeStatus,
} from './types.js';
import './style.css';
import './style-whiteboard.css';

const participantJoinSound = new URL('./call/sounds/participant-joined.wav?no-inline', import.meta.url).href;
const participantLeaveSound = new URL('./call/sounds/participant-left.wav?no-inline', import.meta.url).href;

/** Network-layer failures that switch the join screen to offline mode. */
const OFFLINE_ERROR_CODES = new Set([
  'network_error',
  'timeout',
  'socket_failed',
  'connection_closed',
  'reconnect_exhausted',
  'server_timeout',
]);

/**
 * A remote stream with no tracks cannot be rendered, and keeping one in the
 * snapshot would resurrect a participant who already left (QA P1-1). Both the
 * public getter and the store handlers use this filter so a departed id can
 * never survive as a ghost 0-track tile.
 */
export function withoutEmptyRemoteStreams(streams: Record<string, MediaStream>): Record<string, MediaStream> {
  const result: Record<string, MediaStream> = {};
  for (const [id, stream] of Object.entries(streams)) {
    if (stream && stream.getTracks().length > 0) result[id] = stream;
  }
  return result;
}

export type {
  AgilCallOptions,
  AgilNoiseDetectedEvent,
  AgilPoll,
  AgilPollOption,
  AgilReactionEvent,
  AgilRemoteStreamEvent,
  AgilToastAction,
  AgilToastEvent,
  AgilUiMode,
  AgilWidgetEvent,
  AgilWidgetEventName,
  AgilWidgetEventPayloads,
  AgilWidgetInstance,
  BlurMode,
  BreakoutAssignmentView,
  BreakoutState,
  CallStats,
  CallState,
  CallConnectionState,
  CallPhase,
  CaptionEntry,
  CreatePollInput,
  GalleryState,
  PanelKind,
  QualityState,
  RecordingState,
  SfuStatus,
  IntegrityState,
  VideoQualityPreference,
} from './types.js';
export { themePresets, resolveTheme, generatePalette, auditTheme, themePresetNames } from '@agil/protocol';
export { themeForScheme, normalizeTheme, isDarkPalette, ensureReadableTheme } from './theme/scheme.js';
export { resolveUiMode } from './ui-mode.js';
export { normalizeReaction, MAX_REACTION_LENGTH } from './reactions.js';
export { scopeCss } from './custom-css.js';
export { resolveIconOverrides, resolveIconUrl } from './custom-icons.js';
export { iconNames, isIconName, type IconName } from './icons.js';

const EVENTS: AgilWidgetEventName[] = [
  'ready',
  'joined',
  'left',
  'participant-joined',
  'participant-left',
  'remote-stream',
  'chat',
  'quality-changed',
  'connection-state',
  'error',
  'screen-share-changed',
  'theme-changed',
  'media-state',
  'minimized-changed',
  'chat-mode-changed',
  'state',
  'reaction',
  'poll',
  'noise-detected',
  'toast',
];

const SESSION_KEY = 'agil-calls:session';

export interface PersistedSession {
  room: string;
  audioOnly?: boolean;
  token?: string;
  tenantId: string;
  participantName?: string;
  serverUrl?: string;
  role?: 'host' | 'moderator' | 'guest';
  locale?: 'ru' | 'en';
  theme?: ThemePatch;
  savedAt: number;
}

/** Reads the session handoff written by `persistSession()` / `layout.persistAcrossPages`. */
export function readPersistedSession(): PersistedSession | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<PersistedSession>;
    if (typeof candidate.room !== 'string' || !candidate.room) return null;
    return {
      room: candidate.room,
      audioOnly: candidate.audioOnly === true ? true : undefined,
      token: typeof candidate.token === 'string' ? candidate.token : undefined,
      tenantId: typeof candidate.tenantId === 'string' ? candidate.tenantId : 'demo',
      participantName: typeof candidate.participantName === 'string' ? candidate.participantName : undefined,
      serverUrl: typeof candidate.serverUrl === 'string' ? candidate.serverUrl : undefined,
      role: candidate.role,
      locale: candidate.locale,
      theme: candidate.theme,
      savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function writePersistedSession(session: PersistedSession): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* private mode / quota — the call keeps working without persistence */
  }
}

function clearPersistedSession(): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function mergeResumedOptions(options: AgilCallOptions): AgilCallOptions {
  if (!options.resume) return options;
  const saved = readPersistedSession();
  if (!saved) return options;
  if (options.room && options.room !== saved.room) return options;
  if (options.tenantId && options.tenantId !== saved.tenantId) return options;
  if (options.serverUrl && normalizeBaseUrl(options.serverUrl) !== normalizeBaseUrl(saved.serverUrl)) return options;
  return {
    ...options,
    room: options.room || saved.room,
    audioOnly: options.audioOnly ?? saved.audioOnly,
    token: options.token ?? saved.token,
    tenantId: options.tenantId ?? saved.tenantId,
    participantName: options.participantName ?? saved.participantName,
    serverUrl: options.serverUrl ?? saved.serverUrl,
    role: options.role ?? saved.role,
    locale: options.locale ?? saved.locale,
    theme: options.theme ?? saved.theme,
    resume: false,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeHttpUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://localhost');
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch {
    /* invalid URL */
  }
  return null;
}

function triggerDownload(url: string, filename: string): void {
  const safe = safeHttpUrl(url);
  if (!safe) return;
  const anchor = document.createElement('a');
  anchor.href = safe;
  anchor.download = filename;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

let recordingConsentId = 0;

class AgilWidgetSession implements AgilWidgetInstance {
  private videoUpgradeTimer?: ReturnType<typeof setTimeout>;
  private videoConsentPeer?: string;
  private readonly host: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly options: AgilCallOptions;
  private readonly tenantId: string;
  /** The widget's main room — never changes. */
  private readonly mainRoomId: string;
  /** Effective room of the active signaling/media plane (main or a sub-room). */
  private roomId: string;
  private readonly i18n: I18n;
  private readonly theme: ThemeApplier;
  private readonly store: CallStore;
  private readonly api: ApiClient;
  private readonly events = new Emitter<Record<string, unknown>>();
  private readonly media = new MediaController((kind) => this.handleCaptureEnded(kind));
  private readonly audioOutput = new AudioOutput();
  private readonly participantSound: HTMLAudioElement | null;
  private readonly releaseParticipantSound: (() => void) | undefined;
  private lastParticipantSoundAt = -Infinity;
  /** `default` renders WidgetApp; `headless` leaves all markup to the host. */
  private readonly headless: boolean;
  private app: WidgetUi;
  private readonly customCssDispose: () => void;
  private iconOverrides: IconOverridesHandle | null = null;
  private storeSubscription: (() => void) | null = null;
  private config: TenantConfig;
  private signaling: SignalingClient | null = null;
  private engine: WebRtcEngine | null = null;
  /** SFU media plane (LiveKit). `null` in mesh rooms and before/after a session. */
  private sfu: SfuEngine | null = null;
  /** LiveKit session with a short-lived token: private, never stored in state/DOM. */
  private sfuSession: SfuMediaSession | null = null;
  private mediaPlane: 'mesh' | 'sfu' = 'mesh';
  private pendingMeshSignals: Array<Extract<ServerMessage, { type: 'sdp' | 'ice' }>> = [];
  private controllersReady = false;
  private sfuRetrying = false;
  private suppressSocketToasts = false;
  /** Continuity: socket-drop → resume → restored state machine (DOM-free). */
  private readonly resumeState = new ResumeStateMachine();
  private resumeStatusTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards a token-refresh + full signaling reconnect after the retry budget. */
  private recoveringSession = false;
  /** Participant ids announced by the signaling server (WS presence is authoritative). */
  private wsPeerIds = new Set<string>();
  private lastSfuErrorAt = 0;
  private chat: ChatController | null = null;
  private notes = new NotesController();
  private assistant: AssistantController | null = null;
  private inCallAssistant: InCallAssistantController | null = null;
  private spotlightOverlay: AssistantSpotlightOverlay | null = null;
  /** The coach-mark overlay is a lazy chunk: load it on the first step. */
  private spotlightLoad: Promise<AssistantSpotlightOverlay | null> | null = null;
  private pollsPanel: PollsPanel | null = null;
  private whiteboardPanel: WhiteboardPanel | null = null;
  private annotationOverlay: AnnotationOverlay | null = null;
  /** Local annotation mode (drawing over the active screen share). */
  private annotationMode = false;
  /** A whiteboard toggle happened before the lazy chunk finished loading. */
  private whiteboardLoadPending = false;
  private annotationUnsub: (() => void) | null = null;
  /* Whiteboard + annotations are optional, rarely used surfaces: their module
   * is loaded through a dynamic `import()` (see `ensureCollaboration`) instead
   * of inflating the initial widget entry. Calls made before the chunk is ready
   * are queued in order, so the surfaces behave exactly as when they were
   * constructed eagerly. */
  private collaborationLoad: Promise<boolean> | null = null;
  private collaborationQueue: Array<(surface: CollaborationSurface) => void> = [];
  private pendingWhiteboardSnapshot: { snapshot: WhiteboardSnapshot; reason: WhiteboardSyncReason } | null = null;
  private pendingAnnotationSnapshot: AnnotationSnapshot | null = null;
  private collaborationErrorShown = false;
  /** Set by `destroy()`: a dynamic import may resolve after teardown. */
  private widgetDisposed = false;
  private captions: CaptionsController | null = null;
  private integrity: IntegrityChecker | null = null;
  private recorder: CallRecorder | null = null;
  private blurProcessor: BackgroundProcessor | null = null;
  private joinToken: string | undefined;
  private selfId = '';
  private iceServers: IceServerConfig[] = [];
  private relayNoticeShown = false;
  private joined = false;
  private destroyed = false;
  private offlineDemo = false;
  private firstWelcome = true;
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private speakingTimer: ReturnType<typeof setInterval> | null = null;
  private audioContext: AudioContext | null = null;
  private analysers = new Map<string, { analyser: AnalyserNode; data: Uint8Array<ArrayBuffer>; source: MediaStreamAudioSourceNode }>();
  /** Advisory local-mic noise monitor; `null` when disabled/not applicable. */
  private noiseMonitor: NoiseMonitor | null = null;
  private qualityTier: CallState['quality']['tier'] = 'good';
  private lastDegradedToast = 0;
  private pendingJoin: JoinInput | null = null;
  private cancelRecordingConsent: (() => void) | null = null;
  private joinedAt = 0;
  private iceRestartCount = 0;
  private chatModeOverride: ChatMode | null = null;
  private persistEnabled = false;
  private lobbyPollTimer: ReturnType<typeof setTimeout> | null = null;
  private lobbyTicker: ReturnType<typeof setInterval> | null = null;
  private lobbyRequestId: string | null = null;
  private lobbyCancelToken: string | null = null;
  private lobbyName = '';
  private lobbyFailures = 0;
  private hostLobbyPollTimer: ReturnType<typeof setInterval> | null = null;
  private hostLobbyErrorShown = false;
  private pipWindow: Window | null = null;
  private pipRestoreParent: HTMLElement | null = null;
  private pipReturnFocus: HTMLElement | null = null;
  private pipPageHideHandler: (() => void) | null = null;
  private fullscreenHandler: (() => void) | null = null;
  private screenCapturePending = false;
  private shortcutHandler: ((event: KeyboardEvent) => void) | null = null;
  private galleryResizeHandler: (() => void) | null = null;
  private galleryResizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last remote participant that produced speaking=true (for follow-speaker). */
  private lastSpeakerId: string | null = null;

  /* Breakout rooms: the main room is parked here while the participant is
   * inside a sub-room. Tokens live only in private fields (never in the store
   * or the DOM). */
  private breakoutMain: {
    roomId: string;
    token: string | undefined;
    chat: ChatMessage[];
    self: Participant | null;
    joinedAt: number;
    name: string;
  } | null = null;
  private breakoutAssignmentToken: string | null = null;
  private breakoutLastAssignment: BreakoutAssignedMessage | null = null;
  private breakoutSwitching = false;
  private breakoutTicker: ReturnType<typeof setInterval> | null = null;
  private pendingBreakoutAssignment: BreakoutAssignedMessage | null = null;
  /** Main chat is merged back on return, after the child room cleared it. */
  private pendingMainChat: ChatMessage[] | null = null;
  /** Preserves the call duration across a room switch. */
  private pendingJoinedAt: number | null = null;
  private geoRequested = false;
  /** Invalidates in-flight room switches when the user leaves/destroys the call. */
  private sessionEpoch = 0;

  constructor(host: HTMLElement, options: AgilCallOptions) {
    this.host = host;
    this.options = options;
    this.headless = resolveUiMode(options) === 'headless';
    this.tenantId = options.tenantId ?? 'demo';
    this.mainRoomId = options.room;
    this.roomId = options.room;
    this.config = defaultConfig({ tenantId: this.tenantId, themePatch: options.theme, overrides: options.config });
    this.i18n = new I18n(options.locale ?? this.config.session.defaultLocale);
    this.api = new ApiClient({ baseUrl: normalizeBaseUrl(options.serverUrl) });
    this.participantSound = this.headless ? null : host.ownerDocument.createElement('audio');
    if (this.participantSound) {
      this.participantSound.dataset.agilParticipantSound = '';
      this.releaseParticipantSound = this.audioOutput.register(this.participantSound);
    }

    this.root = h('div', {
      class: `agil-root${options.embedded ? ' is-embedded' : ''}${this.headless ? ' agil-headless' : ''}`,
      dataset: {
        agilRoot: '',
        agilUi: this.headless ? 'headless' : 'default',
        state: 'idle',
        agilQuality: 'good',
        agilScheme: 'light',
      },
    });
    this.root.setAttribute('lang', this.i18n.current);
    this.root.tabIndex = -1;
    host.appendChild(this.root);
    this.theme = new ThemeApplier(this.root, () => this.onThemeApplied());
    this.theme.setTheme(this.config.theme);
    // Host customizations are applied before the built-in UI is built so the
    // first render already uses the scoped CSS and replacement icons.
    this.customCssDispose = applyCustomCss(this.root, options.customCss);
    this.iconOverrides = applyIconOverrides(this.root, options.iconUrls);
    this.store = new CallStore(createInitialState(this.config, this.i18n.current));
    this.store.setState({ phase: 'loading', audioOnly: Boolean(options.audioOnly), videoUpgrade: null });
    if (options.audioOnly) this.store.patchSection('settings', { camEnabled: false });
    // Every state change is also an event so a custom UI never needs DOM hooks.
    this.storeSubscription = this.store.subscribe((state) => this.emitLocal('state', state));
    if (this.headless) {
      this.app = new HeadlessUi(this.root, this.store, (message, kind, actions) =>
        this.emitLocal('toast', { message, kind, ...(actions ? { actions } : {}) }),
      );
    } else {
      this.app = new WidgetApp(this.root, this.store, this.i18n, this.buildActions(), Boolean(options.embedded), this.roomId);
      this.pollsPanel = new PollsPanel(this.root, this.i18n, {
        list: () => this.listPolls(),
        create: (input) => this.createPoll(input),
        vote: (pollId, optionIds) => this.votePoll(pollId, optionIds),
        close: (pollId) => this.closePoll(pollId),
        canManage: () => this.isPollManager(),
      });
      // The whiteboard card and annotation layer are built on first use by
      // `ensureCollaboration()` so the initial entry stays inside its budget.
    }
    this.ensureInCallAssistant();
    // Collaboration surfaces follow the store (participant screen flags, panel
    // visibility, role changes). The callback only writes state when it changed.
    this.annotationUnsub = this.store.subscribe(() => this.syncCollaborationState());
    this.syncCollaborationState();
    if (typeof document !== 'undefined') {
      this.fullscreenHandler = () => this.syncFullscreenState();
      document.addEventListener('fullscreenchange', this.fullscreenHandler);
      // Headless hosts own their keyboard map: a global `m`/`v`/`f` listener
      // would mute/toggle the call behind the host UI (QA P2-3).
      if (!this.headless) {
        this.shortcutHandler = (event) => this.handleShortcut(event);
        document.addEventListener('keydown', this.shortcutHandler);
      }
      this.galleryResizeHandler = () => {
        if (this.galleryResizeTimer) clearTimeout(this.galleryResizeTimer);
        this.galleryResizeTimer = setTimeout(() => {
          this.galleryResizeTimer = null;
          if (this.joined) this.syncGallery();
        }, 150);
      };
      window.addEventListener('resize', this.galleryResizeHandler);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Init / lifecycle                                                   */
  /* ------------------------------------------------------------------ */

  async init(): Promise<void> {
    this.emitLocal('ready', { serverUrl: this.api.base });
    try {
      const initial = this.options.initialServerConfig;
      const loaded = this.options.token && initial?.tenantId === this.tenantId
        ? { config: applyLocalOverrides(initial, this.options.config, this.options.theme), serverOnline: true }
        : await loadConfig(this.api, {
            tenantId: this.tenantId,
            theme: this.options.theme,
            config: this.options.config,
          });
      this.applyConfig(loaded.config, loaded.serverOnline);
    } catch (error) {
      console.error('[agil] config load failed', error);
      this.store.patchSection('settings', {});
      this.store.setState({ serverOnline: false });
    }
    this.config = this.store.getState().config;
    this.i18n.setLocale(this.resolveLocale());
    this.root.setAttribute('lang', this.i18n.current);
    // /embed.html is a standalone document: align its <html lang> with the
    // widget locale so screen readers pick the right language (WCAG 3.1.1).
    if (this.options.embedded) document.documentElement.lang = this.i18n.current;
    this.theme.setTheme(this.config.theme);
    this.theme.setLayout(this.config.layout.mode);
    this.applyAssistantAvailability();
    // Headless has no join screen: the host decides when to call `join()`.
    this.store.setState({ phase: this.headless ? 'idle' : 'join-screen', serverOnline: this.store.getState().serverOnline });
    this.app.setJoinOffline(!this.store.getState().serverOnline);
    this.app.joinScreenName(this.options.participantName ?? '');
    this.app.joinScreenServer(`${this.api.base} · ${this.roomId}`);
    if (this.options.token) {
      this.joinToken = this.options.token;
      this.api.token = this.options.token;
      await this.join();
    } else if (this.options.initialLobby?.roomId === this.roomId) {
      this.startLobbyWait(this.options.initialLobby, this.options.participantName?.trim() || this.i18n.t('guest'));
    }
  }

  /**
   * Keyboard shortcuts stay available even when buttons are hidden by
   * `layout.hiddenControls` (docs/layout.md §5): m/v/c/b/h/f.
   */
  private handleShortcut(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || this.pollsPanel?.isOpen()) return;
    const target = event.target as HTMLElement | null;
    if (target && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const state = this.store.getState();
    if (state.phase !== 'joined' || !state.config.features.keyboardShortcuts) return;
    switch (event.key.toLowerCase()) {
      case 'm':
        event.preventDefault();
        void this.toggleMic();
        break;
      case 'v':
        event.preventDefault();
        void this.toggleCamera();
        break;
      case 'c':
        event.preventDefault();
        this.openPanel('chat');
        break;
      case 'b':
        event.preventDefault();
        void this.cycleBlur();
        break;
      case 'h':
        event.preventDefault();
        this.toggleHand();
        break;
      case 'f':
        event.preventDefault();
        if (state.settings.fullscreen) void this.exitFullscreen();
        else void this.requestFullscreen();
        break;
      case 'escape': {
        event.preventDefault();
        if (state.settings.panel !== 'none') {
          this.closePanel();
        } else if (state.settings.minimized) {
          this.restore();
        } else if (state.settings.fullscreen) {
          void this.exitFullscreen();
        }
        break;
      }
      default:
        break;
    }
  }

  private resolveLocale(): Locale {
    const requested = this.options.locale;
    if (requested) return requested;
    const state = this.store.getState();
    const configured = state.config.session.defaultLocale;
    return state.config.session.locales.includes(configured) ? configured : 'ru';
  }

  private applyConfig(config: TenantConfig, serverOnline: boolean): void {
    this.config = config;
    this.captions?.setTranslateTo(config.session.transcription.translateTo);
    const state = this.store.getState();
    const transcription = config.session.transcription;
    const captionsAllowed = config.features.captions && transcription.enabled && transcription.provider !== 'off'
      && (state.permissions?.includes('captions') ?? true);
    const recognitionChanged = state.config.session.transcription.provider !== transcription.provider
      || state.config.session.transcription.consentRequired !== transcription.consentRequired;
    const settings: Partial<CallSettingsState> = {
      locale: this.options.locale ?? config.session.defaultLocale,
      scheme: config.theme.scheme,
      blurMode: config.session.defaultBlurMode,
      blurStrength: config.session.blurStrength,
      captionsVisible: captionsAllowed && (state.phase === 'joined' ? state.settings.captionsVisible : transcription.showCaptionsByDefault),
      ...(!transcription.saveTranscript && state.settings.panel === 'transcript' ? { panel: 'none' as const } : {}),
      chatMode: this.chatModeOverride ?? resolveChatUi(config, this.explicitChatUi()),
      chrome: config.layout.chrome,
      ...this.layoutSettings(state, this.options.config?.layout?.mode ?? config.layout.mode),
    };
    const nextSettings = { ...state.settings, ...settings };
    if ((nextSettings.panel === 'participants' || nextSettings.panel === 'chat') &&
      !this.canOpenPanel(nextSettings.panel, { ...state, config, settings: nextSettings })) {
      nextSettings.panel = 'none';
    }
    this.store.setState({
      config,
      serverOnline,
      settings: nextSettings,
      security: {
        passwordProtected: config.security.passwordRequired,
        geoEnabled: config.security.geo.enabled,
        integrityEnabled: config.security.mediaIntegrity.enabled || config.security.liveness.enabled,
        e2ee: config.security.e2ee,
        auditLog: config.security.auditLog,
      },
      capabilities: {
        ...state.capabilities,
        captions: state.capabilities.captions,
      },
    });
    if (this.captions) {
      if (!captionsAllowed || recognitionChanged) this.captions.stop();
      this.captions.setLanguage(this.captionsLanguage());
      if (recognitionChanged && nextSettings.captionsVisible && state.phase === 'joined') void this.captions.start();
    }
    this.theme.setTheme(config.theme);
    this.theme.setLayout(config.layout.mode);
    this.engine?.setConfig(config);
    this.sfu?.setConfig(config);
    if (state.settings.screenSharing) {
      if (!canFeature(this.store.getState(), 'screenShare')) void this.stopScreenShare();
      else if (!config.session.screenShare.shareAudio && state.screenStream?.getAudioTracks().length) {
        this.removeScreenAudio(state.screenStream);
        const track = state.screenStream.getVideoTracks()[0] ?? null;
        this.engine?.setScreenTrack(track);
        void this.sfu?.setScreenTrack(track);
      }
    }
    this.store.setState({
      gallery: {
        ...state.gallery,
        maxVideoSubscriptions: configuredVideoSubscriptionLimit(config.limits.maxVideoSubscriptions, config.scale.maxVideoSubscriptions),
        videoBudget: resolveGalleryVideoBudgetForConfig(
          config,
          state.participants.length + (state.self ? 1 : 0),
        ),
      },
    });
    if (state.inCallAssistant.available && !config.session.inCallAgent.enabled) this.inCallAssistant?.clear();
    if (!config.session.inCallAgent.enabled || !config.session.inCallAgent.spotlight) this.spotlightOverlay?.hide();
    this.applyAssistantAvailability();
    this.ensureInCallAssistant();
    this.updateScaleState();
    this.app?.update(this.store.getState());
    // A config/feature update can turn noise detection on or off at runtime.
    this.syncNoiseDetection();
    void this.loadBackgrounds();
    this.updateMessengerLayout(this.store.getState().participants.length);
    this.syncSfuSubscriptions();
  }

  /** `session.chat.ui` set explicitly via `options.config` wins over providers routing. */
  private explicitChatUi(): ChatMode | null {
    const ui = this.options.config?.session?.chat?.ui;
    return ui === 'builtin' || ui === 'external' || ui === 'hidden' ? ui : null;
  }

  /**
   * Backgrounds library (contract §23): external provider list from
   * `GET /v1/tenants/:id/backgrounds`, otherwise `config.session.virtualBackgrounds`.
   * A failing external provider silently falls back to the built-in gradients.
   */
  private async loadBackgrounds(): Promise<void> {
    const providerMode = this.config.providers?.backgrounds?.mode ?? 'builtin';
    const builtin = this.config.session.virtualBackgrounds.map((background) => ({ ...background }));
    if (providerMode === 'disabled') {
      this.store.setState({ backgrounds: [] });
      return;
    }
    if (providerMode === 'external') {
      try {
        const response = await this.api.getBackgrounds(this.tenantId);
        if (Array.isArray(response.backgrounds) && response.backgrounds.length > 0) {
          this.store.setState({ backgrounds: response.backgrounds });
          return;
        }
      } catch {
        // Provider unavailable: built-in gradients still work — no user-visible error.
      }
    }
    this.store.setState({ backgrounds: builtin });
  }

  /* ------------------------------------------------------------------ */
  /* Join flow                                                          */
  /* ------------------------------------------------------------------ */

  async join(): Promise<void> {
    if (this.joined || this.destroyed) return;
    const state = this.store.getState();
    if (state.phase === 'loading' || state.phase === 'joining' || state.phase === 'lobby') return;
    this.sessionEpoch += 1;
    this.resetBreakoutState();
    this.geoRequested = false;
    const input = this.pendingJoin;
    const name = (this.pendingJoin?.name ?? this.options.participantName ?? '').trim() || this.i18n.t('guest');
    const password = input?.password;
    if (input?.listenOnly) {
      this.store.patchSection('settings', { micEnabled: false, camEnabled: false });
    }
    this.stopLobbyTimers();
    this.store.setState({ phase: 'joining', error: null });
    this.app.setJoinBusy(true);
    try {
      if (typeof MediaStream !== 'function') {
        throw new ApiError('call_browser_unsupported', this.i18n.t('callBrowserUnsupported'));
      }
      await this.acquireLocalMedia();
      if (!this.offlineDemo) {
        const response = await this.resolveJoinToken(name, password, this.pendingJoin?.identityToken ?? this.options.identityToken);
        if (response) {
          if (isLobbyJoinResponse(response)) {
            // 202: the guest is parked in the waiting room, no token yet.
            this.startLobbyWait(response, name);
            return;
          }
          this.joinToken = response.token;
          this.applyJoinResponse(response, name);
        }
      }
      await this.connectSignaling(name);
    } catch (error) {
      this.handleJoinFailure(error);
    }
  }

  /** Shared join/admit failure UI (network vs. protocol errors). */
  private handleJoinFailure(error: unknown): void {
    const apiError = error instanceof ApiError ? error : null;
    const code = apiError?.code ?? 'internal_error';
    const offline = Boolean(apiError && OFFLINE_ERROR_CODES.has(apiError.code));
    // Headless has no join screen: `join-screen` would leave hosts that render
    // from `phase` stuck on a screen the widget never shows. A terminal `error`
    // phase is retryable (`join()` only early-returns while joining/lobby).
    this.store.setState({ phase: this.headless ? 'error' : 'join-screen' });
    this.app.setJoinBusy(false);
    if (offline) {
      this.store.setState({ serverOnline: false });
      this.app.setJoinOffline(true);
    }
    // The join screen owns the localized copy; never pass raw internal text.
    const details = apiError?.details;
    const waitingForHost = code === 'forbidden' && details && typeof details === 'object' &&
      'reason' in details && details.reason === 'host_not_joined';
    this.app.showJoinError(waitingForHost ? 'host_not_joined' : code);
    const message = offline
      ? this.i18n.t('networkError')
      : error instanceof Error
        ? error.message
        : String(error);
    this.store.setState({ error: { code, message } });
    // Emit in both branches: a host that renders from events must see offline
    // join failures too, not only `getState().error` (QA P2-2).
    this.emitLocal('error', { code, message, offline });
    this.stopLocalMedia();
  }

  private async acquireLocalMedia(): Promise<void> {
    const state = this.store.getState();
    const settings = state.settings;
    const result = await this.media.acquire(this.config, {
      micEnabled: settings.micEnabled,
      camEnabled: settings.camEnabled && !state.audioOnly,
      micDeviceId: settings.micDeviceId,
      camDeviceId: settings.camDeviceId,
    });
    const errors = [result.audioError, result.videoError].filter((error): error is MediaAccessError => Boolean(error));
    const fatal = result.stream.getTracks().length === 0 && errors.length > 0;
    this.store.setState({ localStream: result.stream, mediaError: fatal ? (errors[0]?.code ?? 'permission_denied') : null });
    if (result.audioError && settings.micEnabled) {
      this.store.patchSection('settings', { micEnabled: false });
      this.app.showToast(this.mediaErrorEvent(result.audioError, 'microphone').message, 'warning');
    }
    if (result.videoError && settings.camEnabled) {
      this.store.patchSection('settings', { camEnabled: false });
      this.app.showToast(this.mediaErrorEvent(result.videoError, 'camera').message, 'warning');
    }
    if (fatal && !this.offlineDemo) {
      // Join anyway in listen-only mode: media failure must not block the call.
      this.app.showToast(this.i18n.t('previewHint'), 'warning');
      return;
    }
    this.applyLocalTrackState();
    this.syncNoiseDetection();
    if (result.stream.getAudioTracks().length) void this.setupAudioLevels();
  }

  private async resolveJoinToken(name: string, password?: string, identityToken?: string): Promise<JoinRoomResult | null> {
    if (this.options.token) {
      this.joinToken = this.options.token;
      return null;
    }
    try {
      return await this.api.joinRoom(this.roomId, {
        name,
        password,
        locale: this.i18n.current,
        ...(identityToken ? { identityToken } : {}),
      });
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'network_error' || error.code === 'timeout')) {
        throw error;
      }
      if (error instanceof ApiError && error.status === 0) throw error;
      throw error;
    }
  }

  private applyJoinResponse(response: JoinRoomResponse, name: string): void {
    this.api.token = response.token;
    this.selfId = response.participant.id;
    const config = applyLocalOverrides(response.config, this.options.config, this.options.theme);
    this.applyConfig(config, true);
    const permissions = response.permissions ?? resolveLocalPermissions(config, response.participant.role);
    this.store.setState({
      permissions,
      self: {
        id: response.participant.id,
        name: response.participant.name || name,
        role: response.participant.role,
        joinedAt: Date.now(),
        state: { mic: 'on', cam: 'on', screen: false, handRaised: false, network: 'good' },
        verified: false,
        integrity: 'unknown',
      },
      room: response.room,
    });
    this.applyAssistantAvailability();
  }

  /* ------------------------------------------------------------------ */
  /* Waiting room — guest side                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Enters the lobby wait screen after `POST /join` answered 202. Local media
   * is released while waiting (no preview, no camera light) and re-acquired
   * automatically after admission.
   */
  private startLobbyWait(response: LobbyJoinResponse, name: string): void {
    this.stopLobbyTimers();
    this.lobbyRequestId = response.requestId;
    this.lobbyCancelToken = response.cancelToken ?? null;
    this.lobbyName = name;
    this.lobbyFailures = 0;
    this.stopLocalMedia();
    const pollAfterMs = Math.max(500, Math.min(response.pollAfterMs || 2000, 10_000));
    this.store.setState({
      phase: 'lobby',
      error: null,
      lobby: {
        status: 'pending',
        requestId: response.requestId,
        expiresAt: response.expiresAt,
        pollAfterMs,
        startedAt: Date.now(),
        elapsedSec: 0,
        ...(response.waitingMessage === undefined ? {} : { waitingMessage: response.waitingMessage }),
      },
    });
    this.app.setJoinBusy(false);
    this.app.showToast(this.i18n.t('lobbyRequestSent'), 'info', 3200);
    this.lobbyTicker = setInterval(() => this.tickLobby(), 1000);
    this.scheduleLobbyPoll(pollAfterMs);
  }

  private tickLobby(): void {
    const state = this.store.getState();
    if (state.phase !== 'lobby' || state.lobby.status !== 'pending') return;
    const startedAt = state.lobby.startedAt ?? Date.now();
    const expiresAt = state.lobby.expiresAt;
    if (expiresAt && Date.now() > expiresAt + 4000) {
      this.finishLobby('expired');
      return;
    }
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (elapsedSec !== state.lobby.elapsedSec) {
      this.store.setState({ lobby: { ...state.lobby, elapsedSec } });
    }
  }

  private scheduleLobbyPoll(delayMs: number): void {
    this.clearLobbyPoll();
    const state = this.store.getState();
    if (state.phase !== 'lobby' || state.lobby.status !== 'pending') return;
    const base = Math.max(500, delayMs || state.lobby.pollAfterMs || 2000);
    // Exponential backoff on repeated failures, capped at 15 s.
    const delay = Math.min(base * 2 ** Math.min(this.lobbyFailures, 3), 15_000);
    this.lobbyPollTimer = setTimeout(() => {
      this.lobbyPollTimer = null;
      void this.pollLobbyOnce();
    }, delay);
  }

  private async pollLobbyOnce(): Promise<void> {
    const requestId = this.lobbyRequestId;
    if (!requestId) return;
    if (this.store.getState().phase !== 'lobby') return;
    try {
      const status = await this.api.getLobbyStatus(this.roomId, requestId);
      if (this.lobbyRequestId !== requestId) return;
      this.lobbyFailures = 0;
      const state = this.store.getState();
      switch (status.status) {
        case 'pending':
          this.store.setState({
            lobby: {
              ...state.lobby,
              status: 'pending',
              expiresAt: status.expiresAt ?? state.lobby.expiresAt,
            },
          });
          this.scheduleLobbyPoll(state.lobby.pollAfterMs);
          break;
        case 'admitted': {
          if (!status.token) {
            // The capability token is returned exactly once; do not loop forever.
            this.finishLobby('error', this.i18n.t('lobbyTokenMissing'));
            return;
          }
          this.finishLobby('admitted');
          void this.enterFromLobby(status.token);
          break;
        }
        case 'rejected':
          this.finishLobby('rejected', status.reason);
          break;
        case 'expired':
          this.finishLobby('expired');
          break;
        default:
          this.scheduleLobbyPoll(state.lobby.pollAfterMs);
          break;
      }
    } catch (error) {
      if (this.lobbyRequestId !== requestId) return;
      if (error instanceof ApiError && error.status === 404) {
        // The request was pruned/decided before the token could be read.
        this.finishLobby('expired');
        return;
      }
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        this.finishLobby(
          'error',
          error.status === 401 ? this.i18n.t('lobbyErrorUnauthorized') : this.i18n.t('lobbyErrorForbidden'),
        );
        return;
      }
      this.lobbyFailures += 1;
      if (this.lobbyFailures >= 5) {
        // Five consecutive failures ≈ 30 s of backoff: stop polling and offer retry.
        this.finishLobby('timeout', this.i18n.t('lobbyTimeoutMessage'));
        return;
      }
      this.scheduleLobbyPoll(this.store.getState().lobby.pollAfterMs);
    }
  }

  private finishLobby(status: 'admitted' | 'rejected' | 'expired' | 'timeout' | 'error', reason?: string): void {
    this.stopLobbyTimers();
    const state = this.store.getState();
    if (state.phase !== 'lobby') return;
    this.store.setState({
      lobby: {
        ...state.lobby,
        status,
        ...(reason ? { reason } : {}),
      },
    });
  }

  private clearLobbyPoll(): void {
    if (this.lobbyPollTimer) {
      clearTimeout(this.lobbyPollTimer);
      this.lobbyPollTimer = null;
    }
  }

  private stopLobbyTimers(): void {
    this.clearLobbyPoll();
    if (this.lobbyTicker) {
      clearInterval(this.lobbyTicker);
      this.lobbyTicker = null;
    }
  }

  /** Clears guest lobby state (timers, request id, capability). */
  private resetLobbyState(): void {
    this.stopLobbyTimers();
    this.lobbyRequestId = null;
    this.lobbyCancelToken = null;
    this.lobbyName = '';
    this.lobbyFailures = 0;
    this.store.setState({ lobby: createInitialLobby() });
  }

  /** The guest was admitted: take the capability token and enter the call. */
  private async enterFromLobby(token: string): Promise<void> {
    this.stopLobbyTimers();
    this.joinToken = token;
    this.api.token = token;
    this.store.setState({ phase: 'joining' });
    this.app.setJoinBusy(true);
    try {
      await this.acquireLocalMedia();
      await this.connectSignaling(this.lobbyName || (this.pendingJoin?.name ?? '').trim() || this.i18n.t('guest'));
      this.resetLobbyState();
    } catch (error) {
      this.resetLobbyState();
      this.handleJoinFailure(error);
    }
  }

  /** Guest pressed "Отменить заявку"/"Вернуться". */
  private leaveLobby(message?: string): void {
    if (this.store.getState().phase !== 'lobby') return;
    const requestId = this.lobbyRequestId;
    const cancelToken = this.lobbyCancelToken;
    const withdraw = this.store.getState().lobby.status === 'pending';
    const epoch = this.sessionEpoch;
    this.resetLobbyState();
    this.stopLocalMedia();
    this.store.setState({ phase: 'join-screen', error: null });
    this.app.setJoinBusy(false);
    if (withdraw && requestId && cancelToken) {
      const isStillOnJoinScreen = (): boolean =>
        !this.destroyed && this.sessionEpoch === epoch && this.store.getState().phase === 'join-screen';
      void this.api.withdrawLobbyRequest(this.roomId, requestId, cancelToken).then(() => {
        if (message && isStillOnJoinScreen()) this.app.showToast(message, 'info', 2600);
      }).catch(() => {
        if (isStillOnJoinScreen()) {
          this.app.showToast(this.i18n.t('lobbyCancelUnconfirmed'), 'warning');
        }
      });
    } else if (withdraw && message) {
      this.app.showToast(this.i18n.t('lobbyCancelUnconfirmed'), 'warning');
    }
    this.app.focusJoin();
  }

  /** Guest pressed "Попробовать снова": a brand-new lobby request. */
  private retryLobby(): void {
    if (this.store.getState().phase !== 'lobby') return;
    this.resetLobbyState();
    this.store.setState({ phase: 'join-screen', error: null });
    this.app.setJoinBusy(false);
    void this.join();
  }

  /* ------------------------------------------------------------------ */
  /* Waiting room — host/moderator side                                 */
  /* ------------------------------------------------------------------ */

  private isLobbyManager(): boolean {
    const role = this.store.getState().self?.role ?? this.options.role ?? 'guest';
    return role === 'host' || role === 'moderator';
  }

  private startHostLobbyPolling(): void {
    if (!this.isLobbyManager() || this.hostLobbyPollTimer) return;
    this.hostLobbyErrorShown = false;
    void this.fetchLobbyQueue(true);
    this.hostLobbyPollTimer = setInterval(() => {
      void this.fetchLobbyQueue(true);
    }, 5000);
  }

  private stopHostLobbyPolling(): void {
    if (this.hostLobbyPollTimer) {
      clearInterval(this.hostLobbyPollTimer);
      this.hostLobbyPollTimer = null;
    }
    this.hostLobbyErrorShown = false;
  }

  private async fetchLobbyQueue(silent: boolean): Promise<void> {
    if (!this.isLobbyManager()) return;
    try {
      const response = await this.api.listLobbyRequests(this.roomId);
      this.store.setState({ lobbyQueue: response.requests });
    } catch (error) {
      if (silent) {
        const status = error instanceof ApiError ? error.status : 0;
        if (status === 401 || status === 403) {
          // The room token is no longer valid: stop hammering the endpoint.
          this.stopHostLobbyPolling();
        }
        if (!this.hostLobbyErrorShown) {
          this.hostLobbyErrorShown = true;
          this.app.showToast(lobbyErrorText(this.i18n, error), 'warning', 6000);
        }
        return;
      }
      throw error;
    }
  }

  private removeLobbyRequest(requestId: string): void {
    const queue = this.store.getState().lobbyQueue.filter((request) => request.id !== requestId);
    this.store.setState({ lobbyQueue: queue });
  }

  /** Admits one guest. The returned token belongs to the guest — never render it. */
  private async admitLobbyRequest(requestId: string): Promise<void> {
    if (!this.isLobbyManager()) throw new ApiError('forbidden', 'forbidden', 403);
    const request = this.store.getState().lobbyQueue.find((entry) => entry.id === requestId);
    await this.api.admitLobbyRequest(this.roomId, requestId);
    this.removeLobbyRequest(requestId);
    this.app.showToast(
      this.i18n.t('lobbyAdmittedToast', { name: request?.name ?? '' }),
      'success',
      3200,
    );
  }

  private async rejectLobbyRequest(requestId: string): Promise<void> {
    if (!this.isLobbyManager()) throw new ApiError('forbidden', 'forbidden', 403);
    const request = this.store.getState().lobbyQueue.find((entry) => entry.id === requestId);
    await this.api.rejectLobbyRequest(this.roomId, requestId);
    this.removeLobbyRequest(requestId);
    this.app.showToast(
      this.i18n.t('lobbyRejectedToast', { name: request?.name ?? '' }),
      'info',
      3200,
    );
  }

  /** "Впустить всех": sequential admits (the server has no bulk endpoint). */
  private async admitAllLobbyRequests(): Promise<void> {
    if (!this.isLobbyManager()) throw new ApiError('forbidden', 'forbidden', 403);
    const queue = [...this.store.getState().lobbyQueue];
    if (queue.length === 0) return;
    let admitted = 0;
    let lastError: unknown = null;
    for (const request of queue) {
      try {
        await this.api.admitLobbyRequest(this.roomId, request.id);
        admitted += 1;
        this.removeLobbyRequest(request.id);
      } catch (error) {
        lastError = error;
        const status = error instanceof ApiError ? error.status : 0;
        // Auth/role errors and a full room cannot be fixed by trying the rest.
        if (status === 401 || status === 403 || status === 409) break;
      }
    }
    if (admitted > 0) {
      this.app.showToast(this.i18n.t('lobbyAdmitAllDone', { n: admitted }), 'success', 3200);
    }
    if (lastError && admitted === 0) throw lastError;
  }

  /* ------------------------------------------------------------------ */
  /* Breakout rooms                                                     */
  /* ------------------------------------------------------------------ */

  private isBreakoutManager(): boolean {
    const role = this.store.getState().self?.role ?? this.options.role;
    return role === 'host' || role === 'moderator';
  }

  private resetBreakoutState(): void {
    this.stopBreakoutTicker();
    this.breakoutMain = null;
    this.breakoutAssignmentToken = null;
    this.breakoutLastAssignment = null;
    this.pendingBreakoutAssignment = null;
    this.pendingMainChat = null;
    this.pendingJoinedAt = null;
    this.breakoutSwitching = false;
    this.roomId = this.mainRoomId;
    this.store.setState({ breakout: createInitialBreakout() });
  }

  private patchBreakout(patch: Partial<CallState['breakout']>): void {
    this.store.setState({ breakout: { ...this.store.getState().breakout, ...patch } });
  }

  /** Keeps a token-free id→name map so groups of other sub-rooms keep names. */
  private rememberBreakoutNames(): void {
    const state = this.store.getState();
    const names = { ...state.breakout.names };
    let changed = false;
    const add = (id: string | undefined, name: string | undefined): void => {
      if (!id || !name) return;
      if (names[id] !== name) {
        names[id] = name;
        changed = true;
      }
    };
    add(state.self?.id, state.self?.name);
    for (const participant of state.participants) add(participant.id, participant.name);
    if (changed) this.patchBreakout({ names });
  }

  /** Plan management always targets the **main** room, even from a sub-room. */
  private breakoutMainRoomId(): string {
    return this.mainRoomId;
  }

  private breakoutMainToken(): string | undefined {
    return this.breakoutMain?.token ?? this.joinToken;
  }

  private async loadBreakoutPlan(): Promise<void> {
    if (!this.joined || !this.isBreakoutManager()) return;
    this.patchBreakout({ loading: true, error: null });
    try {
      const response = await this.api.listBreakouts(this.breakoutMainRoomId(), this.breakoutMainToken());
      const plan = response.plan ?? null;
      this.rememberBreakoutNames();
      this.patchBreakout({ plan, loading: false, unavailable: false, error: null });
      if (plan?.status === 'active') {
        this.syncBreakoutRemaining(plan);
        this.ensureBreakoutTicker();
      } else {
        this.stopBreakoutTicker();
      }
    } catch (error) {
      if (isBreakoutFeatureUnavailable(error)) {
        this.patchBreakout({ loading: false, unavailable: true, error: null });
      } else {
        this.patchBreakout({ loading: false, error: breakoutErrorText(this.i18n, error) });
      }
    }
  }

  private async startBreakout(input: BreakoutStartOptions): Promise<void> {
    const state = this.store.getState();
    if (state.breakout.busy) return;
    if (!this.isBreakoutManager()) {
      const text = this.i18n.t('breakoutErrorForbidden');
      this.patchBreakout({ error: text });
      throw new ApiError('forbidden', text, 403);
    }
    const body: StartBreakoutInput = {
      mode: input.mode,
      durationMin: input.durationMin,
      allowReturn: input.allowReturn,
    };
    if (input.mode === 'manual') {
      body.rooms = Array.from({ length: input.count }, (_, index) => ({
        name: this.i18n.t('breakoutGroup', { n: index + 1 }),
        participantIds: input.assignments?.[index] ?? [],
      }));
    } else {
      body.count = input.count;
    }
    this.patchBreakout({ busy: true, error: null });
    try {
      const plan = await this.api.startBreakout(this.breakoutMainRoomId(), body, this.breakoutMainToken());
      this.patchBreakout({ plan, busy: false, unavailable: false, error: null });
      this.syncBreakoutRemaining(plan);
      this.ensureBreakoutTicker();
      this.app.showToast(this.i18n.t('breakoutStartedToast', { n: plan.rooms.length }), 'success', 4200);
    } catch (error) {
      const text = breakoutErrorText(this.i18n, error);
      const unavailable = isBreakoutFeatureUnavailable(error);
      this.patchBreakout({
        busy: false,
        error: unavailable ? null : text,
        ...(unavailable ? { unavailable: true } : {}),
      });
      this.app.showToast(text, 'warning', 6000);
      throw error;
    }
  }

  private async closeAllBreakouts(): Promise<void> {
    const state = this.store.getState();
    if (state.breakout.busy) return;
    if (!this.isBreakoutManager()) {
      throw new ApiError('forbidden', this.i18n.t('breakoutErrorForbidden'), 403);
    }
    this.patchBreakout({ busy: true, error: null });
    const inChild = Boolean(this.breakoutMain && this.roomId !== this.breakoutMain.roomId);
    try {
      let plan: BreakoutPlan | null = null;
      try {
        plan = await this.api.closeBreakout(this.breakoutMainRoomId(), this.breakoutMainToken());
      } catch (error) {
        // 404 = no plan (already closed/pruned): refresh instead of failing.
        if (error instanceof ApiError && error.status === 404) await this.loadBreakoutPlan();
        else throw error;
      }
      if (plan) {
        this.patchBreakout({ plan, busy: false, error: null, remainingSec: 0 });
        this.stopBreakoutTicker();
      } else {
        this.patchBreakout({ busy: false });
      }
      this.app.showToast(this.i18n.t('breakoutClosedToast'), 'info', 4200);
      if (inChild) await this.returnToMainRoom({ viaApi: false, silent: true });
    } catch (error) {
      const text = breakoutErrorText(this.i18n, error);
      this.patchBreakout({ busy: false, error: text });
      this.app.showToast(text, 'error', 6000);
      throw error;
    } finally {
      if (this.store.getState().breakout.busy) this.patchBreakout({ busy: false });
    }
  }

  private handleBreakoutStarted(plan: BreakoutPlan): void {
    if (!plan || plan.status !== 'active') return;
    // Participants are still in the main room here: cache their names before
    // everyone moves to separate sub-rooms.
    this.rememberBreakoutNames();
    const previous = this.store.getState().breakout.plan;
    this.patchBreakout({ plan, loading: false, unavailable: false, error: null });
    this.syncBreakoutRemaining(plan);
    this.ensureBreakoutTicker();
    if (previous?.id !== plan.id && !this.isBreakoutManager() && !this.store.getState().breakout.assignment) {
      this.app.showToast(this.i18n.t('breakoutStartedByHost'), 'info', 3200);
    }
  }

  private handleBreakoutClosed(plan: BreakoutPlan): void {
    if (!plan || plan.status !== 'closed') return;
    const state = this.store.getState();
    const inChild = Boolean(this.breakoutMain && this.roomId !== this.breakoutMain.roomId);
    this.patchBreakout({ plan, remainingSec: 0, error: null });
    this.stopBreakoutTicker();
    if (inChild) {
      void this.returnToMainRoom({ viaApi: false, silent: true });
      return;
    }
    if (!this.isBreakoutManager() && state.breakout.assignment) {
      this.app.showToast(this.i18n.t('breakoutClosedByServer'), 'info', 3600);
    }
    this.patchBreakout({ assignment: null });
    this.store.setState({ chatUnread: 0 });
  }

  private breakoutAssignmentView(assignment: BreakoutAssignedMessage): NonNullable<CallState['breakout']['assignment']> {
    const plan = this.store.getState().breakout.plan;
    const info: BreakoutRoomInfo | undefined =
      plan?.rooms.find((room) => room.id === assignment.breakoutRoomId) ??
      plan?.rooms.find((room) => room.roomId === assignment.roomId);
    let index = info ? info.index + 1 : 1;
    if (!info) {
      const fromName = /(\d+)/.exec(assignment.name ?? '');
      if (fromName?.[1]) index = Math.max(1, Number(fromName[1]));
    }
    return {
      planId: assignment.planId,
      breakoutRoomId: assignment.breakoutRoomId,
      roomId: assignment.roomId,
      name: assignment.name || info?.name || this.i18n.t('breakoutGroup', { n: index }),
      index,
    };
  }

  private async handleBreakoutAssigned(assignment: BreakoutAssignedMessage): Promise<void> {
    if (this.offlineDemo || !this.joined || !assignment?.roomId || !assignment.token) return;
    const knownPlan = this.store.getState().breakout.plan;
    if (knownPlan && knownPlan.status === 'closed') {
      // The host closed the plan before we processed the assignment.
      this.patchBreakout({ assignment: null, switching: false });
      return;
    }
    const view = this.breakoutAssignmentView(assignment);
    if (this.roomId === assignment.roomId) {
      this.breakoutAssignmentToken = assignment.token;
      this.patchBreakout({ assignment: view, switching: false, error: null });
      return;
    }
    const current = this.store.getState().breakout.assignment;
    if (
      current &&
      current.planId === assignment.planId &&
      current.breakoutRoomId === assignment.breakoutRoomId &&
      this.breakoutAssignmentToken === assignment.token
    ) {
      return;
    }
    this.breakoutLastAssignment = assignment;
    // Show the banner immediately, before the socket/media switch completes.
    this.patchBreakout({ assignment: view, switching: true, error: null });
    await this.performBreakoutSwitch(assignment);
  }

  /** Tears down only the call plane — local camera/mic stay alive. */
  private teardownCallPlane(): void {
    this.captions?.stop();
    this.captions = null;
    this.integrity?.stop();
    this.integrity = null;
    this.recorder?.destroy();
    this.recorder = null;
    this.engine?.close();
    this.engine = null;
    this.sfu?.dispose();
    this.sfu = null;
    this.sfuSession = null;
    this.mediaPlane = 'mesh';
    this.signaling?.close('room switch');
    this.signaling = null;
    this.chat?.cancelPending();
    this.chat = null;
    this.assistant = null;
    this.controllersReady = false;
    this.clearRemoteAnalysers();
    this.store.setState({ participants: [], remoteStreams: {}, wsState: 'connecting', connection: 'connecting' });
  }

  private clearRemoteAnalysers(): void {
    for (const [id, entry] of [...this.analysers]) {
      if (this.selfId && id === this.selfId) continue;
      try {
        entry.source.disconnect();
      } catch {
        /* ignore */
      }
      this.analysers.delete(id);
      this.handleSpeaking(id, false);
    }
    for (const id of [...this.speakingState.keys()]) {
      if (!this.selfId || id !== this.selfId) this.speakingState.delete(id);
    }
  }

  private stopRecordingForRoomSwitch(): void {
    const recorder = this.recorder;
    if (!recorder) return;
    if (recorder.active) {
      this.app.showToast(this.i18n.t('breakoutRecordingStopped'), 'info', 4200);
      this.broadcastRecordingState(false, null);
      void recorder.stop();
    } else {
      recorder.destroy();
    }
    this.recorder = null;
    this.store.setState({ recording: { active: false, startedAt: null, consentPending: false, degraded: false, remoteActive: false, remoteStartedAt: null, remoteByName: null } });
  }

  private reapplyMediaToNewPlane(): void {
    const state = this.store.getState();
    if (state.settings.screenSharing) {
      const track = state.screenStream?.getVideoTracks()[0] ?? null;
      if (track) {
        const audio = state.screenStream?.getAudioTracks()[0] ?? null;
        this.engine?.setScreenTrack(track, audio);
        void this.sfu?.setScreenTrack(track, audio);
      }
    }
    if (this.blurProcessor?.track) {
      this.engine?.setVideoOverride(this.blurProcessor.track);
      this.engine?.refreshVideoSenders();
      void this.sfu?.setVideoOverride(this.blurProcessor.track);
    }
    void this.setupAudioLevels();
  }

  /** True when the host closed the plan while the client was still switching. */
  private breakoutPlanClosed(): boolean {
    const plan = this.store.getState().breakout.plan;
    return Boolean(plan && plan.status === 'closed');
  }

  private async performBreakoutSwitch(assignment: BreakoutAssignedMessage): Promise<void> {
    if (this.breakoutSwitching) {
      // A newer assignment while switching: apply it after the current switch.
      this.pendingBreakoutAssignment = assignment;
      return;
    }
    this.breakoutSwitching = true;
    const epoch = this.sessionEpoch;
    const view = this.breakoutAssignmentView(assignment);
    this.breakoutAssignmentToken = assignment.token;
    const state = this.store.getState();
    if (!this.breakoutMain) {
      this.breakoutMain = {
        roomId: this.roomId,
        token: this.joinToken,
        chat: state.chat.slice(),
        self: state.self,
        joinedAt: this.joinedAt,
        name: state.self?.name ?? this.options.participantName ?? this.i18n.t('guest'),
      };
    }
    const main = this.breakoutMain;
    this.pendingJoinedAt = main.joinedAt;
    this.pendingMainChat = null;
    const name = state.self?.name ?? main.name;
    try {
      this.stopRecordingForRoomSwitch();
      this.closePanel();
      this.teardownCallPlane();
      // The child room has its own chat; keep it empty until its welcome arrives.
      this.store.setState({ chat: [], chatUnread: 0 });
      await this.connectRoomWithRetry(assignment.roomId, assignment.token, name);
      if (this.destroyed || epoch !== this.sessionEpoch) {
        this.signaling?.close('session ended');
        this.signaling = null;
        return;
      }
      // The host may have closed the plan while we were connecting to the
      // child room (start/close race, QA round 15 P3-6). Never leave the
      // participant stranded in a closed breakout.
      if (this.breakoutPlanClosed()) {
        this.pendingBreakoutAssignment = null;
        this.breakoutSwitching = false;
        await this.returnToMainRoom({ viaApi: false, silent: true });
        return;
      }
      this.reapplyMediaToNewPlane();
      this.patchBreakout({ assignment: view, switching: false, error: null });
      this.app.showToast(this.i18n.t('breakoutJoinedToast', { n: view.index }), 'success', 3200);
    } catch {
      if (this.destroyed || epoch !== this.sessionEpoch) return;
      const text = this.i18n.t('breakoutJoinFailed');
      this.patchBreakout({ error: text, switching: false });
      this.app.showToast(text, 'error', 9000, [
        {
          label: this.i18n.t('breakoutRetry'),
          onClick: () => void this.performBreakoutSwitch(assignment),
        },
      ]);
      await this.recoverToMainRoom();
    } finally {
      if (epoch === this.sessionEpoch) {
        this.breakoutSwitching = false;
        this.patchBreakout({ switching: false });
        const pending = this.pendingBreakoutAssignment;
        this.pendingBreakoutAssignment = null;
        if (pending) void this.performBreakoutSwitch(pending);
      }
    }
  }

  /** Fallback when the sub-room switch failed: reconnect to the main room. */
  private async recoverToMainRoom(): Promise<void> {
    const main = this.breakoutMain;
    if (!main) return;
    const epoch = this.sessionEpoch;
    try {
      this.pendingJoinedAt = main.joinedAt;
      this.pendingMainChat = main.chat;
      this.teardownCallPlane();
      await this.connectRoomWithRetry(main.roomId, main.token, main.name);
      if (this.destroyed || epoch !== this.sessionEpoch) {
        this.signaling?.close('session ended');
        this.signaling = null;
        return;
      }
      this.reapplyMediaToNewPlane();
      this.finishBreakoutReturn();
    } catch {
      if (this.destroyed || epoch !== this.sessionEpoch) return;
      this.app.showToast(this.i18n.t('breakoutSwitchFailed'), 'error', 9000, [
        { label: this.i18n.t('breakoutRetry'), onClick: () => void this.recoverToMainRoom() },
      ]);
    }
  }

  /**
   * Participant return: `POST /breakouts/return` (main token) and reconnect.
   * Also used for `breakout.closed` / child-room `bye` (then `viaApi=false`).
   */
  private async returnToMainRoom(options: { viaApi: boolean; silent?: boolean }): Promise<void> {
    if (this.breakoutSwitching) return;
    const main = this.breakoutMain;
    if (!main) {
      this.patchBreakout({ assignment: null, switching: false });
      return;
    }
    if (this.roomId === main.roomId) {
      this.finishBreakoutReturn();
      return;
    }
    this.breakoutSwitching = true;
    const epoch = this.sessionEpoch;
    this.patchBreakout({ switching: true, error: null });
    try {
      if (options.viaApi) await this.api.returnFromBreakout(main.roomId, main.token);
      if (this.destroyed || epoch !== this.sessionEpoch) return;
      this.pendingJoinedAt = main.joinedAt;
      this.pendingMainChat = main.chat;
      this.stopRecordingForRoomSwitch();
      this.teardownCallPlane();
      await this.connectRoomWithRetry(main.roomId, main.token, main.name);
      if (this.destroyed || epoch !== this.sessionEpoch) {
        this.signaling?.close('session ended');
        this.signaling = null;
        return;
      }
      this.reapplyMediaToNewPlane();
      this.finishBreakoutReturn();
      if (!options.silent) this.app.showToast(this.i18n.t('breakoutReturnedToast'), 'success', 3200);
    } catch (error) {
      if (this.destroyed || epoch !== this.sessionEpoch) return;
      const text = breakoutErrorText(this.i18n, error, 'return');
      this.patchBreakout({ error: text });
      this.app.showToast(text, 'error', 9000, [
        { label: this.i18n.t('breakoutRetry'), onClick: () => void this.returnToMainRoom({ viaApi: false }) },
      ]);
    } finally {
      if (epoch === this.sessionEpoch) {
        this.breakoutSwitching = false;
        this.patchBreakout({ switching: false });
      }
    }
  }

  private finishBreakoutReturn(): void {
    this.breakoutMain = null;
    this.breakoutAssignmentToken = null;
    this.breakoutLastAssignment = null;
    const breakout = this.store.getState().breakout;
    this.patchBreakout({
      assignment: null,
      switching: false,
      error: null,
      remainingSec: breakout.plan?.status === 'active' ? this.remainingFor(breakout.plan) : 0,
    });
    if (breakout.plan?.status !== 'active') this.stopBreakoutTicker();
    this.store.setState({ chatUnread: 0 });
  }

  private async connectRoom(roomId: string, token: string | undefined, name: string): Promise<void> {
    this.roomId = roomId;
    this.joinToken = token;
    this.api.token = token;
    this.firstWelcome = true;
    await this.connectSignaling(name);
  }

  private async connectRoomWithRetry(roomId: string, token: string | undefined, name: string, attempts = 3): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.connectRoom(roomId, token, name);
        return;
      } catch (error) {
        lastError = error;
        try {
          this.signaling?.close('switch retry');
        } catch {
          /* ignore */
        }
        this.signaling = null;
        if (attempt < attempts - 1) await wait(400 * (attempt + 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(this.i18n.t('breakoutSwitchFailed'));
  }

  private remainingFor(plan: BreakoutPlan | null): number {
    if (!plan || plan.status !== 'active' || !plan.endsAt) return 0;
    return Math.max(0, Math.ceil((plan.endsAt - Date.now()) / 1000));
  }

  private syncBreakoutRemaining(plan: BreakoutPlan | null): void {
    const remaining = this.remainingFor(plan);
    if (this.store.getState().breakout.remainingSec !== remaining) this.patchBreakout({ remainingSec: remaining });
  }

  private ensureBreakoutTicker(): void {
    if (this.breakoutTicker) return;
    this.breakoutTicker = setInterval(() => this.tickBreakout(), 1000);
  }

  private stopBreakoutTicker(): void {
    if (!this.breakoutTicker) return;
    clearInterval(this.breakoutTicker);
    this.breakoutTicker = null;
  }

  private tickBreakout(): void {
    const breakout = this.store.getState().breakout;
    if (!breakout.plan) {
      this.stopBreakoutTicker();
      return;
    }
    if (breakout.plan.status !== 'active') {
      if (breakout.remainingSec !== 0) this.patchBreakout({ remainingSec: 0 });
      if (!breakout.assignment) this.stopBreakoutTicker();
      return;
    }
    const remaining = this.remainingFor(breakout.plan);
    if (remaining !== breakout.remainingSec) this.patchBreakout({ remainingSec: remaining });
  }

  /* ------------------------------------------------------------------ */
  /* Whiteboard + annotations (optional)                                 */
  /* ------------------------------------------------------------------ */

  private isCollaborationManager(): boolean {
    const role = this.store.getState().self?.role;
    return role === 'host' || role === 'moderator';
  }

  private selfIdentity(): { id: string; name: string } {
    const self = this.store.getState().self;
    return {
      id: self?.id ?? this.selfId ?? 'self',
      name: self?.name ?? this.i18n.t('you'),
    };
  }

  /** Participant whose screen is currently shared (self share wins). */
  private currentPresenter(): { id: string; name: string; selfSharing: boolean } | null {
    const state = this.store.getState();
    if (state.phase !== 'joined') return null;
    const self = state.self;
    if (state.settings.screenSharing && self) return { id: self.id, name: self.name, selfSharing: true };
    const remote = state.participants.find((participant) => participant.state.screen);
    return remote ? { id: remote.id, name: remote.name, selfSharing: false } : null;
  }

  /**
   * Loads the lazy whiteboard/annotation chunk. Resolves `true` once both
   * surfaces exist, `false` when they are unavailable (headless host, teardown
   * or a chunk that cannot be fetched); a failure is surfaced once and the next
   * interaction retries. While the import is in flight every accessor below
   * keeps the current state in a queue and replays it in arrival order.
   */
  private ensureCollaboration(): Promise<boolean> {
    if (this.whiteboardPanel && this.annotationOverlay) return Promise.resolve(true);
    if (this.headless || this.widgetDisposed) return Promise.resolve(false);
    if (!this.collaborationLoad) {
      this.collaborationLoad = import('./ui/collaboration-surface.js')
        .then(({ createCollaborationSurface }) => {
          if (this.widgetDisposed) return false;
          const surface = createCollaborationSurface(this.root, this.i18n, {
            send: (message) => {
              this.signaling?.send(message);
            },
            canManage: () => this.isCollaborationManager(),
            self: () => this.selfIdentity(),
            onVisibilityChange: () => this.syncCollaborationState(),
            onDenied: (text) => this.app.showToast(text, 'warning'),
            isPresenter: () => {
              const presenter = this.currentPresenter();
              return Boolean(presenter && presenter.id === this.selfIdentity().id);
            },
            onExit: () => this.setAnnotationMode(false),
            onNotice: (text) => this.app.showToast(text, 'info', 3200),
          });
          this.whiteboardPanel = surface.whiteboard;
          this.annotationOverlay = surface.annotation;
          // Replay the join/reconnect snapshots that arrived before the chunk
          // was ready, then every signaling event queued meanwhile (in order).
          if (this.pendingWhiteboardSnapshot) {
            const { snapshot, reason } = this.pendingWhiteboardSnapshot;
            this.pendingWhiteboardSnapshot = null;
            surface.whiteboard.applySnapshot(snapshot, reason);
          }
          if (this.pendingAnnotationSnapshot) {
            const snapshot = this.pendingAnnotationSnapshot;
            this.pendingAnnotationSnapshot = null;
            surface.annotation.handleSnapshot(snapshot);
          }
          const queued = this.collaborationQueue;
          this.collaborationQueue = [];
          for (const apply of queued) apply(surface);
          this.syncCollaborationState();
          return true;
        })
        .catch((error: unknown) => {
          console.error('[agil] collaboration bundle failed to load', error);
          this.collaborationLoad = null;
          this.collaborationQueue = [];
          if (!this.widgetDisposed && !this.collaborationErrorShown) {
            this.collaborationErrorShown = true;
            this.app.showToast(this.i18n.t('notAvailable'), 'warning');
          }
          return false;
        });
    }
    return this.collaborationLoad;
  }

  /** Runs `apply` against the collaboration surfaces, importing them on demand. */
  private whenCollaborationReady(apply: (surface: CollaborationSurface) => void): void {
    if (this.headless) return;
    if (this.whiteboardPanel && this.annotationOverlay) {
      apply({ whiteboard: this.whiteboardPanel, annotation: this.annotationOverlay, destroy: () => undefined });
      return;
    }
    this.collaborationQueue.push(apply);
    void this.ensureCollaboration();
  }

  private applyWhiteboardSnapshot(snapshot: WhiteboardSnapshot, reason: WhiteboardSyncReason): void {
    if (this.whiteboardPanel) this.whiteboardPanel.applySnapshot(snapshot, reason);
    else this.pendingWhiteboardSnapshot = { snapshot, reason };
  }

  private applyAnnotationSnapshot(snapshot: AnnotationSnapshot): void {
    if (this.annotationOverlay) this.annotationOverlay.handleSnapshot(snapshot);
    else this.pendingAnnotationSnapshot = snapshot;
  }

  /**
   * Loads the assistant coach-mark overlay on the first spotlight step. A
   * failure degrades to "no coach marks" (the call itself is unaffected).
   */
  private ensureSpotlight(): Promise<AssistantSpotlightOverlay | null> {
    if (this.spotlightOverlay) return Promise.resolve(this.spotlightOverlay);
    if (this.headless || this.widgetDisposed) return Promise.resolve(null);
    if (!this.spotlightLoad) {
      this.spotlightLoad = import('./ui/spotlight.js')
        .then(({ AssistantSpotlightOverlay: Overlay }) => {
          if (this.widgetDisposed) return null;
          this.spotlightOverlay = new Overlay(this.root, this.i18n);
          return this.spotlightOverlay;
        })
        .catch((error: unknown) => {
          console.error('[agil] assistant spotlight bundle failed to load', error);
          this.spotlightLoad = null;
          return null;
        });
    }
    return this.spotlightLoad;
  }

  /**
   * Mirrors the collaboration models into `CallState` and repositions/enables
   * the annotation overlay. Safe to call on every store update: state is only
   * written when a value actually changed.
   */
  private syncCollaborationState(): void {
    const state = this.store.getState();
    const whiteboardAvailable = canFeature(state, 'whiteboard');
    if (!whiteboardAvailable && this.whiteboardPanel?.isOpen()) this.whiteboardPanel.close();
    const board = this.whiteboardPanel?.boardState() ?? { open: false, locked: false, strokes: 0, visible: false };
    if (
      state.whiteboard.available !== whiteboardAvailable ||
      state.whiteboard.visible !== board.visible ||
      state.whiteboard.open !== board.open ||
      state.whiteboard.locked !== board.locked ||
      state.whiteboard.strokes !== board.strokes
    ) {
      this.store.setState({
        whiteboard: {
          available: whiteboardAvailable,
          visible: board.visible,
          open: board.open,
          locked: board.locked,
          strokes: board.strokes,
        },
      });
    }

    const annotationsAvailable = canFeature(state, 'annotations');
    const presenter = this.currentPresenter();
    if (!presenter && this.annotationMode) this.annotationMode = false;
    if (!annotationsAvailable && this.annotationMode) this.annotationMode = false;
    const active = this.annotationMode && annotationsAvailable && Boolean(presenter);
    if (
      state.annotation.available !== annotationsAvailable ||
      state.annotation.active !== active ||
      state.annotation.presenterId !== (presenter?.id ?? null) ||
      state.annotation.selfSharing !== Boolean(presenter?.selfSharing) ||
      state.annotation.strokes !== (this.annotationOverlay?.strokeCount ?? 0)
    ) {
      this.store.setState({
        annotation: {
          available: annotationsAvailable,
          active,
          presenterId: presenter?.id ?? null,
          selfSharing: Boolean(presenter?.selfSharing),
          strokes: this.annotationOverlay?.strokeCount ?? 0,
        },
      });
    }
    this.annotationOverlay?.setTarget(
      presenter ? { presenterId: presenter.id, selfSharing: presenter.selfSharing } : null,
      presenter?.name ?? '',
    );
    this.annotationOverlay?.setEnabled(active);
  }

  private toggleWhiteboard(): void {
    const state = this.store.getState();
    if (!canFeature(state, 'whiteboard')) {
      this.app.showToast(this.i18n.t('notAvailable'), 'warning');
      return;
    }
    if (this.whiteboardPanel) {
      if (this.whiteboardPanel.isOpen()) this.whiteboardPanel.close();
      else this.whiteboardPanel.open();
      this.syncCollaborationState();
      return;
    }
    // First use: the surfaces live in a lazy chunk. Keep the click (the panel
    // opens as soon as the chunk is ready) and let a second click cancel it.
    if (this.whiteboardLoadPending) {
      this.whiteboardLoadPending = false;
      return;
    }
    this.whiteboardLoadPending = true;
    void this.ensureCollaboration().then((ready) => {
      const shouldOpen = this.whiteboardLoadPending;
      this.whiteboardLoadPending = false;
      if (!ready || !shouldOpen || this.widgetDisposed) return;
      this.whiteboardPanel?.open();
      this.syncCollaborationState();
    });
  }

  private setAnnotationMode(enabled: boolean): void {
    const state = this.store.getState();
    if (enabled) {
      if (!canFeature(state, 'annotations')) {
        this.app.showToast(this.i18n.t('notAvailable'), 'warning');
        return;
      }
      if (!this.currentPresenter()) {
        this.app.showToast(this.i18n.t('annotationsUnavailable'), 'info');
        return;
      }
    }
    if (this.annotationMode === enabled) return;
    this.annotationMode = enabled;
    this.syncCollaborationState();
    if (!enabled) return;
    // The overlay is a lazy chunk: it enables itself once loaded. Roll the
    // toggle back if the chunk is unavailable so the button never lies.
    void this.ensureCollaboration().then((ready) => {
      if (!ready && !this.widgetDisposed && this.annotationMode) {
        this.annotationMode = false;
        this.syncCollaborationState();
      }
    });
  }

  private toggleAnnotations(): void {
    this.setAnnotationMode(!this.annotationMode);
  }

  private mapPoll(poll: RoomPoll): PollView {
    return {
      id: poll.id,
      question: poll.question,
      options: poll.options.map((option) => ({
        id: option.id,
        text: option.text,
        votes: option.votes,
        share: option.share,
      })),
      multiple: poll.multiple,
      anonymous: poll.anonymous,
      kind: poll.kind,
      status: poll.status === 'closed' ? 'closed' : 'active',
      votes: poll.totalVotes,
      ...(poll.voted !== undefined || poll.options.some((option) => option.selected !== undefined)
        ? { myVotes: poll.options.filter((option) => option.selected).map((option) => option.id) }
        : {}),
    };
  }

  private isPollManager(): boolean {
    const role = this.store.getState().self?.role ?? this.options.role;
    return role === 'host' || role === 'moderator';
  }

  private emitPoll(poll: AgilPoll): AgilPoll {
    this.emitLocal('poll', poll);
    return poll;
  }

  /* Public poll controller (host-rendered UI; the built-in panel uses the same
   * methods). Server permissions are authoritative; local checks give an early,
   * typed error instead of a 403 toast. */

  async listPolls(): Promise<AgilPoll[]> {
    const result = (await this.api.listPolls(this.roomId)) as { polls?: RoomPoll[] };
    return (result.polls ?? []).map((poll) => this.mapPoll(poll));
  }

  async createPoll(input: CreatePollInput): Promise<AgilPoll> {
    if (!this.isPollManager()) throw new ApiError('forbidden', 'forbidden', 403);
    const question = typeof input?.question === 'string' ? input.question.trim() : '';
    const options = Array.isArray(input?.options) ? input.options.map((text) => String(text).trim()).filter(Boolean).slice(0, 10) : [];
    if (question.length < 3 || options.length < 2) throw new ApiError('invalid_poll', 'invalid poll', 400);
    const poll = (await this.api.createPoll(this.roomId, {
      question,
      options: options.map((text) => ({ text })),
      multiple: Boolean(input.multiple),
      anonymous: input.anonymous !== false,
      kind: input.kind === 'qna' ? 'qna' : 'poll',
    })) as RoomPoll;
    return this.emitPoll(this.mapPoll(poll));
  }

  async votePoll(pollId: string, optionIds: string[]): Promise<AgilPoll> {
    const ids = Array.isArray(optionIds) ? optionIds.filter((id) => typeof id === 'string' && id).slice(0, 10) : [];
    if (!pollId || ids.length === 0) throw new ApiError('invalid_poll', 'no option selected', 400);
    const result = (await this.api.votePoll(this.roomId, pollId, ids)) as { poll: RoomPoll };
    return this.emitPoll(this.mapPoll(result.poll));
  }

  async closePoll(pollId: string): Promise<AgilPoll> {
    if (!this.isPollManager()) throw new ApiError('forbidden', 'forbidden', 403);
    if (!pollId) throw new ApiError('invalid_poll', 'poll id is required', 400);
    return this.emitPoll(this.mapPoll((await this.api.closePoll(this.roomId, pollId)) as RoomPoll));
  }

  private async connectSignaling(name: string, resumeToken: string | null = null): Promise<void> {
    if (this.offlineDemo) {
      this.enterJoinedState();
      return;
    }
    const epoch = this.sessionEpoch;
    if (this.config.video.encoding?.strategy === 'prefer-hardware') {
      await prepareVideoCodecPreferences(this.config);
      if (this.destroyed || epoch !== this.sessionEpoch) return;
    }
    const state = this.store.getState();
    const reconnect = this.config.fallback.lowBandwidth.autoReconnect;
    const url = this.api.websocketUrl({
      token: this.joinToken,
      tenantId: this.tenantId,
      roomId: this.roomId,
      name,
      role: this.options.role ?? 'guest',
      // Opt into the server-side resume grace lease: a short socket drop keeps
      // this participant's slot, so peers never see a leave/re-join pair.
      resume: true,
    });
    this.signaling = new SignalingClient({
      url,
      protocols: this.api.websocketProtocols(this.joinToken),
      reconnect,
      // A recovery reconnect must offer the last resume capability too: the
      // server can then resume the held/restored slot instead of announcing a
      // replace + fresh join (docs/call-continuity.md §6.3).
      ...(resumeToken ? { resumeToken } : {}),
    });
    this.wireSignaling(this.signaling);
    this.store.setState({ wsState: 'connecting', connection: 'connecting' });
    try {
      await this.signaling.connect();
      if (this.destroyed || epoch !== this.sessionEpoch) {
        // The user left/destroyed the widget while the socket was connecting.
        this.signaling.close('session ended');
        this.signaling = null;
        return;
      }
      // The `welcome` frame is handled by the `message` emitter (wired before
      // connect) — handling it here as well would start a second SFU session
      // with the same participant identity.
      this.store.setState({ wsState: 'open' });
    } catch (error) {
      this.signaling?.close('join failed');
      this.signaling = null;
      this.store.setState({ wsState: 'closed', connection: 'offline' });
      const message = error instanceof Error ? error.message : String(error);
      // Keep the signaling failure code for hosts; the join UI renders copy by code.
      const code = error instanceof SignalingError ? error.code : 'network_error';
      const apiError = new ApiError(code, message, error instanceof SignalingError && error.code === 'origin_not_allowed' ? 403 : 0);
      throw apiError;
    }
  }

  private wireSignaling(signaling: SignalingClient): void {
    signaling.emitter.on('message', (message) => {
      // Ignore frames from a socket that has already been replaced.
      if (this.signaling !== signaling) return;
      this.handleServerMessage(message);
    });
    signaling.emitter.on('reconnecting', ({ attempt }) => {
      this.showConversationReview();
      // The call shows reconnecting while the socket retries.
      const resumeStatus = this.resumeState.beginAttempt('socket-closed');
      this.setResumeStatus(resumeStatus);
      this.store.setState({ wsState: 'reconnecting', connection: 'reconnecting' });
      this.emitLocal('connection-state', {
        connection: 'reconnecting',
        overall: 'reconnecting',
        resumeStatus,
        attempt,
      });
    });
    signaling.emitter.on('reconnected', () => {
      // The socket is back; `welcome` decides whether the server resumed the
      // same participant (no duplicate join) or this is a fresh join.
      const resumeStatus = this.resumeState.markSocketOpen();
      this.setResumeStatus(resumeStatus);
      if (this.pollsPanel?.isOpen()) void this.pollsPanel.refresh();
      // Re-sync the collaboration surfaces that changed while offline.
      if (this.whiteboardPanel?.isOpen()) this.signaling?.send({ type: 'whiteboard.sync' });
      this.store.setState({ wsState: 'open' });
    });
    signaling.emitter.on('open', () => this.store.setState({ wsState: 'open' }));
    signaling.emitter.on('exhausted', () => {
      if (this.destroyed || this.breakoutSwitching || this.suppressSocketToasts) return;
      // Inside a sub-room a closed socket usually means the host closed the
      // breakout: fall back to the main room instead of giving up.
      if (this.breakoutMain && this.roomId !== this.breakoutMain.roomId) {
        this.store.setState({ wsState: 'closed', connection: 'offline' });
        void this.returnToMainRoom({ viaApi: false, silent: false });
        return;
      }
      const wasInterrupted = this.resumeState.interrupted;
      this.resumeState.fail('exhausted');
      this.setResumeStatus('failed');
      this.store.setState({ wsState: 'closed', connection: 'offline' });
      // A reconnect that exhausted its backoff gets one token refresh + full
      // signaling reconnect with the same participant id (never a new peer).
      if (wasInterrupted && this.joined && !this.offlineDemo && !this.recoveringSession) {
        void this.recoverSession('exhausted');
        return;
      }
      this.app.showToast(this.i18n.t('reconnectFailed'), 'error');
    });
    signaling.emitter.on('error', (error) => {
      if (this.breakoutSwitching) return;
      if (error.fatal) {
        this.resumeState.fail(error.code);
        this.setResumeStatus('failed');
        // Expired join token after a long blip: refresh it for the same
        // participant and retry the signaling reconnect once.
        if (this.joined && !this.offlineDemo && !this.recoveringSession && error.code === 'unauthorized') {
          void this.recoverSession('unauthorized');
          return;
        }
        this.app.showToast(this.i18n.t('reconnectFailed'), 'error');
      }
      this.emitLocal('error', error);
    });
  }

  /** Publishes the continuity status and clears the transient badge after a while. */
  private setResumeStatus(status: ResumeStatus): void {
    if (this.resumeStatusTimer) {
      clearTimeout(this.resumeStatusTimer);
      this.resumeStatusTimer = null;
    }
    this.store.setState({ resumeStatus: status });
    if (status !== 'restored' && status !== 'failed') return;
    // `restored` is a short success badge; `failed` must not stick forever on a
    // recovered call (a later attempt sets `reconnecting` first).
    this.resumeStatusTimer = setTimeout(() => {
      this.resumeStatusTimer = null;
      if (status === 'restored') this.resumeState.settle();
      if (this.store.getState().resumeStatus === status) this.store.setState({ resumeStatus: 'idle' });
    }, status === 'restored' ? 4000 : 8000);
  }

  /**
   * Last-resort session recovery after the socket backoff is exhausted (or the
   * join token expired): mint a fresh token for the same participant id, then
   * reconnect signaling. Local tracks and the SFU session are left untouched
   * until the new welcome says whether it was a resume or a fresh join.
   */
  private async recoverSession(reason: string): Promise<boolean> {
    if (this.destroyed || !this.joined || this.offlineDemo || this.recoveringSession) return false;
    this.recoveringSession = true;
    this.setResumeStatus('restoring');
    const name = this.store.getState().self?.name ?? this.pendingJoin?.name ?? this.options.participantName ?? '';
    // The replacement socket must keep offering the resume capability from the
    // old connection: without it the server treats the reconnect as a brand-new
    // join (`peer-left replaced` + `peer-joined`) even inside the grace window.
    const resumeToken = this.signaling?.resumeTokenValue ?? null;
    try {
      if (!this.options.token) {
        // `participantId` keeps the identity stable across a rotated join token.
        const response = await this.api.joinRoom(this.roomId, {
          name,
          ...(this.selfId ? { participantId: this.selfId } : {}),
          ...(this.pendingJoin?.password ? { password: this.pendingJoin.password } : {}),
          ...(this.pendingJoin?.identityToken ?? this.options.identityToken
            ? { identityToken: this.pendingJoin?.identityToken ?? this.options.identityToken }
            : {}),
        });
        if (isLobbyJoinResponse(response)) return false;
        this.joinToken = response.token;
        this.api.token = response.token;
      }
      await this.connectSignaling(name, resumeToken);
      return true;
    } catch (error) {
      console.warn(`[agil] session recovery failed (${reason})`, error instanceof Error ? error.message : String(error));
      this.setResumeStatus('failed');
      this.store.setState({ wsState: 'closed', connection: 'offline' });
      if (!this.suppressSocketToasts) this.app.showToast(this.i18n.t('reconnectFailed'), 'error');
      return false;
    } finally {
      setTimeout(() => {
        this.recoveringSession = false;
      }, 1000);
    }
  }

  private handleWelcome(welcome: WelcomeMessage): void {
    if (this.destroyed) return;
    const config = applyLocalOverrides(welcome.config, this.options.config, this.options.theme);
    this.applyConfig(config, true);
    this.selfId = welcome.self.id;
    // Prefer TURN UDP + TCP variants; relay is only used on failure or via policy.
    this.iceServers = welcome.iceServers?.length ? withTurnTcp(welcome.iceServers) : [];
    this.engine?.setIceServers(this.iceServers);
    const permissions = welcome.self.permissions
      ? (welcome.self.permissions as FeatureKey[])
      : resolveLocalPermissions(config, welcome.self.role);
    const isReconnect = !this.firstWelcome;
    this.firstWelcome = false;
    /* SFU media plane: the backend adds `welcome.media` only when the tenant
     * runs `scale.mediaMode === 'sfu'`; mesh rooms never have it. */
    const sfuMedia = welcome.media?.mode === 'sfu' && welcome.media.url && welcome.media.token ? welcome.media : null;
    const previousSfuSession = this.sfuSession;
    // Continuity: let the machine decide whether this welcome is a resumed
    // session and whether the media plane must be rebuilt. The resume token is
    // rotated on every welcome, so the next drop offers the fresh one.
    // `awaitingWelcome` is true only for an automatic reconnect attempt; a
    // deliberate new connection (room switch, SFU retry) is a fresh join.
    const resumeAttempt = this.resumeState.waitingForWelcome;
    const resumeDecision = resumeAttempt
      ? this.resumeState.applyWelcome({
          resumed: welcome.resumed === true,
          hasSfuSession: Boolean(sfuMedia),
          sfuConnected: this.sfu !== null && this.store.getState().settings.sfuStatus === 'connected',
          sameSfuRoom: Boolean(sfuMedia && previousSfuSession?.room === sfuMedia.room),
          meshConnected: this.mediaPlane === 'mesh' && Boolean(this.engine?.hasConnectedPeers()),
        })
      : {
          status: this.resumeState.status,
          resumed: false,
          keepMedia: false,
          rejoinSfu: false,
          rebuildPeers: isReconnect,
          keepLocalTracks: true as const,
          reason: 'not-interrupted' as const,
        };
    this.signaling?.setResumeToken(welcome.resume?.token ?? null);
    const previousPlane = this.mediaPlane;
    this.mediaPlane = sfuMedia ? 'sfu' : 'mesh';
    this.sfuSession = sfuMedia;
    this.wsPeerIds = new Set<string>([welcome.self.id, ...welcome.participants.map((participant) => participant.id)]);
    const participants = welcome.participants.filter((participant) => participant.id !== welcome.self.id);
    if (isReconnect) {
      if (resumeDecision.rebuildPeers) {
        this.engine?.removeAllPeers();
        this.analysers.forEach((entry) => {
          try {
            entry.source.disconnect();
          } catch {
            /* ignore */
          }
        });
        this.analysers.clear();
      }
    }
    this.store.setState({
      self: welcome.self,
      room: welcome.room,
      participants,
      permissions,
      settings: { ...this.store.getState().settings, handRaised: welcome.self.state.handRaised === true },
      wsState: 'open',
      connection: 'connecting',
      security: {
        passwordProtected: config.security.passwordRequired,
        geoEnabled: config.security.geo.enabled,
        integrityEnabled: config.security.mediaIntegrity.enabled || config.security.liveness.enabled,
        e2ee: config.security.e2ee,
        auditLog: config.security.auditLog,
      },
    });
    this.syncRemoteRecording();
    const history = welcome.history ?? [];
    // Replay the live collaboration surfaces (bounded snapshots from the
    // server). Those surfaces are lazy: when the chunk is not loaded yet the
    // snapshot is kept and applied the moment it is (no extra download here).
    if (welcome.whiteboard) this.applyWhiteboardSnapshot(welcome.whiteboard, 'join');
    if (welcome.annotations) this.applyAnnotationSnapshot(welcome.annotations);
    this.syncCollaborationState();
    const restoredChat = this.pendingMainChat;
    this.pendingMainChat = null;
    if (restoredChat) {
      // Returning from a sub-room: keep the main-room history (including
      // messages that arrived while we were away) and reset unread state.
      this.store.setState({ chat: dedupeMessages([...restoredChat, ...history]), chatUnread: 0 });
    } else if (history.length > 0) {
      this.store.setState({ chat: dedupeMessages(history) });
    }
    this.applyAssistantAvailability();
    this.updateScaleState();
    if (isReconnect) {
      if (resumeDecision.keepMedia && this.mediaPlane === 'sfu' && sfuMedia) {
        // The media plane survived the signaling blip (LiveKit session is still
        // connected): only refresh the short-lived session token. No rejoin, no
        // duplicate publications, remote tracks keep rendering.
        this.sfuSession = previousSfuSession?.url === sfuMedia.fallbackUrl && sfuMedia.fallbackUrl
          ? { ...sfuMedia, url: sfuMedia.fallbackUrl } : sfuMedia;
        this.store.setState({ connection: 'connected' });
      } else if (this.mediaPlane === 'sfu' && sfuMedia) {
        // Token expired / SFU session lost: rejoin the same LiveKit room. The
        // SFU engine re-publishes the preserved local tracks and re-subscribes.
        this.startSfu(sfuMedia, true);
      } else if (resumeDecision.keepMedia && this.engine) {
        this.engine.setConfig(config);
        this.engine.reconcilePeers(participants);
      } else {
        // Mesh (or an SFU room that lost its media plane): rebuild peers from
        // the authoritative welcome participant list.
        if (previousPlane === 'sfu') this.stopSfu();
        this.createEngine();
        this.engine?.setConfig(config);
        for (const participant of participants) void this.engine?.addPeer(participant);
      }
    } else {
      this.createEngine();
      if (sfuMedia) this.startSfu(sfuMedia, false);
    }
    this.enterJoinedState();
    if (isReconnect) {
      if (resumeDecision.status === 'restored') {
        this.setResumeStatus('restored');
        this.app.showToast(this.i18n.t('restored'), 'success', 3000);
        this.emitLocal('connection-state', {
          connection: 'connected',
          overall: 'connected',
          resumeStatus: 'restored',
          mediaMode: this.mediaPlane,
          resumed: true,
          reason: resumeDecision.reason,
        });
      } else if (resumeDecision.status === 'failed') {
        // The server could not match the resume capability; this welcome is a
        // fresh join. The call continues, but continuity must not claim success.
        this.setResumeStatus('failed');
      }
    }
    if (!isReconnect) {
      // Announce our display name/locale and the initial media state, so other
      // participants render the right mic/camera badges immediately.
      const settings = this.store.getState().settings;
      this.signaling?.send({ type: 'hello', name: welcome.self.name, locale: this.i18n.current });
      this.signaling?.send({
        type: 'state',
        state: {
          mic: settings.micEnabled ? 'on' : 'off',
          cam: settings.camEnabled ? 'on' : 'off',
          screen: false,
          handRaised: false,
        },
      });
    }
    if (welcome.self.location) this.updateParticipantLocation(welcome.self.id, welcome.self.location);
    this.startTimers();
    this.updateMessengerLayout(participants.length);
    this.startOptionalFeatures();
    this.rememberBreakoutNames();
  }

  private createEngine(): void {
    if (!this.signaling) return;
    if (!this.controllersReady) {
      this.createControllers();
      this.controllersReady = true;
    }
    // SFU rooms keep the WS control plane but must not open mesh RTCPeerConnections.
    if (this.mediaPlane === 'sfu') return;
    this.createMeshEngine();
  }

  /** Mesh media plane: one RTCPeerConnection per remote participant (≤ 8). */
  private createMeshEngine(): void {
    if (!this.signaling || this.engine) return;
    this.engine = new WebRtcEngine({
      selfId: this.selfId,
      config: this.config,
      iceServers: this.iceServers,
      iceTransportPolicy: this.options.relayOnly ? 'relay' : this.options.iceTransportPolicy ?? 'all',
      signaling: this.signaling,
      callbacks: {
        onRemoteStream: (participantId, stream) => {
          const current = this.store.getState().remoteStreams;
          if (!stream || stream.getTracks().length === 0) {
            // Never store an empty stream: it would resurrect a departed id.
            if (!(participantId in current)) return;
            const streams = { ...current };
            delete streams[participantId];
            this.store.setState({ remoteStreams: streams });
            this.dropAudioLevel(participantId);
            this.emitLocal('remote-stream', { participantId, stream: null });
            return;
          }
          const streams = { ...current, [participantId]: stream };
          this.store.setState({ remoteStreams: streams });
          this.setupAudioLevels();
          this.emitLocal('remote-stream', { participantId, stream });        },
        onPeerRemoved: (participantId) => {
          const streams = { ...this.store.getState().remoteStreams };
          if (!(participantId in streams)) return;
          delete streams[participantId];
          this.store.setState({ remoteStreams: streams });
          this.dropAudioLevel(participantId);
          this.emitLocal('remote-stream', { participantId, stream: null });
        },
        onConnectionState: (overall) => {
          const connection =
            overall === 'connected' || overall === 'idle'
              ? 'connected'
              : overall === 'failed' || overall === 'disconnected'
                ? 'reconnecting'
                : 'connecting';
          this.store.setState({ connection });
          this.emitLocal('connection-state', { connection, overall });
        },
        onQuality: (decision, snapshot) => this.onQuality(decision, snapshot),
        onNegotiationError: (participantId, error) => console.warn(`[agil] negotiation error with ${participantId}`, error),
        onIceRestart: () => {
          this.iceRestartCount += 1;
        },
        onRelayStatus: (status) => {
          this.root.dataset.agilRelay = status;
          if (status === 'connecting' && !this.relayNoticeShown) {
            this.relayNoticeShown = true;
            this.app.showToast(this.i18n.t('turnFallbackConnecting'), 'info', 6000);
          } else if (status === 'failed') {
            this.app.showToast(this.i18n.t('turnFallbackFailed'), 'warning', 8000);
          }
        },
        onIceInfo: (info) => this.store.setState({ iceInfo: info }),
      },
    });
    const localStream = this.store.getState().localStream;
    this.engine.setLocalStream(localStream);
    this.engine.startStatsLoop();
    for (const participant of this.store.getState().participants) void this.engine.addPeer(participant);
  }

  /** WS-only controllers shared by mesh and SFU rooms (chat, captions, AI, recording). */
  private createControllers(): void {
    if (!this.signaling) return;
    this.chat = new ChatController({
      signaling: this.signaling,
      api: this.api,
      getConfig: () => this.config,
      roomId: this.roomId,
      self: () => {
        const self = this.store.getState().self;
        return self ? { id: self.id, name: self.name, role: self.role } : null;
      },
      onMessage: (message) => this.appendChat(message),
      onSystem: (message) => this.appendChat(message),
      onError: (message) => this.app.showToast(this.chatErrorMessage(message), 'warning'),
      onFileUploadProgress: (uploading) => this.app.setChatUploading?.(uploading),
    });
    this.assistant = new AssistantController({
      signaling: this.signaling,
      onChange: () => this.syncAssistantState(),
      onDenied: () => this.app.showToast(this.config.session.knowledgeAgent.denyMessage || this.i18n.t('assistantForbidden'), 'warning'),
    });
    this.captions = new CaptionsController({
      getConfig: () => this.config,
      signaling: this.signaling,
      api: this.api,
      language: this.captionsLanguage(),
      translateTo: this.config.session.transcription.translateTo,
      getAudioTrack: () => this.media.audioTrack,
      getConsent: () => this.api.getTranscriptConsent(this.roomId),
      onConsentRequired: async (provider) => {
        const prompt = provider === 'browser' ? 'transcriptBrowserConsentPrompt' : 'transcriptConsentPrompt';
        const granted = typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(this.i18n.t(prompt))
          : false;
        if (!granted) {
          this.app.showToast(this.i18n.t('transcriptConsentDenied'), 'warning', 4000);
          return false;
        }
        try {
          await this.api.setTranscriptConsent(this.roomId, true);
          return true;
        } catch {
          return false;
        }
      },
      onInterim: (text) => {
        const state = this.store.getState();
        const self = state.self;
        const entry = {
          id: 'interim',
          participantId: self?.id ?? 'self',
          participantName: self?.name ?? this.i18n.t('you'),
          text,
          isFinal: false,
          ts: Date.now(),
          start: state.durationSec,
        };
        const captions = state.captions.filter((caption) => caption.id !== 'interim');
        this.store.setState({ captions: [...captions, entry].slice(-50) });
      },
      onFinal: (segment) => this.addTranscript(segment),
      onStatus: (status) => {
        this.store.patchSection('capabilities', { captions: status.available });
        if (status.error === 'stt_unavailable' || status.error === 'provider_failed') {
          this.app.showToast(this.i18n.t('sttUnavailable'), 'warning');
        }
      },
    });
    this.integrity = new IntegrityChecker({
      config: this.config,
      signaling: this.signaling,
      api: this.api,
      roomId: this.roomId,
      getVideoTrack: () => this.media.videoTrack,
      getVideoElement: () => this.root.querySelector<HTMLVideoElement>('[data-agil-tile][data-self="true"] video'),
      onResult: (status, score, flags) => this.updateIntegrity(this.selfId, status, score, flags),
      onChallenge: (task, state) => {
        if (state === 'running' && task) this.app.showToast(this.livenessText(task), 'info', 5000);
        else if (state === 'success') this.app.showToast(this.i18n.t('livenessSuccess'), 'success');
        else if (state === 'failed') this.app.showToast(this.i18n.t('livenessFailed'), 'warning');
        else if (state === 'unavailable') this.app.showToast(this.i18n.t('livenessUnavailable'), 'warning');
      },
      onNote: (key) => {
        if (key === 'livenessUnavailable') this.app.showToast(this.i18n.t('livenessUnavailable'), 'warning');
        if (key === 'livenessServerUnavailable') this.app.showToast(this.i18n.t('livenessServerUnavailable'), 'warning');
      },
    });
    this.recorder = new CallRecorder({
      config: this.config,
      api: this.api,
      onError: (message) => this.app.showToast(this.recordingErrorMessage(message), 'error'),
    });
    this.recorder.roomId = this.roomId;
  }

  /* ------------------------------------------------------------------ */
  /* SFU media plane                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Starts (or restarts) the LiveKit media plane. The WS control plane stays
   * untouched: chat, presence, captions, assistant, polls, lobby and breakout
   * keep working exactly as in mesh rooms.
   */
  private startSfu(session: SfuMediaSession, isReconnect: boolean): void {
    if (this.destroyed) return;
    this.mediaPlane = 'sfu';
    this.sfuSession = session;
    // A mesh engine from a previous session/welcome must never linger in SFU mode.
    this.engine?.close();
    this.engine = null;
    this.sfu?.dispose();
    this.sfu = null;
    const settings = this.store.getState().settings;
    this.store.setState({ remoteStreams: {}, connection: 'connecting', e2ee: session.e2ee ? { status: 'enabling', keyIndex: session.e2ee.keyIndex } : { status: 'disabled' } });
    this.store.patchSection('settings', {
      mediaMode: this.store.getState().room?.mediaMode === 'broadcast' ? 'broadcast' : 'sfu',
      sfuStatus: 'connecting',
      viewer: !session.canPublish || settings.viewer,
    });
    const sfu = new SfuEngine({
      session,
      selfId: this.selfId,
      config: this.config,
      audioTrack: this.media.audioTrack,
      videoTrack: this.media.videoTrack,
      screenTrack: this.store.getState().screenStream?.getVideoTracks()[0] ?? null,
      screenAudioTrack: this.store.getState().screenStream?.getAudioTracks()[0] ?? null,
      videoOverride: this.blurProcessor?.track ?? null,
      micEnabled: settings.micEnabled && session.canPublish,
      camEnabled: settings.camEnabled && session.canPublish,
      maxVideoSubscriptions: this.store.getState().gallery.maxVideoSubscriptions,
      registerAudioOutput: (element) => this.audioOutput.register(element),
      callbacks: {
        onLocalStream: (stream) => {
          if (this.sfu !== sfu) return;
          if (stream.getTracks().length > 0) this.store.setState({ localStream: stream });
        },
        onRemoteStream: (participantId, stream) => {
          if (this.sfu !== sfu) return;
          const current = this.store.getState().remoteStreams;
          if (!stream || stream.getTracks().length === 0) {
            if (!(participantId in current)) return;
            const streams = { ...current };
            delete streams[participantId];
            this.store.setState({ remoteStreams: streams });
            this.dropAudioLevel(participantId);
            this.emitLocal('remote-stream', { participantId, stream: null });
            return;
          }
          const streams = { ...current, [participantId]: stream };
          this.store.setState({ remoteStreams: streams });
          void this.setupAudioLevels();
          this.emitLocal('remote-stream', { participantId, stream });
        },
        onRemoteStreamRemoved: (participantId) => {
          if (this.sfu !== sfu) return;
          const streams = { ...this.store.getState().remoteStreams };
          if (!(participantId in streams)) return;
          delete streams[participantId];
          this.store.setState({ remoteStreams: streams });
          this.dropAudioLevel(participantId);
          this.emitLocal('remote-stream', { participantId, stream: null });
        },
        onParticipantJoined: (participantId, name) => {
          if (this.sfu !== sfu) return;
          this.handleSfuParticipantJoined(participantId, name);
        },
        onParticipantLeft: (participantId) => {
          if (this.sfu !== sfu) return;
          this.handleSfuParticipantLeft(participantId);
        },
        onParticipantState: (participantId, patch) => {
          if (this.sfu !== sfu) return;
          const state = this.store.getState();
          if (!state.participants.some((participant) => participant.id === participantId)) return;
          this.applyParticipantState(participantId, { mic: patch.mic, cam: patch.cam, screen: patch.screen });
        },
        onE2EE: (status, detail) => {
          if (this.sfu !== sfu) return;
          this.store.setState({ e2ee: { status, keyIndex: detail?.keyIndex, error: detail?.error } });
          if (status === 'enabled') this.app.showToast(this.i18n.t('e2eeEnabledToast'), 'success', 3500);
          if (status === 'failed') this.app.showToast(this.i18n.t('e2eeFailed'), 'error', 10000);
        },
        onSpeaking: (participantId, speaking) => {
          if (this.sfu !== sfu) return;
          this.app.setSpeaking(participantId, speaking);
        },
        onActiveSpeaker: (participantId) => {
          if (this.sfu !== sfu) return;
          this.followSpeakingParticipant(participantId);
        },
        onConnectionState: (state) => {
          if (this.sfu !== sfu) return;
          this.handleSfuConnectionState(state);
        },
        onQuality: (decision, snapshot) => {
          if (this.sfu !== sfu) return;
          this.onQuality(decision, snapshot);
        },
        onDisconnected: (reason) => {
          if (this.sfu !== sfu) return;
          this.handleSfuFailure(reason, 'disconnected');
        },
        onError: (error) => {
          if (this.sfu !== sfu) return;
          if (Date.now() - this.lastSfuErrorAt < 5000) return;
          this.lastSfuErrorAt = Date.now();
          console.warn(`[agil] sfu: ${error.code}`);
          if (error.code === 'publish_failed') {
            this.app.showToast(this.i18n.t('sfuPublishFailed'), 'warning', 4000);
          }
        },
      },
    });
    this.sfu = sfu;
    sfu.setVideoQuality(this.store.getState().settings.videoQuality);
    // Apply the page/pin/speaker policy before the room finishes connecting:
    // the engine replays it when publications arrive, and never auto-subscribes
    // 200 videos in the meantime.
    this.syncSfuSubscriptions();
    void sfu
      .connect()
      .then(() => {
        if (this.sfu !== sfu) return;
        this.store.patchSection('settings', { sfuStatus: 'connected' });
        this.store.setState({ connection: 'connected' });
        this.emitLocal('connection-state', { connection: 'connected', overall: 'connected', mediaMode: 'sfu' });
        this.syncGallery();
        this.syncSfuSubscriptions();
        if (!isReconnect) this.app.showToast(this.i18n.t('sfuConnected'), 'success', 1800);
      })
      .catch((error: unknown) => {
        if (this.sfu !== sfu) return;
        const code = error instanceof SfuError ? error.code : 'connect_failed';
        if (code === 'e2ee_failed') {
          this.store.setState({ e2ee: { status: 'failed', error: 'e2ee_failed' } });
          this.app.showToast(this.i18n.t('e2eeFailed'), 'error', 12000, [
            { label: this.i18n.t('sfuRetry'), onClick: () => void this.retrySfu() },
          ]);
          return;
        }
        this.handleSfuFailure(code, 'connect_failed');
      });
  }

  private handleSfuConnectionState(state: SfuConnectionState): void {
    if (state === 'connected') {
      this.pendingMeshSignals.length = 0;
      this.store.patchSection('settings', { sfuStatus: 'connected' });
      this.store.setState({ connection: 'connected' });
      this.emitLocal('connection-state', { connection: 'connected', overall: 'connected', mediaMode: 'sfu' });
      this.syncGallery();
      this.syncSfuSubscriptions();
      return;
    }
    if (state === 'reconnecting') {
      this.store.patchSection('settings', { sfuStatus: 'reconnecting' });
      this.store.setState({ connection: 'reconnecting' });
      this.emitLocal('connection-state', { connection: 'reconnecting', overall: 'reconnecting', mediaMode: 'sfu' });
      return;
    }
    if (state === 'connecting') {
      this.store.patchSection('settings', { sfuStatus: 'connecting' });
    }
  }

  private handleSfuParticipantJoined(participantId: string, name: string | undefined): void {
    if (participantId === this.selfId) return;
    const state = this.store.getState();
    if (state.participants.some((participant) => participant.id === participantId)) return;
    const participant: Participant = {
      id: participantId,
      name: name?.trim() || this.i18n.t('participant'),
      role: 'guest',
      joinedAt: Date.now(),
      state: { mic: 'off', cam: 'off', screen: false, handRaised: false, network: 'good' },
      verified: false,
      integrity: 'unknown',
    };
    this.store.setState({ participants: [...state.participants, participant] });
    this.syncGallery();
  }

  private handleSfuParticipantLeft(participantId: string): void {
    // WS presence is authoritative: keep the row until `peer-left` arrives when
    // the participant is known to the signaling plane.
    if (this.wsPeerIds.has(participantId)) return;
    const state = this.store.getState();
    if (!state.participants.some((participant) => participant.id === participantId)) return;
    this.dropAudioLevel(participantId);
    this.store.setState({ participants: state.participants.filter((participant) => participant.id !== participantId) });
    this.syncGallery();
  }

  private handleSfuFailure(code: string, kind: 'connect_failed' | 'disconnected'): void {
    if (!this.joined || this.destroyed) return;
    const session = this.sfuSession;
    const recoverable = code === 'connect_failed' || ['token_expired', 'disconnected', 'unknown_reason', 'server_shutdown',
      'state_mismatch', 'join_failure', 'signal_close', 'connection_timeout', 'media_failure'].includes(code);
    if (recoverable && this.signaling?.isOpen && session?.fallbackUrl && session.fallbackUrl !== session.url) {
      if (session.expiresAt > Date.now() + 5000) this.startSfu({ ...session, url: session.fallbackUrl }, true);
      else if (!this.sfuRetrying) void this.recoverExpiredSfu(session, this.signaling, code, kind);
      return;
    }
    this.reportSfuFailure(code, kind);
  }

  private async recoverExpiredSfu(session: SfuMediaSession, signaling: SignalingClient, code: string,
    kind: 'connect_failed' | 'disconnected'): Promise<void> {
    this.sfuRetrying = true;
    this.handleSfuConnectionState('reconnecting');
    try {
      const fresh = await signaling.refreshSfu();
      if (!this.joined || this.destroyed || this.signaling !== signaling || this.sfuSession !== session) return;
      if (fresh?.room === session.room && fresh.expiresAt > Date.now() + 5000 && (!session.e2ee || fresh.e2ee)) {
        this.startSfu({ ...fresh, url: fresh.fallbackUrl ?? fresh.url }, true);
      } else {
        this.reportSfuFailure(code, kind);
      }
    } finally {
      this.sfuRetrying = false;
    }
  }

  private reportSfuFailure(code: string, kind: 'connect_failed' | 'disconnected'): void {
    // Never silently downgrade E2EE media to plaintext mesh.
    if (this.sfuSession?.e2ee) {
      this.store.patchSection('settings', { sfuStatus: 'failed' });
      this.store.setState({ e2ee: { status: 'failed', error: code }, connection: 'reconnecting' });
      this.app.showToast(this.i18n.t('e2eeFailed'), 'error', 12000, [
        { label: this.i18n.t('sfuRetry'), onClick: () => void this.retrySfu() },
      ]);
      return;
    }
    console.warn(`[agil] sfu ${kind} (${code})`);
    this.store.patchSection('settings', { sfuStatus: 'failed' });
    this.store.setState({ connection: 'reconnecting' });
    this.emitLocal('connection-state', { connection: 'reconnecting', overall: 'disconnected', mediaMode: 'sfu' });
    const self = this.store.getState().self;
    const total = this.store.getState().participants.length + (self ? 1 : 0);
    // Small rooms can silently continue on the mesh plane; large ones cannot.
    if (total <= 8 && this.signaling?.isOpen) {
      this.fallbackToMesh(code);
      return;
    }
    this.app.showToast(this.i18n.t('sfuUnavailable'), 'error', 12000, [
      { label: this.i18n.t('sfuRetry'), onClick: () => void this.retrySfu() },
    ]);
  }

  private fallbackToMesh(reason: string): void {
    const sfu = this.sfu;
    this.sfu = null;
    this.sfuSession = null;
    this.mediaPlane = 'mesh';
    sfu?.dispose();
    this.store.patchSection('settings', { mediaMode: 'mesh', sfuStatus: 'off', viewer: false });
    this.store.setState({ remoteStreams: {}, connection: 'connecting' });
    this.createMeshEngine();
    for (const message of this.pendingMeshSignals.splice(0)) {
      if (this.wsPeerIds.has(message.from)) this.handleServerMessage(message);
    }
    this.app.showToast(this.i18n.t('sfuFallbackMesh'), 'warning', 10_000);
    console.info(`[agil] sfu → mesh fallback (${reason})`);
  }

  /** Reconnects the media plane: reuses a valid token, otherwise refreshes welcome. */
  private async retrySfu(): Promise<void> {
    if (this.sfuRetrying || this.destroyed || !this.joined) return;
    this.sfuRetrying = true;
    this.store.patchSection('settings', { sfuStatus: 'connecting' });
    try {
      const session = this.sfuSession;
      if (session && session.expiresAt > Date.now() + 10_000) {
        this.startSfu(session, true);
        return;
      }
      const signaling = this.signaling;
      const fresh = await signaling?.refreshSfu();
      if (!this.joined || this.destroyed || this.signaling !== signaling || this.sfuSession !== session) return;
      if (fresh && (!session || (fresh.room === session.room && (!session.e2ee || fresh.e2ee)))) {
        this.startSfu(fresh.fallbackUrl && session?.url === fresh.fallbackUrl
          ? { ...fresh, url: fresh.fallbackUrl } : fresh, true);
        return;
      }
      // Older Core versions do not support refreshing media on the current WS.
      const name = this.store.getState().self?.name ?? this.options.participantName ?? '';
      if (!name) return;
      this.suppressSocketToasts = true;
      try {
        this.signaling?.close('sfu token refresh');
      } catch {
        /* ignore */
      }
      this.signaling = null;
      await this.connectSignaling(name);
    } catch {
      this.store.patchSection('settings', { sfuStatus: 'failed' });
      this.app.showToast(this.i18n.t('sfuUnavailable'), 'error');
    } finally {
      this.suppressSocketToasts = false;
      setTimeout(() => {
        this.sfuRetrying = false;
      }, 1000);
    }
  }

  private stopSfu(): void {
    this.pendingMeshSignals.length = 0;
    const sfu = this.sfu;
    this.sfu = null;
    this.sfuSession = null;
    this.mediaPlane = 'mesh';
    sfu?.dispose();
    this.store.patchSection('settings', { sfuStatus: 'off' });
    this.store.setState({ remoteStreams: {} });
  }

  /**
   * Messenger mode (docs/messenger.md): a 1:1 room (`room.mode = 'direct'`) with
   * exactly two participants defaults to the spotlight layout unless the tenant
   * explicitly configured `layout.mode` (or `options.config.layout.mode`).
   */
  private updateMessengerLayout(participantCount: number): void {
    const state = this.store.getState();
    const localOverride = this.options.config?.layout?.mode;
    let layoutMode = this.config.layout.mode;
    if (localOverride) {
      layoutMode = localOverride;
    } else if (state.room?.mode === 'direct' && participantCount === 1 && this.config.layout.mode === 'grid') {
      layoutMode = 'spotlight';
    }
    if (state.settings.layoutMode !== layoutMode) {
      this.store.patchSection('settings', this.layoutSettings(state, layoutMode));
    }
  }

  private layoutSettings(state: CallState, layoutMode: LayoutMode): Partial<CallSettingsState> {
    const { settings } = state;
    if (settings.layoutMode === layoutMode) return { layoutMode };
    if (layoutMode === 'sidebar' && settings.panel === 'none' && canFeature(state, 'participantList')) {
      return { layoutMode, panel: 'participants' };
    }
    if (settings.layoutMode === 'sidebar' && settings.panel === 'participants') {
      return { layoutMode, panel: 'none' };
    }
    return { layoutMode };
  }

  /** Effective media plane for the room (welcome.room.mediaMode wins over config). */
  private currentMediaMode(): MediaMode {
    if (this.mediaPlane === 'sfu') return this.store.getState().room?.mediaMode === 'broadcast' ? 'broadcast' : 'sfu';
    const room = this.store.getState().room;
    if (room?.mediaMode) return room.mediaMode;
    const scale = this.config.scale;
    if (scale.webinar.enabled && scale.mediaMode !== 'mesh') return 'broadcast';
    return scale.mediaMode;
  }

  /**
   * Webinar/broadcast UI gating (docs/scaling.md): guests become receive-only
   * viewers when the room is a broadcast (or host-only publishing is enforced).
   * Publishing controls are hidden and the API toggles are guarded; chat, raise
   * hand and reactions stay available.
   */
  private updateScaleState(): void {
    const state = this.store.getState();
    const mediaMode = this.currentMediaMode();
    const role = state.self?.role ?? this.options.role ?? 'guest';
    const webinar = this.config.scale.webinar;
    const hostOnlyPublish = webinar.enabled && webinar.hostOnlyPublish && mediaMode !== 'mesh';
    const viewer = role === 'guest' && (mediaMode === 'broadcast' || hostOnlyPublish);
    this.store.patchSection('settings', { mediaMode, viewer });
    if (viewer && this.joined) {
      // UI-level receive-only: stop publishing local tracks and hide media state.
      const stream = this.store.getState().localStream;
      stream?.getTracks().forEach((track) => {
        track.enabled = false;
      });
      const settings = this.store.getState().settings;
      if (settings.micEnabled || settings.camEnabled) {
        this.store.patchSection('settings', { micEnabled: false, camEnabled: false });
      }
      this.engine?.refreshVideoSenders();
      void this.sfu?.disablePublishing();
    }
  }

  /**
   * Removes the join token from the address bar once the call is up. The token
   * still lives in memory for reconnects and is never read back from the URL by
   * the widget, so history/referrer leaks stop while the room stays usable
   * (QA round 15 P3-5). Same-origin iframes (embed.html) are scrubbed too.
   */
  private scrubJoinTokenFromUrl(): void {
    if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') return;
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('token')) return;
      url.searchParams.delete('token');
      window.history.replaceState(window.history.state, '', url.toString());
    } catch {
      /* sandboxed/opaque origins may refuse replaceState — never break the call. */
    }
  }

  private enterJoinedState(): void {
    const firstEntry = !this.joined;
    this.joined = true;
    this.joinedAt = this.pendingJoinedAt ?? Date.now();
    this.pendingJoinedAt = null;
    this.stopLobbyTimers();
    this.lobbyRequestId = null;
    const state = this.store.getState();
    const showParticipants = firstEntry && state.settings.layoutMode === 'sidebar' &&
      state.settings.panel === 'none' && canFeature(state, 'participantList');
    this.store.setState({
      phase: 'joined',
      connection: this.offlineDemo || state.participants.length === 0 ? 'connected' : 'connecting',
      serverOnline: !this.offlineDemo,
      lobby: createInitialLobby(),
      ...(showParticipants ? { settings: { ...state.settings, panel: 'participants' } } : {}),
    });
    this.app.setJoinBusy(false);
    const welcome = state.config.room.welcomeMessage.trim();
    if (firstEntry && welcome) this.app.showToast(welcome, 'info', 7000);
    this.scrubJoinTokenFromUrl();
    // Never persist a short-lived sub-room token as the resumable session.
    if (!this.breakoutMain && (this.persistEnabled || this.config.layout.persistAcrossPages)) this.writeSessionHandoff();
    this.emitLocal('joined', { room: this.store.getState().room, self: this.store.getState().self });
    // Page count/size depends on the participant list and viewport width.
    this.syncGallery();
    // Permissions become authoritative on join; start monitoring with the
    // effective feature set (the track may already be live from pre-join preview).
    this.syncNoiseDetection();
  }

  private writeSessionHandoff(): void {
    const state = this.store.getState();
    writePersistedSession({
      room: this.roomId,
      audioOnly: this.options.audioOnly,
      token: this.joinToken,
      tenantId: this.tenantId,
      participantName: state.self?.name ?? this.options.participantName,
      serverUrl: this.api.base,
      role: state.self?.role ?? this.options.role,
      locale: this.i18n.current,
      theme: this.options.theme,
      savedAt: Date.now(),
    });
  }

  private startTimers(): void {
    if (this.durationTimer) clearInterval(this.durationTimer);
    this.durationTimer = setInterval(() => {
      if (!this.joined) return;
      this.store.setState({ durationSec: Math.floor((Date.now() - this.joinedAt) / 1000) });
    }, 1000);
  }

  private startOptionalFeatures(): void {
    const config = this.config;
    const state = this.store.getState();
    if (canFeature(state, 'captions') && config.session.transcription.enabled && config.session.transcription.provider !== 'off'
        && config.session.transcription.showCaptionsByDefault) {
      this.store.patchSection('settings', { captionsVisible: true });
      void this.captions?.start();
    }
    if (config.security.mediaIntegrity.enabled || config.security.liveness.enabled) {
      this.integrity?.start();
      if (config.security.mediaIntegrity.livenessChallenge || config.security.liveness.enabled) {
        setTimeout(() => void this.integrity?.runLivenessChallenge(), 2500);
      }
    }
    if (config.security.geo.gpsEnabled && !config.security.geo.requireConsent && !this.geoRequested) {
      this.geoRequested = true;
      void this.requestLocation(true);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Server messages                                                    */
  /* ------------------------------------------------------------------ */

  private reviewNotice: HTMLElement | undefined;

  private showConversationReview(message?: Extract<ServerMessage, { type: 'conversation-review' }>): void {
    this.reviewNotice?.remove();
    this.reviewNotice = undefined;
    if (!message?.revision || this.headless) return;
    const ru = this.i18n.current === 'ru';
    const revision = message.revision;
    const makeButton = (label: string, allowed: boolean) => {
      const button = h('button', { class: 'agil-btn agil-btn-ghost', attrs: { type: 'button' }, text: label });
      button.addEventListener('click', () => this.signaling?.send({ type: 'conversation-review.consent', revision, allowed }));
      return button;
    };
    const pending = message.consent === 'pending';
    const allowed = message.consent === 'allowed';
    const text = pending
      ? (ru ? 'Администратор запросил проверку субтитров по корпоративным правилам. Проверка начнётся после согласия всех.'
        : 'The administrator requested a policy review of captions. Review starts when everyone agrees.')
      : allowed ? (ru ? 'Вы согласились на проверку субтитров.' : 'You agreed to caption review.')
        : (ru ? 'Вы отказались от проверки субтитров.' : 'You declined caption review.');
    const actions = h('div', { class: 'agil-review-actions' });
    if (!allowed) actions.append(makeButton(ru ? 'Согласиться' : 'Agree', true));
    if (pending || allowed) actions.append(makeButton(allowed ? (ru ? 'Отозвать согласие' : 'Withdraw consent') : (ru ? 'Отказаться' : 'Decline'), false));
    this.reviewNotice = h('aside', { class: 'agil-review-notice', attrs: { 'aria-label': ru ? 'Проверка субтитров' : 'Caption review' } },
      h('span', { attrs: { role: 'status' }, text }), actions);
    this.root.prepend(this.reviewNotice);
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.showConversationReview();
        this.handleWelcome(message);
        break;
      case 'conversation-review':
        this.showConversationReview(message);
        break;
      case 'pong':
        if (message.iceServers) {
          this.iceServers = withTurnTcp(message.iceServers);
          this.engine?.setIceServers(this.iceServers);
        }
        break;
      case 'sdp':
      case 'ice':
        if (this.engine) {
          if (message.type === 'sdp') void this.engine.handleSdp(message.from, message.description);
          else void this.engine.handleIce(message.from, {
            candidate: message.candidate.candidate,
            sdpMid: message.candidate.sdpMid ?? null,
            sdpMLineIndex: message.candidate.sdpMLineIndex ?? null,
            usernameFragment: message.candidate.usernameFragment ?? null,
          });
        } else if (this.sfuSession && !this.sfuSession.e2ee && this.wsPeerIds.has(message.from)) {
          // A peer may enter mesh before our SFU attempt has failed.
          const status = this.store.getState().settings.sfuStatus;
          if ((status === 'connecting' || status === 'reconnecting') && this.pendingMeshSignals.length < 128) {
            this.pendingMeshSignals.push(message);
          }
        }
        break;
      case 'video-upgrade':
        this.handleVideoUpgrade(message);
        break;
      case 'peer-joined': {
        const state = this.store.getState();
        if (message.participant.id === this.selfId) break;
        this.wsPeerIds.add(message.participant.id);
        const participants = [...state.participants.filter((participant) => participant.id !== message.participant.id), message.participant];
        this.store.setState({ participants });
        this.syncGallery();
        this.updateMessengerLayout(participants.length);
        this.rememberBreakoutNames();
        if (this.mediaPlane === 'mesh') void this.engine?.addPeer(message.participant);
        this.notifyPeer(message.participant.name, true);
        this.emitLocal('participant-joined', message.participant);
        break;
      }
      case 'peer-left': {
        const state = this.store.getState();
        if (state.videoUpgrade?.participantId === message.participantId) this.setVideoUpgrade(null);
        if (this.options.audioOnly && this.videoConsentPeer === message.participantId) {
          this.videoConsentPeer = undefined;
          this.store.setState({ audioOnly: true });
          this.blurProcessor?.stop();
          this.blurProcessor = null;
          this.media.releaseVideoTrack();
          this.store.setState({ localStream: this.media.localStream });
          this.engine?.setLocalStream(this.media.localStream);
          this.store.patchSection('settings', { camEnabled: false });
          this.syncSelfState({ cam: 'off' });
          if (state.settings.screenSharing) void this.stopScreenShare();
        }
        this.wsPeerIds.delete(message.participantId);
        this.pendingMeshSignals = this.pendingMeshSignals.filter((signal) => signal.from !== message.participantId);
        const participant = state.participants.find((entry) => entry.id === message.participantId);
        const remaining = state.participants.filter((entry) => entry.id !== message.participantId);
        this.store.setState({ participants: remaining });
        this.syncRemoteRecording();
        this.syncGallery();
        this.updateMessengerLayout(remaining.length);
        if (this.mediaPlane === 'mesh') this.engine?.removePeer(message.participantId, message.reason);
        else this.sfu?.dropRemoteParticipant(message.participantId);
        if (participant) this.notifyPeer(participant.name, false);
        this.emitLocal('participant-left', { participantId: message.participantId, reason: message.reason });
        break;
      }
      case 'presence': {
        // Continuity: a peer is held in the room during a short blip
        // (`reconnecting`) or is back (`online`). No leave/join pair.
        if (message.participantId === this.selfId) break;
        const participants = this.store
          .getState()
          .participants.map((participant) =>
            participant.id === message.participantId ? { ...participant, presence: message.presence } : participant,
          );
        this.store.setState({ participants });
        break;
      }
      case 'chat':
        this.chat?.ingest(message.message);
        break;
      case 'chat-result':
        this.chat?.handleResult(message);
        break;
      case 'chat-history':
        this.store.setState({ chat: dedupeMessages(message.messages) });
        break;
      case 'state':
        this.applyParticipantState(message.participantId, message.state);
        break;
      case 'reaction': {
        // sendReaction already renders and emits the local participant's reaction.
        if (message.participantId === this.selfId) break;
        const name = this.participantName(message.participantId);
        this.app.showReaction(message.emoji, name);
        this.emitLocal('reaction', {
          emoji: message.emoji,
          participantId: message.participantId,
          name,
          self: false,
        });
        break;
      }
      case 'caption':
        this.addRemoteCaption(message);
        break;
      case 'integrity':
        this.updateIntegrity(message.participantId, message.status, message.score, message.flags);
        break;
      case 'location':
        this.updateParticipantLocation(message.participantId, message.location);
        break;
      case 'lobby.queue':
        if (this.isLobbyManager()) this.store.setState({ lobbyQueue: message.requests });
        break;
      case 'lobby.pending': {
        if (!this.isLobbyManager()) break;
        const queue = this.store.getState().lobbyQueue.filter((request) => request.id !== message.request.id);
        this.store.setState({ lobbyQueue: [...queue, message.request] });
        this.app.showToast(
          `${message.request.name} — ${this.i18n.t('lobbyNewRequest')}`,
          'info',
          8000,
          [{ label: this.i18n.t('lobbyOpenQueue'), onClick: () => this.openPanel('lobby') }],
        );
        break;
      }
      case 'lobby.admitted': {
        if (!this.isLobbyManager()) break;
        const request = this.store.getState().lobbyQueue.find((entry) => entry.id === message.requestId);
        this.removeLobbyRequest(message.requestId);
        // Only notify for decisions made elsewhere (another moderator).
        if (request) {
          this.app.showToast(this.i18n.t('lobbyAdmittedToast', { name: message.participant.name }), 'success', 3200);
        }
        break;
      }
      case 'lobby.rejected': {
        if (!this.isLobbyManager()) break;
        const request = this.store.getState().lobbyQueue.find((entry) => entry.id === message.requestId);
        this.removeLobbyRequest(message.requestId);
        if (request) {
          this.app.showToast(this.i18n.t('lobbyRejectedToast', { name: request.name }), 'info', 3200);
        }
        break;
      }
      case 'poll.updated': {
        const poll = this.mapPoll(message.poll);
        this.emitLocal('poll', poll);
        this.pollsPanel?.handleEvent(poll);
        break;
      }
      case 'whiteboard.open': {
        const by = message.by;
        this.whenCollaborationReady((surface) => surface.whiteboard.applyOpened(by));
        this.syncCollaborationState();
        if (!this.whiteboardPanel?.isOpen() && by.id !== this.selfIdentity().id) {
          this.app.showToast(this.i18n.t('whiteboardOpened'), 'info', 6000, [
            { label: this.i18n.t('whiteboardOpenAction'), onClick: () => this.toggleWhiteboard() },
          ]);
        }
        break;
      }
      case 'whiteboard.close': {
        const wasOpen = this.whiteboardPanel?.isOpen() ?? false;
        const by = message.by;
        const reason = message.reason;
        this.whenCollaborationReady((surface) => surface.whiteboard.applyClosed(by, reason));
        this.syncCollaborationState();
        if (wasOpen) this.app.showToast(this.i18n.t('whiteboardEnded'), 'info', 4000);
        break;
      }
      case 'whiteboard.sync': {
        const snapshot = message.snapshot;
        const reason = message.reason;
        this.whenCollaborationReady((surface) => surface.whiteboard.applySnapshot(snapshot, reason));
        this.syncCollaborationState();
        break;
      }
      case 'whiteboard.stroke': {
        const stroke = message.stroke;
        this.whenCollaborationReady((surface) => surface.whiteboard.applyStroke(stroke));
        this.syncCollaborationState();
        break;
      }
      case 'annotation.sync': {
        const snapshot = message.snapshot;
        this.whenCollaborationReady((surface) => surface.annotation.handleSnapshot(snapshot));
        this.syncCollaborationState();
        break;
      }
      case 'annotation.stroke': {
        const stroke = message.stroke;
        this.whenCollaborationReady((surface) => surface.annotation.handleStroke(stroke));
        this.syncCollaborationState();
        break;
      }
      case 'annotation.clear':
        this.whenCollaborationReady((surface) => surface.annotation.handleClear(message.reason));
        if (message.reason === 'share_ended') {
          const wasActive = this.annotationMode;
          this.annotationMode = false;
          if (wasActive) this.app.showToast(this.i18n.t('annotationsStopped'), 'info', 3200);
        }
        this.syncCollaborationState();
        break;
      case 'breakout.started':
        this.handleBreakoutStarted(message.plan);
        break;
      case 'breakout.assigned':
        void this.handleBreakoutAssigned(message.assignment);
        break;
      case 'breakout.closed':
        this.handleBreakoutClosed(message.plan);
        break;
      case 'room': {
        const selfPermissions = message.participants.find((participant) => participant.id === this.selfId)?.permissions;
        const current = this.store.getState();
        const permissions = selfPermissions ? featureKeys.filter((feature) => selfPermissions.includes(feature)) : current.permissions;
        const lowerHand = current.settings.handRaised && permissions && !permissions.includes('handRaise');
        const panel = current.settings.panel;
        const closePanel = (panel === 'participants' || panel === 'chat') && !this.canOpenPanel(panel, { ...current, permissions });
        const roomParticipants = message.participants.filter((participant) => participant.id !== this.selfId);
        this.wsPeerIds = new Set<string>([this.selfId, ...roomParticipants.map((participant) => participant.id)]);
        this.store.setState({
          room: message.room,
          participants: roomParticipants,
          permissions,
          ...(lowerHand || closePanel ? { settings: {
            ...current.settings,
            ...(lowerHand ? { handRaised: false } : {}),
            ...(closePanel ? { panel: 'none' as const } : {}),
          } } : {}),
          ...(lowerHand ? {
            ...(current.self ? { self: { ...current.self, state: { ...current.self.state, handRaised: false } } } : {}),
          } : {}),
        });
        this.syncRemoteRecording();
        this.updateMessengerLayout(roomParticipants.length);
        this.rememberBreakoutNames();
        break;
      }
      case 'analysis':
        this.notes.setAnalysis({ findings: message.findings, summary: message.summary });
        this.store.setState({
          findings: message.findings,
          notes: this.notes.notes ?? this.notes.buildLocalNotes(this.captionsLanguage()),
        });
        break;
      case 'config': {
        const config = applyLocalOverrides(message.config, this.options.config, this.options.theme);
        this.applyConfig(config, true);
        this.emitLocal('theme-changed', { theme: config.theme });
        break;
      }
      case 'assistant-answer':
        this.assistant?.handleAnswer(message);
        break;
      case 'error': {
        if (message.code === 'rate_limited') this.app.showToast(this.i18n.t('rateLimited'), 'warning');
        const errorText = `${message.code} ${message.message}`.toLowerCase();
        if (errorText.includes('moder')) {
          this.chat?.systemMessage(this.i18n.t('chatModerationPending'));
          this.app.showToast(this.i18n.t('chatModerationPending'), 'info', 4000);
        }
        this.emitLocal('error', message);
        break;
      }
      case 'bye':
        if (message.reason === 'duration_expired') {
          this.leave();
          this.app.showToast(this.i18n.t('callDurationReached'), 'info', 7000);
          break;
        }
        if (this.breakoutMain && this.roomId !== this.breakoutMain.roomId) {
          // The host closed breakouts: the child room is closed with `bye`.
          if (!this.isBreakoutManager()) {
            this.app.showToast(this.i18n.t('breakoutClosedByServer'), 'info', 4000);
          }
          void this.returnToMainRoom({ viaApi: false, silent: true });
          break;
        }
        this.app.showToast(this.i18n.t('youLeft'), 'info');
        this.leave();
        break;
      default:
        break;
    }
  }

  private notifyPeer(name: string, joined: boolean): void {
    if (this.app.showParticipantNotice) this.app.showParticipantNotice(name, joined);
    else this.app.showToast(`${name} ${this.i18n.t(joined ? 'participantJoined' : 'participantLeft')}`, 'info', 2600);
    const audio = this.participantSound;
    const now = performance.now();
    if (!this.joined || !this.config.room.soundOnJoinLeave || !audio || now - this.lastParticipantSoundAt < 600) return;
    this.lastParticipantSoundAt = now;
    audio.src = joined ? participantJoinSound : participantLeaveSound;
    // A browser may require a gesture before playing audio in an auto-joined call.
    void audio.play().catch(() => undefined);
  }

  private participantName(participantId: string): string {
    const state = this.store.getState();
    if (participantId === this.selfId) return state.self?.name ?? this.i18n.t('you');
    return state.participants.find((participant) => participant.id === participantId)?.name ?? this.i18n.t('participant');
  }

  private applyParticipantState(participantId: string, patch: Partial<ParticipantState>): void {
    const state = this.store.getState();
    const participants = state.participants.map((participant) =>
      participant.id === participantId ? { ...participant, state: { ...participant.state, ...patch } } : participant,
    );
    this.store.setState({ participants });
    // Recording is broadcast as participant state (P2): keep the guest-side
    // persistent indicator in sync with start/stop frames.
    this.syncRemoteRecording();
  }

  /** Derives the remote recording indicator from the current participant list. */
  private syncRemoteRecording(): void {
    const state = this.store.getState();
    const patch = remoteRecordingPatch(state.recording, state.participants);
    if (patch) this.store.patchSection('recording', patch);
  }

  private updateParticipantLocation(participantId: string, location: Participant['location']): void {
    if (!location) return;
    if (participantId === this.selfId) {
      const self = this.store.getState().self;
      if (self) this.store.setState({ self: { ...self, location } });
      return;
    }
    const participants = this.store.getState().participants.map((participant) =>
      participant.id === participantId ? { ...participant, location } : participant,
    );
    this.store.setState({ participants });
  }

  private addRemoteCaption(message: Extract<ServerMessage, { type: 'caption' }>): void {
    const state = this.store.getState();
    const translation = message.translation
      ? {
          text: message.translation,
          lang: message.translationLang ?? 'en',
          provider: message.translationProvider ?? ('local' as const),
        }
      : undefined;
    if (message.translated && translation) {
      // Follow-up frame: attach the translation to the stored segment/caption
      // instead of adding a duplicate row. `segmentId` is authoritative; the
      // text fallback covers the sender's locally-added copy.
      const canUpdateHistory = state.config.session.transcription.saveTranscript && Boolean(message.segmentId);
      let index = canUpdateHistory ? state.transcripts.findIndex((segment) => segment.id === message.segmentId) : -1;
      if (index < 0 && canUpdateHistory) {
        for (let cursor = state.transcripts.length - 1; cursor >= 0; cursor -= 1) {
          const candidate = state.transcripts[cursor];
          if (candidate && candidate.participantId === message.participantId && candidate.text === message.text) {
            index = cursor;
            break;
          }
        }
      }
      const transcripts =
        index >= 0
          ? state.transcripts.map((segment, cursor) => (cursor === index ? { ...segment, translation } : segment))
          : state.transcripts;
      const captions = state.captions.map((caption) =>
        caption.participantId === message.participantId && caption.text === message.text
          ? { ...caption, translation: translation.text, translationLang: translation.lang }
          : caption,
      );
      this.store.setState({ transcripts, captions });
      return;
    }
    const entry = {
      id: message.segmentId ?? `caption-${message.participantId}-${message.ts}`,
      participantId: message.participantId,
      participantName: this.participantName(message.participantId),
      text: message.text,
      isFinal: message.isFinal,
      ts: message.ts,
      start: state.durationSec,
      ...(translation ? { translation: translation.text, translationLang: translation.lang } : {}),
    };
    this.store.setState({ captions: [...state.captions, entry].slice(-50) });
    if (message.isFinal && message.segmentId && state.config.session.transcription.saveTranscript) {
      const segment = {
        id: entry.id,
        participantId: message.participantId,
        participantName: entry.participantName,
        text: message.text,
        start: entry.start,
        end: entry.start,
        isFinal: true,
        ts: message.ts,
      };
      const transcripts = [...state.transcripts, segment].slice(-500);
      this.store.setState({ transcripts });
      this.notes.addSegment(segment);
      this.refreshLocalNotes();
    }
  }

  private addTranscript(segment: {
    text: string;
    start: number;
    end: number;
    isFinal: boolean;
    lang?: 'ru' | 'en';
    translation?: TranscriptSegment['translation'];
  }): void {
    const state = this.store.getState();
    const self = state.self;
    const full = {
      id: `self-${Date.now()}`,
      participantId: self?.id ?? 'self',
      participantName: self?.name ?? this.i18n.t('you'),
      text: segment.text,
      start: segment.start,
      end: segment.end,
      isFinal: segment.isFinal,
      lang: segment.lang,
      ts: Date.now(),
      ...(segment.translation ? { translation: segment.translation } : {}),
    };
    const saveTranscript = state.config.session.transcription.saveTranscript;
    this.store.setState({
      ...(saveTranscript ? { transcripts: [...state.transcripts, full].slice(-500) } : {}),
      captions: [
        ...state.captions,
        {
          id: full.id,
          participantId: full.participantId,
          participantName: full.participantName,
          text: full.text,
          isFinal: true,
          ts: full.ts,
          start: full.start,
          ...(segment.translation
            ? { translation: segment.translation.text, translationLang: segment.translation.lang }
            : {}),
        },
      ].slice(-50),
    });
    if (!saveTranscript) return;
    this.notes.addSegment(full);
    this.refreshLocalNotes();
  }

  private refreshLocalNotes(): void {
    const state = this.store.getState();
    if (this.notes.notes) return;
    const local = this.notes.buildLocalNotes(this.captionsLanguage());
    if (local) this.store.setState({ notes: local });
  }

  private updateIntegrity(participantId: string, status: Participant['integrity'], score?: number, flags: string[] = []): void {
    const state = this.store.getState();
    const integrity = {
      ...state.integrity,
      [participantId]: { status, score: score ?? 0, flags },
    };
    this.store.setState({ integrity });
    const participants = state.participants.map((participant) =>
      participant.id === participantId ? { ...participant, integrity: status } : participant,
    );
    const self = state.self && state.self.id === participantId ? { ...state.self, integrity: status } : state.self;
    this.store.setState({ participants, self });
    if (
      participantId === this.selfId &&
      status === 'suspicious' &&
      this.config.security.mediaIntegrity.autoMuteOnHighRisk &&
      this.store.getState().settings.micEnabled
    ) {
      void this.toggleMic(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Quality                                                            */
  /* ------------------------------------------------------------------ */

  private onQuality(decision: QualityDecision, snapshot: QualitySnapshot): void {
    this.qualityTier = decision.tier;
    this.store.setState({
      quality: {
        tier: decision.tier,
        score: decision.score,
        rttMs: snapshot.rttMs,
        packetLossPct: snapshot.packetLossPct,
        jitterMs: snapshot.jitterMs,
        inboundBitrateKbps: snapshot.inboundBitrateKbps,
        availableOutgoingBitrateKbps: snapshot.availableOutgoingBitrateKbps ?? 0,
        fps: snapshot.fps,
        width: snapshot.width,
        height: snapshot.height,
      },
    });
    const degraded = decision.actions.showBanner || decision.actions.chatFallback || decision.tier === 'poor' || decision.tier === 'critical' || decision.tier === 'offline';
    this.store.patchSection('settings', { degraded });
    this.emitLocal('quality-changed', { decision, snapshot });
  }

  /* ------------------------------------------------------------------ */
  /* Media / controls                                                   */
  /* ------------------------------------------------------------------ */

  private applyLocalTrackState(): void {
    const state = this.store.getState();
    const stream = state.localStream;
    const audio = stream?.getAudioTracks()[0];
    const video = stream?.getVideoTracks()[0];
    if (audio) audio.enabled = state.settings.micEnabled;
    if (video) video.enabled = state.settings.camEnabled;
  }

  /**
   * Host-facing error event: locale-independent `code` plus already-localized
   * text, so integrators never see raw internal messages or codes in the UI.
   */
  private mediaErrorEvent(error: MediaAccessError, device: 'camera' | 'microphone'): { code: string; message: string } {
    const document = this.root.ownerDocument as Document & { featurePolicy?: { allowsFeature(feature: string): boolean } };
    const blockedByPage = error.code === 'permission_denied' && document.featurePolicy?.allowsFeature(device) === false;
    const key = blockedByPage
      ? device === 'camera' ? 'mediaCameraBlockedBySite' : 'mediaMicrophoneBlockedBySite'
      : error.messageKey;
    return { code: error.code, message: this.i18n.t(key) };
  }

  private handleCaptureEnded(kind: 'audio' | 'video'): void {
    const settings = this.store.getState().settings;
    if (kind === 'audio') {
      this.stopNoiseDetection();
      this.dropAudioLevel(this.selfId);
      void this.sfu?.setAudioTrack(null, false);
      this.store.patchSection('settings', { micEnabled: false });
      this.syncSelfState({ mic: 'off' });
      this.emitLocal('media-state', { mic: false });
      if (settings.micEnabled) this.app.showToast(this.i18n.t('mediaMicrophoneUnavailable'), 'warning');
    } else {
      this.blurProcessor?.stop();
      this.blurProcessor = null;
      this.engine?.setVideoOverride(null);
      void this.sfu?.setCameraTrack(null, false);
      void this.sfu?.setVideoOverride(null);
      this.store.patchSection('settings', { camEnabled: false, blurDegraded: false });
      this.syncSelfState({ cam: 'off' });
      this.emitLocal('media-state', { cam: false });
      if (settings.camEnabled) this.app.showToast(this.i18n.t('mediaCameraUnavailable'), 'warning');
    }
    this.engine?.setLocalStream(this.media.localStream);
    this.applySelfPreviewVideo(this.blurProcessor?.track ?? null);
    if (this.app instanceof WidgetApp) this.app.refreshDeviceOptions();
  }

  /** A deliberate re-enable can use the system default after an unplug. */
  private async requestCapture(kind: 'audio' | 'video', deviceId: string | null): Promise<{
    track: MediaStreamTrack;
    usedDefault: boolean;
  }> {
    const request = (id: string | null) => kind === 'audio'
      ? this.media.requestAudio(this.config, id)
      : this.media.requestVideo(this.config, id);
    try {
      return { track: await request(deviceId), usedDefault: false };
    } catch (error) {
      if (!deviceId || mapMediaError(error).code !== 'not_found') throw error;
      const devices = await this.media.enumerate().catch(() => null);
      const candidates = kind === 'audio' ? devices?.microphones : devices?.cameras;
      if (!candidates?.some((device) => device.deviceId) || candidates.some((device) => device.deviceId === deviceId)) {
        throw error;
      }
      return { track: await request(null), usedDefault: true };
    }
  }

  async toggleMic(force?: boolean): Promise<boolean> {
    const state = this.store.getState();
    if (state.settings.viewer) {
      this.app.showToast(this.i18n.t('viewerHintRaise'), 'warning');
      return false;
    }
    if (!canFeature(state, 'chat') && state.phase !== 'joined') return state.settings.micEnabled;
    const next = force ?? !state.settings.micEnabled;
    if (next) {
      if (!this.media.audioTrack) {
        try {
          const epoch = this.sessionEpoch;
          const { track, usedDefault } = await this.requestCapture('audio', state.settings.micDeviceId);
          if (epoch !== this.sessionEpoch) {
            track.stop();
            return false;
          }
          track.enabled = true;
          this.media.adoptAudioTrack(track);
          const stream = state.localStream ?? new MediaStream();
          if (!stream.getAudioTracks().some((existing) => existing.id === track.id)) stream.addTrack(track);
          this.store.setState({ localStream: stream, mediaError: null });
          if (usedDefault) this.store.patchSection('settings', { micDeviceId: null });
          this.engine?.setLocalStream(stream);
          this.engine?.refreshAudioSenders();
          void this.sfu?.setAudioTrack(track, true);
          void this.setupAudioLevels();
        } catch (error) {
          const detail = this.mediaErrorEvent(mapMediaError(error), 'microphone');
          this.app.showToast(detail.message, 'warning');
          this.emitLocal('error', detail);
          return false;
        }
      } else {
        this.media.audioTrack.enabled = true;
        void this.sfu?.setAudioTrack(this.media.audioTrack, true);
      }
    } else if (this.media.audioTrack) {
      this.media.audioTrack.enabled = false;
      void this.sfu?.setAudioTrack(this.media.audioTrack, false);
    }
    this.store.patchSection('settings', { micEnabled: next });
    this.syncSelfState({ mic: next ? 'on' : 'off' });
    this.app.showToast(next ? this.i18n.t('micEnabledToast') : this.i18n.t('micDisabledToast'), 'info', 1800);
    this.emitLocal('media-state', { mic: next });
    this.syncNoiseDetection();
    return next;
  }

  private videoUpgradePeer(): Participant | undefined {
    const state = this.store.getState();
    if (state.phase !== 'joined' || state.wsState !== 'open' || state.room?.mode !== 'direct' ||
        this.currentMediaMode() !== 'mesh' || state.settings.viewer || state.participants.length !== 1) return undefined;
    return state.participants[0];
  }

  private setVideoUpgrade(upgrade: NonNullable<CallState['videoUpgrade']> | null): void {
    clearTimeout(this.videoUpgradeTimer);
    this.videoUpgradeTimer = undefined;
    const state = this.store.getState();
    if (state.videoUpgrade?.direction === 'incoming') {
      const peer = state.participants.find((participant) => participant.id === state.videoUpgrade?.participantId);
      if (peer) this.app.toasts.dismissMessage?.(this.i18n.t('videoUpgradeIncoming', { name: peer.name }));
    }
    this.store.setState({ videoUpgrade: upgrade });
    if (!upgrade) return;
    this.videoUpgradeTimer = setTimeout(() => {
      this.setVideoUpgrade(null);
      if (upgrade.direction === 'outgoing') this.app.showToast(this.i18n.t('videoUpgradeExpired'));
    }, VIDEO_UPGRADE_TTL_MS);
  }

  requestVideoUpgrade(): boolean {
    const state = this.store.getState();
    const peer = this.videoUpgradePeer();
    if (!state.audioOnly || state.videoUpgrade || !peer) return false;
    const requestId = crypto.randomUUID();
    if (!this.signaling?.send({ type: 'video-upgrade', to: peer.id, requestId, action: 'request' })) return false;
    this.setVideoUpgrade({ requestId, participantId: peer.id, direction: 'outgoing' });
    this.app.showToast(this.i18n.t('videoUpgradeWaiting'));
    return true;
  }

  async respondToVideoUpgrade(requestId: string, accept: boolean): Promise<boolean> {
    const pending = this.store.getState().videoUpgrade;
    if (pending?.direction !== 'incoming' || pending.requestId !== requestId ||
        this.videoUpgradePeer()?.id !== pending.participantId) return false;
    if (!this.signaling?.send({ type: 'video-upgrade', to: pending.participantId, requestId,
      action: accept ? 'accept' : 'decline' })) return false;
    if (!accept) this.setVideoUpgrade(null);
    return true;
  }

  private async upgradeToVideo(peerId: string): Promise<void> {
    this.videoConsentPeer = peerId;
    this.store.setState({ audioOnly: false });
    await this.toggleCamera(true);
  }

  private handleVideoUpgrade(message: Extract<ServerMessage, { type: 'video-upgrade' }>): void {
    const peer = this.videoUpgradePeer();
    if (peer?.id !== message.from) return;
    const pending = this.store.getState().videoUpgrade;
    if (message.action === 'request') {
      this.setVideoUpgrade({ requestId: message.requestId, participantId: peer.id, direction: 'incoming' });
      this.app.showToast(this.i18n.t('videoUpgradeIncoming', { name: peer.name }), 'info', VIDEO_UPGRADE_TTL_MS, [
        { label: this.i18n.t('videoUpgradeAccept'), onClick: () => void this.respondToVideoUpgrade(message.requestId, true) },
        { label: this.i18n.t('videoUpgradeDecline'), onClick: () => void this.respondToVideoUpgrade(message.requestId, false) },
      ]);
      return;
    }
    if (!pending || pending.requestId !== message.requestId || pending.participantId !== peer.id) return;
    if (pending.direction === 'incoming' && message.action !== 'accept') return;
    this.setVideoUpgrade(null);
    if (message.action === 'accept') void this.upgradeToVideo(peer.id);
    else this.app.showToast(this.i18n.t('videoUpgradeDeclined'));
  }

  async toggleCamera(force?: boolean): Promise<boolean> {
    const state = this.store.getState();
    if (state.settings.viewer) {
      this.app.showToast(this.i18n.t('viewerHintMuted'), 'warning');
      return false;
    }
    const next = force ?? !state.settings.camEnabled;
    if (next && state.audioOnly) return false;
    if (next) {
      if (!this.media.videoTrack) {
        try {
          const epoch = this.sessionEpoch;
          const { track, usedDefault } = await this.requestCapture('video', state.settings.camDeviceId);
          if (epoch !== this.sessionEpoch || this.store.getState().audioOnly) {
            track.stop();
            return false;
          }
          track.enabled = true;
          this.media.adoptVideoTrack(track);
          const stream = state.localStream ?? new MediaStream();
          stream.addTrack(track);
          this.store.setState({ localStream: stream, mediaError: null });
          if (usedDefault) this.store.patchSection('settings', { camDeviceId: null });
          this.engine?.setLocalStream(stream);
          this.engine?.refreshVideoSenders();
          await this.restartBlurIfNeeded();
          void this.sfu?.setCameraTrack(track, true);
        } catch (error) {
          const detail = this.mediaErrorEvent(mapMediaError(error), 'camera');
          this.app.showToast(detail.message, 'warning');
          this.emitLocal('error', detail);
          return false;
        }
      } else {
        this.media.videoTrack.enabled = true;
        void this.sfu?.setCameraTrack(this.media.videoTrack, true);
      }
    } else if (this.media.videoTrack) {
      this.media.videoTrack.enabled = false;
      void this.sfu?.setCameraTrack(this.media.videoTrack, false);
    }
    this.engine?.refreshVideoSenders();
    this.store.patchSection('settings', { camEnabled: next });
    this.syncSelfState({ cam: next ? 'on' : 'off' });
    this.app.showToast(next ? this.i18n.t('cameraEnabledToast') : this.i18n.t('cameraDisabledToast'), 'info', 1800);
    this.emitLocal('media-state', { cam: next });
    if (next) void this.setupAudioLevels();
    return next;
  }

  private syncSelfState(patch: Partial<ParticipantState>): void {
    const state = this.store.getState();
    if (!state.self) return;
    this.store.setState({ self: { ...state.self, state: { ...state.self.state, ...patch } } });
    this.signaling?.send({ type: 'state', state: patch });
  }

  async toggleScreenShare(force?: boolean): Promise<boolean> {
    const state = this.store.getState();
    const next = force ?? !state.settings.screenSharing;
    if (next && state.audioOnly) return false;
    if (!next) {
      if (state.settings.screenSharing) await this.stopScreenShare();
      return false;
    }
    if (state.settings.screenSharing) return true;
    if (this.screenCapturePending || state.phase !== 'joined') return false;
    if (state.settings.viewer) {
      this.app.showToast(this.i18n.t('viewerHintMuted'), 'warning');
      return false;
    }
    if (!canFeature(state, 'screenShare')) {
      this.app.showToast(this.i18n.t('notAvailable'), 'warning');
      return false;
    }
    this.screenCapturePending = true;
    try {
      const stream = await this.media.startScreenShare(this.config);
      const track = stream.getVideoTracks()[0];
      const current = this.store.getState();
      if (!track || current.phase !== 'joined' || current.room?.id !== state.room?.id || current.settings.viewer || !canFeature(current, 'screenShare')) {
        this.media.stopScreenShare();
        return false;
      }
      if (!current.config.session.screenShare.shareAudio) this.removeScreenAudio(stream);
      const audio = stream.getAudioTracks()[0] ?? null;
      track.addEventListener('ended', () => {
        if (this.store.getState().screenStream === stream) void this.stopScreenShare();
      });
      this.engine?.setScreenTrack(track, audio);
      void this.sfu?.setScreenTrack(track, audio);
      this.store.setState({ screenStream: stream });
      this.store.patchSection('settings', { screenSharing: true });
      this.syncSelfState({ screen: true });
      this.app.showToast(this.i18n.t('screenShareStarted'), 'info');
      this.emitLocal('screen-share-changed', { active: true, track });
      return true;
    } catch (error) {
      this.media.stopScreenShare();
      const reason = error instanceof MediaAccessError && error.code === 'unsupported'
        ? this.i18n.t('mediaUnsupported')
        : this.i18n.t('screenShareUnavailable');
      this.app.showToast(`${this.i18n.t('screenShare')}: ${reason}`, 'warning');
      if (error instanceof MediaAccessError) this.emitLocal('error', { code: error.code, message: reason });
      return false;
    } finally {
      this.screenCapturePending = false;
    }
  }

  private async stopScreenShare(): Promise<void> {
    this.engine?.setScreenTrack(null);
    void this.sfu?.setScreenTrack(null);
    this.media.stopScreenShare();
    this.store.setState({ screenStream: null });
    this.store.patchSection('settings', { screenSharing: false });
    this.syncSelfState({ screen: false });
    this.app.showToast(this.i18n.t('screenShareStopped'), 'info');
    this.emitLocal('screen-share-changed', { active: false });
  }

  private removeScreenAudio(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      stream.removeTrack(track);
      track.stop();
    }
  }

  async setBlurMode(mode: BlurMode, imageUrl?: string): Promise<void> {
    const state = this.store.getState();
    if (state.settings.viewer) {
      this.app.showToast(this.i18n.t('viewerHintMuted'), 'warning');
      return;
    }
    if (mode !== 'off' && !canFeature(state, mode === 'image' ? 'backgroundReplace' : 'backgroundBlur')) {
      this.app.showToast(this.i18n.t('notAvailable'), 'warning');
      return;
    }
    if (mode === 'off') {
      this.blurProcessor?.stop();
      this.blurProcessor = null;
      this.engine?.setVideoOverride(null);
      this.engine?.refreshVideoSenders();
      void this.sfu?.setVideoOverride(null);
      this.applySelfPreviewVideo(null);
      this.store.patchSection('settings', { blurMode: 'off', blurDegraded: false, backgroundImageUrl: '' });
      this.app.showToast(this.i18n.t('blurDisabled'), 'info', 1800);
      return;
    }
    const input = this.media.videoTrack;
    if (!input) {
      this.app.showToast(this.i18n.t('cameraError'), 'warning');
      return;
    }
    this.blurProcessor?.stop();
    const processor = new BackgroundProcessor(input, {
      mode,
      strength: state.settings.blurStrength,
      imageUrl: imageUrl ?? state.settings.backgroundImageUrl,
      colors: {
        primary: this.theme.current?.display.colors.primary ?? '#2563eb',
        surface: this.theme.current?.display.colors.surface ?? '#0f172a',
        background: this.theme.current?.display.colors.background ?? '#080d16',
      },
      container: this.root,
      onDegraded: () => {
        this.store.patchSection('settings', { blurDegraded: true });
        this.app.showToast(this.i18n.t('blurCdnUnavailable'), 'warning', 6000);
      },
    });
    this.blurProcessor = processor;
    const result = await processor.start();
    if (this.blurProcessor !== processor) {
      processor.stop();
      return;
    }
    if (!result.track) {
      processor.stop();
      this.blurProcessor = null;
      this.engine?.setVideoOverride(null);
      void this.sfu?.setVideoOverride(null);
      this.applySelfPreviewVideo(null);
      this.store.patchSection('settings', { blurMode: 'off', blurDegraded: false });
      this.app.showToast(this.i18n.t('blurModelFailed'), 'error', 8000);
      return;
    }
    this.engine?.setVideoOverride(result.track);
    void this.sfu?.setVideoOverride(result.track);
    // Self preview must show the processed track too (not only outgoing).
    this.applySelfPreviewVideo(result.track);
    this.store.patchSection('settings', {
      blurMode: mode,
      backgroundImageUrl: imageUrl ?? state.settings.backgroundImageUrl,
      blurDegraded: result.degraded,
    });
    this.app.showToast(mode === 'blur' ? this.i18n.t('blurEnabled') : this.i18n.t('blurredImageEnabled'), 'success', 2200);
  }

  /** Self tile: audio tracks + processed video (or raw camera when null). */
  private applySelfPreviewVideo(track: MediaStreamTrack | null): void {
    const audio = this.media.localStream?.getAudioTracks() ?? [];
    const video = track ?? this.media.videoTrack;
    const stream = new MediaStream([...audio, ...(video ? [video] : [])]);
    this.store.setState({ localStream: stream });
  }

  private async restartBlurIfNeeded(): Promise<void> {
    const state = this.store.getState();
    if (state.settings.blurMode === 'off') return;
    await this.setBlurMode(state.settings.blurMode, state.settings.backgroundImageUrl);
  }

  private async cycleBlur(): Promise<void> {
    const state = this.store.getState();
    const order: BlurMode[] = ['off', 'blur', 'image'];
    const index = order.indexOf(state.settings.blurMode);
    const allowed = order.filter((mode) => mode === 'off' || canFeature(state, mode === 'blur' ? 'backgroundBlur' : 'backgroundReplace'));
    let next = order[(index + 1) % order.length] ?? 'off';
    if (!allowed.includes(next)) next = 'off';
    await this.setBlurMode(next, next === 'image' ? state.config.session.virtualBackgrounds[0]?.url ?? this.store.getState().backgrounds[0]?.url ?? '' : undefined);
  }

  /* ------------------------------------------------------------------ */
  /* Noise detection (features.noiseDetection)                          */
  /* ------------------------------------------------------------------ */

  /** True when both the tenant flag and the effective permissions allow noise detection. */
  private noiseDetectionEnabled(state: CallState): boolean {
    // Both the tenant flag (a local kill switch that `updateConfig()` can flip)
    // and the effective permissions must allow the feature.
    return state.config.features.noiseDetection === true && canFeature(state, 'noiseDetection');
  }

  /**
   * Creates/keeps one monitor for the current local audio track. The monitor
   * only runs when the tenant enabled `features.noiseDetection`, the effective
   * permissions allow it and the mic is actually on; every other state stops
   * it (mute, leave, device switch, feature/flag update).
   */
  private syncNoiseDetection(): void {
    if (this.destroyed) {
      this.stopNoiseDetection();
      return;
    }
    const state = this.store.getState();
    const track = this.media.audioTrack ?? state.localStream?.getAudioTracks()[0] ?? null;
    if (!track || !state.settings.micEnabled || !this.noiseDetectionEnabled(state)) {
      this.stopNoiseDetection();
      return;
    }
    if (this.noiseMonitor?.sourceTrack === track) {
      this.noiseMonitor.setMuted(!state.settings.micEnabled || !track.enabled);
      return;
    }
    this.stopNoiseDetection();
    const monitor = new NoiseMonitor({
      track,
      onNoise: (event) => this.onNoiseDetected(event),
    });
    this.noiseMonitor = monitor;
    if (!monitor.start()) {
      monitor.dispose();
      this.noiseMonitor = null;
    }
  }

  private stopNoiseDetection(): void {
    this.noiseMonitor?.dispose();
    this.noiseMonitor = null;
  }

  /** Host event + localized toast; no audio samples leave the browser. */
  private onNoiseDetected(event: NoiseDetectedEvent): void {
    if (this.destroyed) return;
    const state = this.store.getState();
    if (!state.settings.micEnabled || !this.noiseDetectionEnabled(state)) return;
    this.emitLocal('noise-detected', { level: event.level, rms: event.rms, at: event.at });
    this.app.showToast(this.i18n.t('noiseDetected'), 'warning', 12_000, [
      { label: this.i18n.t('noiseMuteMic'), onClick: () => void this.toggleMic(false) },
      { label: this.i18n.t('noiseAdjust'), onClick: () => this.openPanel('settings') },
    ]);
  }

  private async setupAudioLevels(): Promise<void> {
    if (typeof AudioContext === 'undefined') return;
    const state = this.store.getState();
    if (!this.audioContext) {
      try {
        this.audioContext = new AudioContext();
      } catch {
        return;
      }
      this.speakingTimer = setInterval(() => this.sampleAudioLevels(), 250);
    }
    if (this.audioContext.state === 'suspended') void this.audioContext.resume().catch(() => undefined);
    // In SFU mode LiveKit already reports active speakers; creating 199
    // WebAudio analysers would waste CPU/memory in a 200-person room. Mesh
    // rooms still need per-peer analysers (there is no SFU speaker signal).
    const streams: Array<[string, MediaStream | null]> =
      this.mediaPlane === 'sfu'
        ? [[state.self?.id ?? this.selfId, state.localStream]]
        : [
            [state.self?.id ?? this.selfId, state.localStream],
            ...state.participants.map((participant): [string, MediaStream | null] => [
              participant.id,
              state.remoteStreams[participant.id] ?? null,
            ]),
          ];
    for (const [id, stream] of streams) {
      if (!stream || this.analysers.has(id) || !stream.getAudioTracks().length) continue;
      try {
        const source = this.audioContext.createMediaStreamSource(stream);
        const analyser = this.audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        this.analysers.set(id, { analyser, data: new Uint8Array(analyser.frequencyBinCount), source });
      } catch {
        /* audio graph can fail for empty streams */
      }
    }
  }

  private speakingState = new Map<string, { active: boolean; aboveSince: number; lastAbove: number }>();

  private sampleAudioLevels(): void {
    const now = Date.now();
    const levels: Array<{ id: string; rms: number }> = [];
    for (const [id, entry] of this.analysers) {
      entry.analyser.getByteTimeDomainData(entry.data);
      let sum = 0;
      for (const value of entry.data) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }
      levels.push({ id, rms: Math.sqrt(sum / entry.data.length) });
    }
    let loudest: string | null = null;
    let loudestRms = 0;
    for (const level of levels) {
      const entry = this.speakingState.get(level.id) ?? { active: false, aboveSince: 0, lastAbove: 0 };
      if (level.rms > 0.045) {
        entry.lastAbove = now;
        if (!entry.active && entry.aboveSince === 0) entry.aboveSince = now;
        if (!entry.active && now - entry.aboveSince >= 320) entry.active = true;
      } else {
        entry.aboveSince = 0;
        if (entry.active && now - entry.lastAbove >= 420) entry.active = false;
      }
      this.speakingState.set(level.id, entry);
      this.handleSpeaking(level.id, entry.active);
      if (entry.active && level.rms > loudestRms) { loudestRms = level.rms; loudest = level.id; }
    }
    if (loudest) this.app.setSpotlightFollowSpeaker(loudest);
  }

  private dropAudioLevel(participantId: string): void {
    const entry = this.analysers.get(participantId);
    if (!entry) return;
    try {
      entry.source.disconnect();
    } catch {
      /* ignore */
    }
    this.analysers.delete(participantId);
    this.handleSpeaking(participantId, false);
  }

  private stopLocalMedia(): void {
    this.stopNoiseDetection();
    this.media.stopAll();
    this.store.setState({ localStream: null, screenStream: null });
    this.blurProcessor?.stop();
    this.blurProcessor = null;
    this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    if (this.speakingTimer) {
      clearInterval(this.speakingTimer);
      this.speakingTimer = null;
    }
    this.analysers.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Chat / notes / assistant                                           */
  /* ------------------------------------------------------------------ */

  private appendChat(message: ChatMessage): void {
    const state = this.store.getState();
    const exists = state.chat.some((entry) => entry.id === message.id);
    const chat = exists ? state.chat.map((entry) => (entry.id === message.id ? message : entry)) : [...state.chat, message];
    const chatOpen = state.settings.panel === 'chat';
    const fromSelf = message.from.id === this.selfId;
    this.store.setState({
      chat,
      chatUnread: !chatOpen && !fromSelf && message.kind !== 'system' ? state.chatUnread + 1 : state.chatUnread,
      notes: state.notes,
    });
    if (!chatOpen && !fromSelf && message.kind !== 'system') {
      const preview = message.attachment ? message.attachment.name : message.text;
      this.app.showToast(`${message.from.name}: ${preview}`, 'info', 6000);
    }
    this.emitLocal('chat', message);
    this.options.onChat?.(message);
  }

  private syncAssistantState(): void {
    const entries = this.assistant?.history ?? [];
    this.store.setState({
      assistant: {
        ...this.store.getState().assistant,
        entries,
        asking: Boolean(this.assistant?.pending),
      },
    });
  }

  private applyAssistantAvailability(): void {
    const state = this.store.getState();
    const config = state.config;
    const role = state.self?.role ?? this.options.role ?? 'guest';
    const permissions = state.permissions ?? resolveLocalPermissions(config, role);
    const available =
      permissions.includes('knowledgeAgent') &&
      config.session.knowledgeAgent.enabled &&
      config.session.knowledgeAgent.allowedRoles.includes(role);
    this.store.setState({
      assistant: {
        ...state.assistant,
        available,
        denyMessage: config.session.knowledgeAgent.denyMessage || this.i18n.t('assistantForbidden'),
      },
      inCallAssistant: {
        ...state.inCallAssistant,
        available: config.session.inCallAgent.enabled,
      },
      ...(state.settings.panel === 'assistant' && !available && !config.session.inCallAgent.enabled
        ? { settings: { ...state.settings, panel: 'none' as const } }
        : {}),
    });
  }

  /** Lazily creates the in-call assistant (local/external modes + spotlight). */
  private ensureInCallAssistant(): void {
    if (this.inCallAssistant) return;
    this.inCallAssistant = new InCallAssistantController({
      api: this.api,
      i18n: this.i18n,
      roomId: () => this.roomId,
      getConfig: () => this.store.getState().config,
      getRole: () => this.store.getState().self?.role ?? this.options.role ?? 'guest',
      getPermissions: () => {
        const state = this.store.getState();
        const role = state.self?.role ?? this.options.role ?? 'guest';
        return state.permissions ?? resolveLocalPermissions(state.config, role);
      },
      getState: () => {
        const state = this.store.getState();
        return {
          participants: state.participants.length + (state.self ? 1 : 0),
          recording: state.recording.active,
          mic: state.settings.micEnabled ? 'on' : 'off',
          camera: state.settings.camEnabled ? 'on' : 'off',
          screenSharing: state.settings.screenSharing,
          chatOpen: state.settings.panel === 'chat',
          layoutMode: state.settings.layoutMode,
          qualityTier: state.quality.tier,
        };
      },
      executeAction: (action) => this.executeAssistantAction(action),
      confirmAction: (action, execute) => this.confirmAssistantAction(action, execute),
      showSpotlight: (steps) => {
        void this.ensureSpotlight().then((overlay) => {
          // A spotlight requested just before a leave must not appear over the
          // join screen when the lazy chunk finishes loading.
          if (!overlay || this.widgetDisposed || !this.joined) return;
          overlay.show(steps);
        });
      },
      onChange: ({ messages, busy }) => {
        this.store.setState({
          inCallAssistant: { ...this.store.getState().inCallAssistant, messages, busy },
        });
      },
      onDenied: (message) => this.app.showToast(message, 'warning', 6000),
      onError: (message) => this.app.showToast(message, 'error', 6000),
    });
  }

  private confirmAssistantAction(action: AssistantAction, execute: () => void): void {
    const labels = {
      start_recording: ['начать запись', 'start recording'], stop_recording: ['остановить запись', 'stop recording'],
      toggle_mic: ['переключить микрофон', 'toggle microphone'], toggle_camera: ['переключить камеру', 'toggle camera'],
      toggle_screen_share: ['переключить демонстрацию экрана', 'toggle screen sharing'], raise_hand: ['поднять руку', 'raise hand'],
      copy_invite_link: ['скопировать приглашение', 'copy invitation'], open_new_tab: ['открыть звонок в новой вкладке', 'open call in a new tab'],
      set_blur: ['изменить размытие фона', 'change background blur'], send_chat: ['отправить сообщение', 'send chat message'],
    } as const;
    if (!Object.hasOwn(labels, action.tool)) return;
    const label = labels[action.tool as keyof typeof labels][this.i18n.current === 'en' ? 1 : 0];
    const message = action.tool === 'send_chat' && typeof action.args?.text === 'string'
      ? this.i18n.t('assistantConfirmSend', { text: action.args.text })
      : this.i18n.t('assistantConfirmAction', { action: label });
    const dismiss = () => this.app.toasts.dismissMessage?.(message);
    dismiss();
    this.app.showToast(message, 'info', 15_000, [
      { label: this.i18n.t('assistantApplyAction'), onClick: () => { dismiss(); if (this.joined) execute(); } },
      { label: this.i18n.t('assistantDismissAction'), onClick: dismiss },
    ]);
  }

  /** Runs one assistant tool through the regular public instance methods. */
  private async executeAssistantAction(action: AssistantAction): Promise<boolean> {
    const state = this.store.getState();
    const args = action.args ?? {};
    switch (String(action.tool)) {
      case 'start_recording':
        if (!state.recording.active) await this.toggleRecording();
        return this.store.getState().recording.active;
      case 'stop_recording':
        if (this.store.getState().recording.active) await this.toggleRecording();
        return !this.store.getState().recording.active;
      case 'toggle_mic':
        return this.toggleMic();
      case 'toggle_camera':
        return this.toggleCamera();
      case 'toggle_screen_share':
        return this.toggleScreenShare();
      case 'raise_hand':
        if (!this.store.getState().settings.handRaised) this.toggleHand();
        return true;
      case 'lower_hand':
        if (this.store.getState().settings.handRaised) this.toggleHand();
        return true;
      case 'send_chat': {
        const text = typeof args.text === 'string' ? args.text.slice(0, 4000) : '';
        if (!text) return false;
        await this.sendChat(text);
        return true;
      }
      case 'open_chat':
      case 'open_files':
        this.openPanel('chat');
        return true;
      case 'open_participants':
        this.openPanel('participants');
        return true;
      case 'open_notes':
        this.openPanel('notes');
        return true;
      case 'open_settings':
        this.openPanel('settings');
        return true;
      case 'set_blur': {
        const requested = typeof args.mode === 'string' ? args.mode : state.settings.blurMode === 'off' ? 'blur' : 'off';
        const mode = requested === 'image' ? 'image' : requested === 'off' ? 'off' : 'blur';
        const imageUrl = typeof args.imageUrl === 'string' ? args.imageUrl : undefined;
        await this.setBlurMode(mode, imageUrl);
        return true;
      }
      case 'minimize':
        this.minimize();
        return true;
      case 'restore':
        this.restore();
        return true;
      case 'request_fullscreen':
        await this.requestFullscreen();
        return this.isFullscreen();
      case 'open_new_tab':
        return this.openInNewTab() !== null;
      case 'copy_invite_link':
        await this.copyLink();
        return true;
      default:
        return false;
    }
  }

  private chatErrorMessage(message: string): string {
    switch (message) {
      case 'file_too_large':
        return this.i18n.t('chatFileTooBig');
      case 'unsupported_mime':
        return this.i18n.t('chatUnsupportedType');
      case 'file_upload_failed':
        return this.i18n.t('chatFileUploadError');
      default:
        return this.i18n.t('chatSendError');
    }
  }

  private recordingErrorMessage(message: string): string {
    switch (message) {
      case 'recordingNotSupported':
        return this.i18n.t('recNotSupported');
      default:
        return this.i18n.t('recError');
    }
  }

  private captionsLanguage(): 'ru' | 'en' {
    const configured = this.config.session.transcription.language;
    if (configured === 'auto') return this.i18n.current;
    return configured;
  }

  private livenessText(task: 'blink' | 'head-left' | 'head-right'): string {
    if (task === 'blink') return this.i18n.t('livenessBlink');
    if (task === 'head-left') return this.i18n.t('livenessHeadLeft');
    return this.i18n.t('livenessHeadRight');
  }

  /* ------------------------------------------------------------------ */
  /* Recording                                                          */
  /* ------------------------------------------------------------------ */

  private async toggleRecording(): Promise<void> {
    if (this.recorder?.active) await this.stopRecording();
    else await this.startRecording();
  }

  /**
   * Public: starts local recording.
   *
   * In the default UI a consent dialog is rendered when the tenant requires it.
   * Headless hosts must render their own consent UI and pass `{ consent: true }`;
   * otherwise the call resolves `false` and an `error` event with
   * `code: 'recording_consent_required'` is emitted.
   */
  async startRecording(options: { consent?: boolean } = {}): Promise<boolean> {
    const state = this.store.getState();
    if (!canFeature(state, 'recording') || !browserRecordingEnabled(this.config)) {
      this.app.showToast(this.i18n.t('notAvailable'), 'warning');
      return false;
    }
    if (this.recorder?.active) return true;
    if (!this.recorder || this.cancelRecordingConsent) return false;
    if (this.recorder.finalizing) {
      this.app.showToast(this.i18n.t('recFinalizing'), 'info');
      return false;
    }
    if (this.config.session.recording.consentRequired) {
      const epoch = this.sessionEpoch;
      const accepted = options.consent === true || (!this.headless && options.consent === undefined && (await this.askRecordingConsent()));
      if (this.sessionEpoch !== epoch || this.widgetDisposed) return false;
      if (!accepted) {
        if (this.headless) {
          this.emitLocal('error', {
            code: 'recording_consent_required',
            message: `${this.i18n.t('recConsentTitle')} ${this.i18n.t('recConsentNotice')}`,
          });
        } else {
          this.app.showToast(this.i18n.t('recConsentCancelled'), 'warning');
        }
        return false;
      }
      if (!canFeature(this.store.getState(), 'recording') || !browserRecordingEnabled(this.config)) return false;
    }
    const sources = [
      { id: this.selfId, label: this.store.getState().self?.name ?? this.i18n.t('you'), stream: this.media.localStream ?? new MediaStream() },
      ...Object.entries(this.store.getState().remoteStreams).map(([id, stream]) => ({
        id,
        label: this.participantName(id),
        stream,
      })),
    ].filter((source) => source.stream.getTracks().length > 0);
    const started = await this.recorder.start(sources, {
      onTick: () => this.app.update(this.store.getState()),
    });
    if (!started) return false;
    const startedAt = this.recorder.startedAtMs || Date.now();
    this.store.patchSection('recording', { active: true, startedAt, consentPending: false });
    // P2: guests get a persistent indicator, not only the chat notice. The
    // server keeps this in the participant state and replays it on join.
    this.broadcastRecordingState(true, startedAt);
    this.app.showToast(this.i18n.t('recStarted'), 'success');
    if (this.config.session.recording.notifyParticipants) {
      this.signaling?.send({ type: 'chat', id: `rec-${Date.now()}`, text: this.i18n.t('recNotice') });
    }
    return true;
  }

  /** Public: stops local recording (upload/download handling matches the UI). */
  async stopRecording(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder?.active) return;
    // Hide the indicator on every client immediately; finalizing the file can
    // take a moment and must not leave guests thinking recording continues.
    this.store.patchSection('recording', { active: false, startedAt: null, consentPending: false });
    this.broadcastRecordingState(false, null);
    const result = await recorder.stop();
    if (!result) return;
    if (result.uploaded) {
      this.app.showToast(this.i18n.t('recUploaded'), 'success');
    } else {
      const filename = `agil-recording-${this.roomId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${result.mimeType.includes('mp4') ? 'mp4' : 'webm'}`;
      // P1: blob downloads use their own same-origin path; `safeHttpUrl()`
      // intentionally rejects `blob:` and used to swallow the file silently.
      if (triggerBlobDownload(result.blob, filename)) {
        this.app.showToast(this.i18n.t(result.uploadFailed ? 'recSavedAfterUploadFailure' : 'recSaved'),
          result.uploadFailed ? 'warning' : 'success');
      } else {
        this.app.showToast(this.i18n.t('recError'), 'error');
      }
    }
  }

  /** Broadcasts recorder start/stop as a partial participant state frame. */
  private broadcastRecordingState(active: boolean, startedAt: number | null): void {
    this.signaling?.send({ type: 'state', state: recordingStatePatch(active, startedAt) });
  }

  private askRecordingConsent(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const opener = this.root.querySelector<HTMLElement>(':focus') ?? this.root.ownerDocument.activeElement;
      const id = `agil-recording-consent-${++recordingConsentId}`;
      const overlay = h('div', { class: 'agil-consent-overlay' });
      const accept = h('button', { class: 'agil-btn agil-btn-primary', text: this.i18n.t('recConsentStart') });
      accept.type = 'button';
      // P3: “Покинуть” only cancelled the recording and confused the host;
      // the action is now labelled “Отмена” and the dialog says so explicitly.
      const decline = h('button', { class: 'agil-btn agil-btn-ghost', text: this.i18n.t('recConsentCancel') });
      decline.type = 'button';
      const dialog = h(
        'div',
        { class: 'agil-consent-dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-title`,
          'aria-describedby': `${id}-notice ${id}-storage ${id}-hint` } },
        h('h2', { class: 'agil-consent-title', attrs: { id: `${id}-title` }, text: this.i18n.t('recConsentTitle') }),
        h('p', { attrs: { id: `${id}-notice` }, text: this.i18n.t('recConsentNotice') }),
        h('p', { attrs: { id: `${id}-storage` }, text: this.i18n.t(this.config.session.recording.storeOnServer ? 'recStoreRemote' : 'recStoreLocal') }),
        h('p', { class: 'agil-consent-hint', attrs: { id: `${id}-hint` }, text: this.i18n.t('recConsentCancelHint') }),
        h('div', { class: 'agil-consent-actions' }, accept, decline),
      );
      const background = [...this.root.children].filter((node): node is HTMLElement => node instanceof HTMLElement && !node.inert);
      background.forEach((node) => { node.inert = true; });
      overlay.appendChild(dialog);
      this.root.appendChild(overlay);
      const close = (value: boolean, restoreFocus = true): void => {
        overlay.remove();
        background.forEach((node) => { node.inert = false; });
        this.cancelRecordingConsent = null;
        if (restoreFocus) {
          const target = opener instanceof HTMLElement && opener.isConnected && opener.getClientRects().length && opener !== opener.ownerDocument.body
            ? opener : this.root.querySelector<HTMLElement>('[data-agil-more]');
          target?.focus({ preventScroll: true });
        }
        resolve(value);
      };
      this.cancelRecordingConsent = () => close(false, false);
      accept.addEventListener('click', () => close(true));
      decline.addEventListener('click', () => close(false));
      dialog.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(false);
        } else if (event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          (event.target === accept ? decline : accept).focus();
        }
      });
      decline.focus();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Location (consent-based)                                           */
  /* ------------------------------------------------------------------ */

  private requestLocation(consent: boolean): void {
    if (!consent) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        this.signaling?.send({
          type: 'location',
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracyM: Math.round(position.coords.accuracy),
          consent: true,
        });
        this.app.showToast(this.i18n.t('locationSent'), 'success', 2600);
      },
      () => this.app.showToast(this.i18n.t('locationDenied'), 'warning', 4000),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
    );
  }

  /* ------------------------------------------------------------------ */
  /* Panel / settings actions                                           */
  /* ------------------------------------------------------------------ */

  private openPanel(panel: PanelKind): void {
    const state = this.store.getState();
    const same = state.settings.panel === panel;
    if (panel !== 'none' && !this.canOpenPanel(panel)) {
      this.app.showToast(panel === 'assistant' ? this.i18n.t('noKnowledgeAccess') : this.i18n.t('notAvailable'), 'warning');
      return;
    }
    this.app.closeControlPopovers?.();
    this.pollsPanel?.close();
    if (panel !== 'lobby') this.stopHostLobbyPolling();
    this.store.patchSection('settings', { panel: same ? 'none' : panel });
    if (same) {
      this.stopHostLobbyPolling();
      return;
    }
    if (panel === 'chat') this.store.setState({ chatUnread: 0 });
    if (panel === 'settings') this.app.focusSettingsDevices();
    if (panel === 'assistant') this.syncAssistantState();
    if (panel === 'lobby') this.startHostLobbyPolling();
    if (panel === 'breakout') void this.loadBreakoutPlan();
  }

  /** Closes the side panel and stops the lobby queue polling fallback. */
  private closePanel(): void {
    this.stopHostLobbyPolling();
    this.store.patchSection('settings', { panel: 'none' });
  }

  private canOpenPanel(panel: PanelKind, state = this.store.getState()): boolean {
    switch (panel) {
      case 'chat':
        return canFeature(state, 'chat') && state.settings.chatMode === 'builtin';
      case 'participants':
        return canFeature(state, 'participantList');
      case 'notes':
        return canFeature(state, 'meetingNotes') || canFeature(state, 'aiCompliance');
      case 'transcript':
        return canFeature(state, 'captions') && state.config.session.transcription.saveTranscript;
      case 'settings':
        return true;
      case 'assistant':
        return state.inCallAssistant.available || state.assistant.available;
      case 'lobby':
        return this.isLobbyManager();
      case 'breakout':
        return this.isBreakoutManager();
      default:
        return true;
    }
  }

  private exportTranscript(): void {
    const state = this.store.getState();
    if (!this.canOpenPanel('transcript')) return;
    const lines = state.transcripts.map((segment) => {
      const original = `[${formatDuration(segment.start)}] ${segment.participantName}: ${segment.text}`;
      return segment.translation
        ? `${original}\n    ${this.i18n.t('transcriptTranslation')} (${segment.translation.lang}): ${segment.translation.text}`
        : original;
    });
    if (state.notes && canFeature(state, 'meetingNotes')) {
      lines.push('', `# ${this.i18n.t('notesTitle')}`, state.notes.summary, '');
      for (const excerpt of state.notes.excerpts) lines.push(`[${formatDuration(excerpt.start)}] ${excerpt.text}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `agil-transcript-${this.roomId}.txt`);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  private async copyLink(): Promise<void> {
    const state = this.store.getState();
    if (!canFeature(state, 'inviteLink')) return;
    const url = new URL('/embed.html', this.api.base);
    url.searchParams.set('room', this.mainRoomId);
    if (this.options.audioOnly) url.searchParams.set('audioOnly', '1');
    url.searchParams.set('tenant', this.tenantId);
    try {
      await navigator.clipboard.writeText(url.toString());
      this.app.showToast(this.i18n.t('copied'), 'success', 2000);
    } catch {
      // Never surface the invite URL/token in the UI.
      this.app.showToast(this.i18n.t('copyFailed'), 'warning', 5000);
    }
  }

  private onThemeApplied(): void {
    const applied = this.theme.current;
    if (!applied) return;
    this.emitLocal('theme-changed', { scheme: applied.scheme });
  }

  updateTheme(patch: ThemePatch): void {
    const applied = this.theme.patchTheme(patch);
    this.config = { ...this.config, theme: this.theme.getTheme() ?? this.config.theme };
    this.store.setState({ config: this.config });
    this.applyAssistantAvailability();
    this.emitLocal('theme-changed', { theme: this.config.theme, scheme: applied.scheme });
  }

  updateConfig(patch: TenantConfigPatch, options?: { replace?: boolean }): void {
    const next = resolveTenantConfig(patch, options?.replace ? undefined : this.config, { tenantId: this.tenantId });
    this.applyConfig(next, this.store.getState().serverOnline);
  }

  setThemeScheme(scheme: 'light' | 'dark' | 'auto'): void {
    const current = this.theme.getTheme() ?? this.config.theme;
    const theme = themeForScheme(current, scheme);
    this.theme.setTheme(theme);
    this.config = { ...this.config, theme };
    this.store.setState({ config: this.config });
    this.store.patchSection('settings', { scheme });
    this.emitLocal('theme-changed', { scheme });
  }

  /* ------------------------------------------------------------------ */
  /* Mini mode / Document PiP (contract §22.2)                          */
  /* ------------------------------------------------------------------ */

  minimize(): void {
    // There is no built-in mini window to show in headless mode.
    if (this.headless) return;
    const state = this.store.getState();
    if (!state.config.layout.minimized.enabled || state.phase !== 'joined') return;
    if (state.settings.minimized) return;
    this.stopHostLobbyPolling();
    this.store.patchSection('settings', { minimized: true, panel: 'none' });
    this.emitLocal('minimized-changed', { minimized: true, pictureInPicture: Boolean(this.pipWindow) });
  }

  restore(): void {
    const state = this.store.getState();
    if (this.pipWindow) this.detachPictureInPicture();
    if (!state.settings.minimized) return;
    this.store.patchSection('settings', { minimized: false });
    this.emitLocal('minimized-changed', { minimized: false, pictureInPicture: false });
  }

  isMinimized(): boolean {
    return this.store.getState().settings.minimized;
  }

  /** Moves the call into a Document Picture-in-Picture window (Chromium). */
  async requestPictureInPicture(): Promise<boolean> {
    // Document PiP is a built-in-UI feature; a headless host owns its own views.
    if (this.headless) return false;
    if (this.pipWindow) return true;
    const scoped = window as unknown as {
      documentPictureInPicture?: { requestWindow?: (options?: { width?: number; height?: number }) => Promise<Window> };
    };
    const requestWindow = scoped.documentPictureInPicture?.requestWindow;
    if (typeof requestWindow !== 'function') {
      this.minimize();
      return false;
    }
    const focused = this.root.ownerDocument.activeElement;
    const sessionEpoch = this.sessionEpoch;
    try {
      const pipWindow = await requestWindow.call(scoped.documentPictureInPicture, { width: 420, height: 320 });
      if (sessionEpoch !== this.sessionEpoch || this.destroyed) {
        pipWindow.close();
        return false;
      }
      this.pipWindow = pipWindow;
      this.pipRestoreParent = this.root.parentElement;
      this.pipReturnFocus = focused instanceof HTMLElement && this.root.contains(focused) ? focused : null;
      const doc = pipWindow.document;
      doc.title = this.i18n.t('appName');
      for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
        doc.head.appendChild(node.cloneNode(true));
      }
      const resetStyle = doc.createElement('style');
      resetStyle.textContent = 'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;}';
      doc.head.appendChild(resetStyle);
      this.root.style.width = '100%';
      this.root.style.height = '100%';
      this.root.style.borderRadius = '0';
      this.root.dataset.agilDocumentPip = 'true';
      doc.body.appendChild(this.root);
      const onPageHide = (): void => this.detachPictureInPicture(false);
      this.pipPageHideHandler = onPageHide;
      pipWindow.addEventListener('pagehide', onPageHide, { once: true });
      this.stopHostLobbyPolling();
      this.store.patchSection('settings', { minimized: false, panel: 'none' });
      this.app.update(this.store.getState());
      this.emitLocal('minimized-changed', { minimized: false, pictureInPicture: true });
      return true;
    } catch (error) {
      this.detachPictureInPicture();
      console.warn('[agil] Document PiP is unavailable', error);
      this.minimize();
      return false;
    }
  }

  private detachPictureInPicture(closeWindow = true): void {
    const pipWindow = this.pipWindow;
    if (!pipWindow) return;
    if (this.pipPageHideHandler) {
      try {
        pipWindow.removeEventListener('pagehide', this.pipPageHideHandler);
      } catch {
        /* ignore */
      }
      this.pipPageHideHandler = null;
    }
    const parent = this.pipRestoreParent ?? this.host;
    try {
      parent.appendChild(this.root);
    } catch {
      /* parent may be gone */
    }
    this.root.style.width = '';
    this.root.style.height = '';
    this.root.style.borderRadius = '';
    delete this.root.dataset.agilDocumentPip;
    this.pipWindow = null;
    this.pipRestoreParent = null;
    if (closeWindow) pipWindow.close();
    const focus = this.pipReturnFocus;
    this.pipReturnFocus = null;
    const state = this.store.getState();
    if (this.joined) {
      this.app.closeControlPopovers?.();
      this.app.update(state);
      const target = focus?.isConnected && focus.getClientRects().length
        ? focus
        : this.root.querySelector<HTMLElement>('[data-agil-more]') ?? this.root;
      target.focus({ preventScroll: true });
    }
    this.emitLocal('minimized-changed', { minimized: state.settings.minimized, pictureInPicture: false });
  }

  /* ------------------------------------------------------------------ */
  /* Fullscreen / deep links (messenger integration, docs/messenger.md) */
  /* ------------------------------------------------------------------ */

  async requestFullscreen(): Promise<void> {
    const state = this.store.getState();
    if (!state.config.features.fullscreen || !canFeature(state, 'fullscreen')) return;
    const target = this.root as HTMLElement & { requestFullscreen?: () => Promise<void> };
    if (typeof target.requestFullscreen !== 'function') return;
    try {
      await target.requestFullscreen();
    } catch (error) {
      // Denied by the browser (iframe without allowfullscreen, headless, no gesture).
      console.warn('[agil] requestFullscreen was rejected', error);
    }
    this.syncFullscreenState();
  }

  async exitFullscreen(): Promise<void> {
    if (typeof document === 'undefined' || typeof document.exitFullscreen !== 'function') return;
    if (!document.fullscreenElement) return;
    try {
      await document.exitFullscreen();
    } catch (error) {
      console.warn('[agil] exitFullscreen failed', error);
    }
    this.syncFullscreenState();
  }

  isFullscreen(): boolean {
    return typeof document !== 'undefined' && document.fullscreenElement === this.root;
  }

  private syncFullscreenState(): void {
    const active = this.isFullscreen();
    if (this.store.getState().settings.fullscreen !== active) {
      this.store.patchSection('settings', { fullscreen: active });
    }
    this.root.dataset.agilFullscreen = String(active);
    this.emitLocal('media-state', { fullscreen: active });
  }

  /** Deep link to the current call (embed.html with room/token/tenant/name/theme). */
  getCallUrl(): string {
    const state = this.store.getState();
    const url = new URL('/embed.html', `${this.api.base}/`);
    url.searchParams.set('server', this.api.base);
    // Invites always point at the main room, never at the participant's sub-room.
    url.searchParams.set('room', this.mainRoomId);
    if (this.options.audioOnly) url.searchParams.set('audioOnly', '1');
    const token = this.breakoutMain?.token ?? this.joinToken ?? this.api.token;
    if (token) url.searchParams.set('token', token);
    url.searchParams.set('tenant', this.tenantId);
    const name = state.self?.name ?? this.options.participantName;
    if (name) url.searchParams.set('name', name);
    const scheme = this.theme.current?.scheme ?? this.config.theme.scheme;
    if (scheme) url.searchParams.set('theme', scheme);
    return url.toString();
  }

  /**
   * Opens the call in a new tab. When the browser blocks the popup we never show
   * the call URL/token in the UI (screenshots/logs leak): only a human message
   * plus "copy link" (clipboard, invisible) and "retry" actions.
   */
  openInNewTab(): Window | null {
    if (typeof window === 'undefined') return null;
    const url = this.getCallUrl();
    let win: Window | null = null;
    try {
      // The noopener feature returns null even when opening succeeds. Detach
      // the blank tab before loading call content so we can detect a blocker.
      win = window.open('', '_blank');
      if (win) {
        win.opener = null;
        win.location.replace(url);
      }
    } catch {
      win?.close();
      win = null;
      console.warn('[agil] window.open failed');
    }
    if (!win) {
      const host = typeof window.location !== 'undefined' ? window.location.host : '';
      this.app.showToast(this.i18n.t('popupBlockedHint', { host }), 'warning', 10_000, [
        {
          label: this.i18n.t('copyLink'),
          onClick: () => {
            void this.copyCallUrlSilently(url);
          },
        },
        {
          label: this.i18n.t('retry'),
          onClick: () => {
            this.openInNewTab();
          },
        },
      ]);
    }
    return win;
  }

  private async copyCallUrlSilently(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.app.showToast(this.i18n.t('copied'), 'success', 2000);
    } catch {
      this.app.showToast(this.i18n.t('copyFailed'), 'warning', 4000);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Chat mode / session handoff (contract §22.1, §22.2)                */
  /* ------------------------------------------------------------------ */

  setChatMode(mode: ChatMode): void {
    this.chatModeOverride = mode;
    const state = this.store.getState();
    const patch: Partial<CallSettingsState> = { chatMode: mode };
    if (mode !== 'builtin' && state.settings.panel === 'chat') patch.panel = 'none';
    this.store.patchSection('settings', patch);
    this.emitLocal('chat-mode-changed', { mode });
  }

  private simulatedParticipants: Participant[] = [];
  private simulationBackup: {
    participants: Participant[];
    self: Participant | null;
    phase: CallPhase;
    joined: boolean;
    serverOnline: boolean;
    connection: CallState['connection'];
    wsState: CallState['wsState'];
  } | null = null;

  /**
   * Preview/design helper: synthetic participants (camera off, initials) with
   * no peer connections, no signaling and no room/WS traffic.
   */
  simulateParticipants(
    count: number,
    opts: {
      names?: string[];
      layout?: LayoutMode;
      controls?: 'bar' | 'island' | 'minimal';
      /** Preview only: render remote tiles as camera-on so the play-video affordance is visible. */
      camera?: 'on' | 'off';
    } = {},
  ): void {
    const total = Math.max(1, Math.min(LARGE_ROOM_MAX_PARTICIPANTS, Math.floor(Number.isFinite(count) ? count : 1)));
    const state = this.store.getState();
    if (!this.simulationBackup) {
      this.simulationBackup = {
        participants: state.participants,
        self: state.self,
        phase: state.phase,
        joined: this.joined,
        // The preview flips the connection to a healthy call (C-04); clearing
        // it must restore the real state instead of leaving a fake “Подключено”.
        serverOnline: state.serverOnline,
        connection: state.connection,
        wsState: state.wsState,
      };
    }
    const backup = this.simulationBackup;
    const real = backup.participants.filter((participant) => !participant.id.startsWith('sim-'));
    const needsSelf = !backup.self;
    const self = backup.self ?? ({
      id: 'sim-self',
      name: opts.names?.[0] || 'Вы',
      role: 'host',
      state: { mic: 'off', cam: 'off', screen: false, handRaised: false },
      country: 'RU',
      joinedAt: Date.now(),
      // A real server always sends an integrity verdict; `unknown` is the
      // normal value for a participant that has not been checked (C-04).
      verified: false,
      integrity: 'unknown',
    } as unknown as Participant);
    // count is the TOTAL number of participants on stage, including self.
    const syntheticCount = Math.max(0, total - 1);
    const firstNames = ['Анна', 'Борис', 'Вера', 'Глеб', 'Дарья', 'Егор', 'Жанна', 'Игорь', 'Ксения', 'Леонид'];
    const synthetic: Participant[] = [];
    for (let index = 0; index < syntheticCount; index += 1) {
      synthetic.push({
        id: 'sim-' + String(index + 1),
        name: opts.names?.[index + 1] || firstNames[index % firstNames.length] + ' ' + String(index + 1),
        role: index % 7 === 0 ? 'moderator' : 'guest',
        state: { mic: 'off', cam: opts.camera ?? 'off', screen: false, handRaised: false },
        country: ['RU', 'KZ', 'BY', 'AM', 'GE'][index % 5],
        joinedAt: Date.now() - index * 1000,
        // Harness happy path (C-04): no synthetic “possible spoofing” triangle.
        integrity: 'unknown' as const,
        verified: false,
      } as unknown as Participant);
    }
    this.simulatedParticipants = synthetic;
    this.store.setState({
      phase: 'joined',
      self,
      participants: [...real, ...synthetic],
      connection: 'connected',
      wsState: 'open',
      // The preview is a *normal* call: the header must read “Подключено” in
      // green, not the artificial “server offline” state of the old fixtures.
      serverOnline: true,
      integrity: {},
    });
    // A preview scene behaves like a joined call for viewport-dependent layout:
    // without this the resize handler never reflows pages (QA Q-7).
    this.joined = true;
    if (opts.layout) this.store.patchSection('settings', this.layoutSettings(this.store.getState(), opts.layout));
    if (opts.controls) {
      this.store.setState({ config: { ...this.store.getState().config, layout: { ...this.store.getState().config.layout, controlsStyle: opts.controls } } });
    }
    this.syncGallery();
  }

  clearSimulatedParticipants(): void {
    this.simulatedParticipants = [];
    const backup = this.simulationBackup;
    this.simulationBackup = null;
    if (!backup) return;
    this.joined = backup.joined;
    this.store.setState({
      participants: backup.participants,
      self: backup.self,
      phase: backup.phase,
      serverOnline: backup.serverOnline,
      connection: backup.connection,
      wsState: backup.wsState,
      gallery: { ...this.store.getState().gallery, page: 0 },
    });
    this.syncGallery();
  }

  persistSession(enabled = true): void {
    this.persistEnabled = enabled;
    if (enabled) this.writeSessionHandoff();
    else clearPersistedSession();
  }

  async resume(): Promise<void> {
    const saved = readPersistedSession();
    if (saved) {
      if (saved.room !== this.roomId) throw new Error('Persisted session belongs to another room');
      if (saved.token) {
        this.joinToken = saved.token;
        this.api.token = saved.token;
      }
      if (saved.tenantId) this.options.tenantId = saved.tenantId;
      if (saved.participantName) this.options.participantName = saved.participantName;
    }
    if (!this.joined) await this.join();
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                         */
  /* ------------------------------------------------------------------ */

  leave(): void {
    if (!this.joined && this.destroyed) return;
    this.joined = false;
    this.participantSound?.pause();
    this.lastParticipantSoundAt = -Infinity;
    this.destroyed = false;
    this.sessionEpoch += 1;
    this.cancelRecordingConsent?.();
    this.setVideoUpgrade(null);
    this.videoConsentPeer = undefined;
    this.stopLobbyTimers();
    this.stopHostLobbyPolling();
    this.resetBreakoutState();
    this.geoRequested = false;
    this.lobbyRequestId = null;
    this.detachPictureInPicture();
    this.spotlightOverlay?.hide();
    this.inCallAssistant?.clear();
    // Leaving must return to a clean join screen: close the polls modal and
    // every side panel, and drop stale connection/degradation toasts (DC-04).
    this.pollsPanel?.close();
    this.annotationMode = false;
    this.whiteboardLoadPending = false;
    // Drop collaboration state queued for the room being left; the next join
    // replays a fresh welcome snapshot.
    this.collaborationQueue = [];
    this.pendingWhiteboardSnapshot = null;
    this.pendingAnnotationSnapshot = null;
    this.whiteboardPanel?.reset();
    this.annotationOverlay?.reset();
    this.store.setState({
      whiteboard: { ...this.store.getState().whiteboard, visible: false, open: false, locked: false, strokes: 0 },
      annotation: { ...this.store.getState().annotation, active: false, presenterId: null, selfSharing: false, strokes: 0 },
    });
    this.app.toasts.clear();
    this.app.clearParticipantNotice?.();
    clearPersistedSession();
    this.stopTimers();
    this.captions?.stop();
    this.captions = null;
    this.integrity?.stop();
    this.integrity = null;
    if (this.recorder?.active) {
      this.broadcastRecordingState(false, null);
      void this.recorder.stop();
    }
    this.recorder?.destroy();
    this.recorder = null;
    this.blurProcessor?.stop();
    this.blurProcessor = null;
    this.engine?.close();
    this.engine = null;
    this.sfu?.dispose();
    this.sfu = null;
    this.sfuSession = null;
    this.mediaPlane = 'mesh';
    this.controllersReady = false;
    // `SignalingClient.close()` emits `exhausted` synchronously; suppress the
    // "could not restore the connection" toast for a deliberate user leave.
    this.suppressSocketToasts = true;
    this.sfuRetrying = false;
    this.recoveringSession = false;
    if (this.resumeStatusTimer) {
      clearTimeout(this.resumeStatusTimer);
      this.resumeStatusTimer = null;
    }
    this.resumeState.reset();
    this.wsPeerIds.clear();
    this.pendingMeshSignals.length = 0;
    this.signaling?.close('user leave');
    this.signaling = null;
    this.suppressSocketToasts = false;
    this.chat?.cancelPending();
    this.chat = null;
    this.assistant = null;
    this.stopLocalMedia();
    this.notes.clear();
    this.firstWelcome = true;
    this.lastSpeakerId = null;
    this.store.setState({
      phase: 'left',
      audioOnly: Boolean(this.options.audioOnly),
      connection: 'closed',
      wsState: 'closed',
      resumeStatus: 'idle',
      participants: [],
      gallery: {
        ...this.store.getState().gallery,
        page: 0,
        pageCount: 1,
        total: 0,
        speakerId: null,
        promotedVideoIds: [],
      },
      remoteStreams: {},
      screenStream: null,
      localStream: null,
      recording: { active: false, startedAt: null, consentPending: false, degraded: false, remoteActive: false, remoteStartedAt: null, remoteByName: null },
      lobby: createInitialLobby(),
      lobbyQueue: [],
    });
    this.store.patchSection('settings', { panel: 'none', screenSharing: false, degraded: false, blurMode: 'off', sfuStatus: 'off',
      ...(this.options.audioOnly ? { camEnabled: false } : {}) });
    this.emitLocal('left', {});
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.widgetDisposed = true;
    this.cancelRecordingConsent?.();
    this.collaborationQueue = [];
    this.pendingWhiteboardSnapshot = null;
    this.pendingAnnotationSnapshot = null;
    this.sessionEpoch += 1;
    // Timers must stop even if `leave()` short-circuits on a pre-join destroy.
    this.stopBreakoutTicker();
    this.breakoutSwitching = false;
    this.stopLobbyTimers();
    this.stopHostLobbyPolling();
    this.lobbyRequestId = null;
    if (this.fullscreenHandler && typeof document !== 'undefined') {
      document.removeEventListener('fullscreenchange', this.fullscreenHandler);
      this.fullscreenHandler = null;
    }
    if (this.shortcutHandler && typeof document !== 'undefined') {
      document.removeEventListener('keydown', this.shortcutHandler);
      this.shortcutHandler = null;
    }
    if (this.galleryResizeHandler && typeof window !== 'undefined') {
      window.removeEventListener('resize', this.galleryResizeHandler);
      this.galleryResizeHandler = null;
    }
    if (this.galleryResizeTimer) {
      clearTimeout(this.galleryResizeTimer);
      this.galleryResizeTimer = null;
    }
    this.leave();
    this.releaseParticipantSound?.();
    this.spotlightOverlay?.destroy();
    this.spotlightOverlay = null;
    this.annotationUnsub?.();
    this.annotationUnsub = null;
    this.whiteboardPanel?.destroy();
    this.whiteboardPanel = null;
    this.annotationOverlay?.destroy();
    this.annotationOverlay = null;
    this.app.destroy();
    this.iconOverrides?.destroy();
    this.iconOverrides = null;
    this.customCssDispose();
    this.storeSubscription?.();
    this.storeSubscription = null;
    // Public `subscribe()` callbacks live in the store, not in `events`: clear
    // them too so `destroy()` really removes "all listeners" (QA P3-3).
    this.store.clearSubscribers();
    this.theme.dispose();
    this.events.clear();
    this.root.remove();
  }

  async sendChat(text: string): Promise<ChatMessage> {
    const state = this.store.getState();
    // In headless mode the host owns chat placement, so the built-in
    // `chatMode: 'hidden'` presentation switch must not block `sendChat()`.
    if ((!this.headless && state.settings.chatMode === 'hidden') || !canSendChat(state)) {
      this.app.showToast(this.i18n.t('notAvailable'), 'warning');
      throw new Error('chat is not allowed');
    }
    if (!this.chat) {
      const local: ChatMessage = {
        id: `local-${Date.now()}`,
        roomId: this.roomId,
        from: { id: this.selfId || 'self', name: state.self?.name ?? this.i18n.t('you'), role: state.self?.role ?? 'guest' },
        text,
        ts: Date.now(),
        kind: 'text',
      };
      this.appendChat(local);
      return local;
    }
    const message = await this.chat.send(text);
    this.maybeAnnounceModeration();
    return message;
  }

  /** Webinar moderated chat: tell the viewer the message is queued for review. */
  private maybeAnnounceModeration(): void {
    const state = this.store.getState();
    const webinar = state.config.scale.webinar;
    if (!webinar.enabled || webinar.chatMode !== 'moderated') return;
    const role = state.self?.role ?? 'guest';
    if (role === 'host' || role === 'moderator') return;
    this.chat?.systemMessage(this.i18n.t('chatModerationPending'));
    this.app.showToast(this.i18n.t('chatModerationPending'), 'info', 4000);
  }

  async getStats(): Promise<CallStats> {
    const state = this.store.getState();
    const sfuReport = this.mediaPlane === 'sfu' && this.sfu ? await this.sfu.collectStats() : null;
    const report = this.engine ? await this.engine.collectStats() : sfuReport;
    return {
      phase: state.phase,
      connectionState: state.connection,
      wsState: state.wsState,
      resumeStatus: state.resumeStatus,
      qualityTier: state.quality.tier,
      qualityScore: state.quality.score,
      rttMs: state.quality.rttMs,
      packetLossPct: state.quality.packetLossPct,
      jitterMs: state.quality.jitterMs,
      inboundBitrateKbps: report?.snapshot.inboundBitrateKbps ?? state.quality.inboundBitrateKbps,
      outboundBitrateKbps: report?.outboundBitrateKbps ?? 0,
      fps: report?.snapshot.fps ?? state.quality.fps,
      resolution: { width: report?.snapshot.width ?? state.quality.width, height: report?.snapshot.height ?? state.quality.height },
      participants: state.participants.length + (state.self ? 1 : 0),
      durationSec: state.durationSec,
      screenSharing: state.settings.screenSharing,
      recording: state.recording.active,
      captions: this.captions?.isListening ?? false,
      blurMode: state.settings.blurMode,
      blurDegraded: state.settings.blurDegraded,
      lowBandwidthDegraded: state.settings.degraded,
      minimized: state.settings.minimized,
      chatMode: state.settings.chatMode,
      chrome: state.settings.chrome,
      fullscreen: state.settings.fullscreen,
      mediaMode: state.settings.mediaMode,
      viewer: state.settings.viewer,
      iceRestarts: report?.iceRestarts ?? this.iceRestartCount,
      iceServers: this.iceServers.length,
      localTracks: {
        audio: state.localStream?.getAudioTracks().length ?? 0,
        video: state.localStream?.getVideoTracks().length ?? 0,
      },
      remotePeers: this.sfu?.peersCount ?? this.engine?.peersCount ?? Object.keys(state.remoteStreams).length,
      serverOnline: state.serverOnline,
      locale: this.i18n.current,
      themeScheme: this.theme.current?.scheme ?? 'light',
    };
  }

  getState(): CallState {
    return this.store.getState();
  }

  getLocalStream(): MediaStream | null {
    return this.store.getState().localStream;
  }

  getRemoteStreams(): Record<string, MediaStream> {
    return withoutEmptyRemoteStreams(this.store.getState().remoteStreams);
  }

  getScreenStream(): MediaStream | null {
    return this.store.getState().screenStream;
  }

  getSelf(): Participant | null {
    return this.store.getState().self;
  }

  getParticipants(): Participant[] {
    return [...this.store.getState().participants];
  }

  /* ------------------------------------------------------------------ */
  /* Large-room gallery (stage 1)                                       */
  /* ------------------------------------------------------------------ */

  /**
   * “Play video” on a gallery tile. Promotes the participant into the video
   * budget (newest first); the plan evicts the lowest-priority video (off-page
   * first, then the first non-pinned page tile) and never exceeds
   * `scale.maxVideoSubscriptions`. Pinned participants are already first and
   * need no promotion.
   */
  private promoteGalleryVideo(participantId: string): void {
    const state = this.store.getState();
    if (!state.participants.some((participant) => participant.id === participantId)) return;
    const current = state.gallery.promotedVideoIds.filter((id) => id !== participantId);
    const promotedVideoIds = [participantId, ...current].slice(0, Math.max(1, state.gallery.pageSize));
    this.store.setState({ gallery: { ...state.gallery, promotedVideoIds } });
    this.syncSfuSubscriptions();
  }

  setGalleryPage(page: number): void {
    const state = this.store.getState();
    const pageCount = galleryPageCount(state.participants.length, Boolean(state.self), state.gallery.pageSize);
    const next = clampGalleryPage(page, pageCount);
    if (next !== state.gallery.page) {
      this.store.setState({ gallery: { ...state.gallery, page: next } });
    }
    const first = pageParticipants(state.participants, galleryPageInfo(state.participants.length, Boolean(state.self), state.gallery.pageSize, next))[0];
    if (first && this.app instanceof WidgetApp) this.app.revealGalleryParticipant(next === 0 ? state.self?.id ?? first.id : first.id);
    this.syncSfuSubscriptions();
  }

  setFollowSpeaker(enabled: boolean): void {
    const state = this.store.getState();
    const followSpeaker = enabled === true;
    if (state.gallery.followSpeaker === followSpeaker) return;
    const speakerId = followSpeaker ? this.lastSpeakerId : state.gallery.speakerId;
    const page =
      followSpeaker && state.settings.layoutMode !== 'spotlight'
        ? pageForParticipantId(state.participants, speakerId, Boolean(state.self), state.gallery.pageSize) ?? state.gallery.page
        : state.gallery.page;
    this.store.setState({ gallery: { ...state.gallery, followSpeaker, speakerId, page } });
    if (followSpeaker && speakerId && this.app instanceof WidgetApp) this.app.revealGalleryParticipant(speakerId);
    this.syncSfuSubscriptions();
  }

  /**
   * Explicit grid/speaker view switch (pager segmented control).
   *
   * Unlike the old toggle, selecting the already-active view is a no-op, so a
   * click on “Сетка” while in the grid cannot flip the room into speaker view.
   */
  setSpeakerView(enabled: boolean): void {
    const state = this.store.getState();
    const layoutMode = enabled ? 'spotlight' : this.config.layout.mode === 'sidebar' ? 'sidebar' : 'grid';
    if (state.settings.layoutMode === layoutMode) return;
    this.store.patchSection('settings', this.layoutSettings(state, layoutMode));
    if (layoutMode === 'spotlight' && this.lastSpeakerId) {
      this.store.setState({ gallery: { ...this.store.getState().gallery, speakerId: this.lastSpeakerId } });
    }
    this.syncSfuSubscriptions();
  }

  setVideoQuality(quality: VideoQualityPreference): void {
    const next = normalizeVideoQuality(quality);
    this.store.patchSection('settings', { videoQuality: next });
    this.sfu?.setVideoQuality(next);
    this.syncSfuSubscriptions();
  }

  /** Recomputes page count/size and the adaptive SFU video budget from current state. */
  private syncGallery(): void {
    const state = this.store.getState();
    const pageSize = resolvePageSize(typeof window !== 'undefined' ? window.innerWidth : 1280);
    const total = state.participants.length;
    const pageCount = galleryPageCount(total, Boolean(state.self), pageSize);
    const page = clampGalleryPage(state.gallery.page, pageCount);
    const maxVideoSubscriptions = configuredVideoSubscriptionLimit(state.config.limits.maxVideoSubscriptions, state.config.scale.maxVideoSubscriptions);
    // Thresholds count every participant, including the local self tile; the
    // self preview itself is not an SFU subscription.
    const videoBudget = resolveGalleryVideoBudgetForConfig(
      state.config,
      total + (state.self ? 1 : 0),
    );
    const speakerId =
      state.gallery.speakerId && state.participants.some((participant) => participant.id === state.gallery.speakerId)
        ? state.gallery.speakerId
        : this.lastSpeakerId && state.participants.some((participant) => participant.id === this.lastSpeakerId)
          ? this.lastSpeakerId
          : null;
    // Promotions for participants who left are dead weight; keep the list
    // bounded even when the user promotes many tiles across pages.
    const promotedVideoIds = state.gallery.promotedVideoIds
      .filter((id) => state.participants.some((participant) => participant.id === id))
      .slice(0, Math.max(1, pageSize));
    const next: GalleryState = {
      ...state.gallery,
      pageSize,
      pageCount,
      total,
      page,
      speakerId,
      maxVideoSubscriptions,
      videoBudget,
      promotedVideoIds,
    };
    const promotionsChanged =
      next.promotedVideoIds.length !== state.gallery.promotedVideoIds.length ||
      next.promotedVideoIds.some((id, index) => id !== state.gallery.promotedVideoIds[index]);
    if (
      next.page !== state.gallery.page ||
      next.pageSize !== state.gallery.pageSize ||
      next.pageCount !== state.gallery.pageCount ||
      next.total !== state.gallery.total ||
      next.speakerId !== state.gallery.speakerId ||
      next.maxVideoSubscriptions !== state.gallery.maxVideoSubscriptions ||
      next.videoBudget !== state.gallery.videoBudget ||
      promotionsChanged
    ) {
      this.store.setState({ gallery: next });
    }
    this.syncSfuSubscriptions();
  }

  /** Applies the current page/pin/speaker as the SFU video subscription policy. */
  private syncSfuSubscriptions(): void {
    const sfu = this.sfu;
    if (!sfu || this.mediaPlane !== 'sfu') return;
    const state = this.store.getState();
    const inRoom = (id: string | null | undefined): string | null =>
      id && state.participants.some((participant) => participant.id === id) ? id : null;
    const pinnedId = inRoom(state.settings.pinnedId);
    const speakerId = state.gallery.followSpeaker ? inRoom(state.gallery.speakerId) : null;
    const tileDimensions = this.app instanceof WidgetApp ? this.app.getVideoTileDimensions() : undefined;
    if (state.settings.layoutMode === 'spotlight') {
      // Speaker view renders exactly one large tile: subscribe only it (and
      // never 35 off-screen page videos). Audio stays subscribed for everyone.
      const featured = pinnedId ?? speakerId ?? inRoom(state.participants[0]?.id) ?? null;
      sfu.setVideoSubscriptionPolicy({
        visibleIds: featured ? [featured] : [],
        pinnedId: featured === pinnedId ? pinnedId : null,
        speakerId: featured === speakerId ? speakerId : null,
        maxSubscriptions: 1,
        tileDimensions,
      });
      return;
    }
    const plan = planVideoSubscriptions({
      participants: state.participants,
      page: state.gallery.page,
      pageSize: state.gallery.pageSize,
      hasSelf: Boolean(state.self),
      pinnedId,
      speakerId,
      maxVideoSubscriptions: state.gallery.maxVideoSubscriptions,
      promotedIds: state.gallery.promotedVideoIds,
      galleryVideoBudget: state.config.limits.galleryVideoBudget,
      maxVisibleVideos: state.config.scale.maxVisibleVideos,
      capacityProfile: state.config.scale.sfu.capacityProfile,
      viewportIds: this.app instanceof WidgetApp ? this.app.getGalleryViewportIds() : undefined,
    });
    // The plan is authoritative: a promotion may have evicted the automatic
    // speaker from a tight budget, so only pass pinned/speaker ids that are
    // actually in `plan.submit`. Passing a stale speaker id would make the
    // engine prepend it and subscribe a third video.
    sfu.setVideoSubscriptionPolicy({
      visibleIds: plan.submit,
      pinnedId: pinnedId && plan.submit.includes(pinnedId) ? pinnedId : null,
      speakerId: speakerId && plan.submit.includes(speakerId) ? speakerId : null,
      maxSubscriptions: plan.maxSubscriptions,
      pace: plan.page.pageCount > 1,
      immediateVideoIds: state.gallery.promotedVideoIds,
      tileDimensions,
    });
  }

  /** Called by the SFU/mesh audio analyser only on speaking transitions. */
  private handleSpeaking(participantId: string, speaking: boolean): void {
    this.app.setSpeaking(participantId, speaking);
    if (speaking) this.followSpeakingParticipant(participantId);
  }

  private followSpeakingParticipant(participantId: string): void {
    const state = this.store.getState();
    if (!state.participants.some((participant) => participant.id === participantId)) return;
    this.lastSpeakerId = participantId;
    if (!state.gallery.followSpeaker) return;
    const speakerPage =
      state.settings.layoutMode !== 'spotlight'
        ? pageForParticipantId(state.participants, participantId, Boolean(state.self), state.gallery.pageSize)
        : null;
    const page = speakerPage === null ? state.gallery.page : speakerPage;
    if (page !== state.gallery.page || state.gallery.speakerId !== participantId) {
      this.store.setState({ gallery: { ...state.gallery, speakerId: participantId, page } });
      if (this.app instanceof WidgetApp) this.app.revealGalleryParticipant(participantId);
      this.syncSfuSubscriptions();
    }
  }

  subscribe(listener: (state: CallState) => void): () => void {
    return this.store.subscribe((state) => listener(state));
  }

  on(eventName: AgilWidgetEventName, listener: (payload: unknown) => void): () => void {
    return this.events.on(eventName, listener);
  }

  /* ------------------------------------------------------------------ */
  /* Local actions wiring                                               */
  /* ------------------------------------------------------------------ */

  private buildActions(): AppActions {
    return {
      onJoin: (input) => {
        this.pendingJoin = input;
        if (input.listenOnly) this.store.patchSection('settings', { micEnabled: false, camEnabled: false });
        void this.join();
      },
      onOfflineDemo: () => this.enterOfflineDemo(),
      onLobbyCancel: () => this.leaveLobby(this.i18n.t('lobbyCancelled')),
      onLobbyRetry: () => this.retryLobby(),
      onLobbyBack: () => this.leaveLobby(),
      onLobbyAdmit: (requestId) => this.admitLobbyRequest(requestId),
      onLobbyReject: (requestId) => this.rejectLobbyRequest(requestId),
      onLobbyAdmitAll: () => this.admitAllLobbyRequests(),
      onLobbyRefresh: () => this.fetchLobbyQueue(false),
      onTogglePreviewMic: () => {
        const state = this.store.getState();
        const next = !state.settings.micEnabled;
        this.store.patchSection('settings', { micEnabled: next });
        if (this.media.audioTrack) this.media.audioTrack.enabled = next;
        else if (next) void this.acquirePreviewMedia();
      },
      onTogglePreviewCamera: () => {
        const state = this.store.getState();
        if (state.audioOnly) return;
        const next = !state.settings.camEnabled;
        this.store.patchSection('settings', { camEnabled: next });
        if (this.media.videoTrack) this.media.videoTrack.enabled = next;
        else if (next) void this.acquirePreviewMedia();
      },
      onToggleMic: () => void this.toggleMic(),
      onToggleCamera: () => {
        const state = this.store.getState();
        const upgrade = state.videoUpgrade;
        if (upgrade?.direction === 'incoming') void this.respondToVideoUpgrade(upgrade.requestId, true);
        else if (state.audioOnly) this.requestVideoUpgrade();
        else void this.toggleCamera();
      },
      onToggleScreen: () => void this.toggleScreenShare(),
      onCycleBlur: () => void this.cycleBlur(),
      onToggleChat: () => this.openPanel('chat'),
      onOpenPanel: (panel) => this.openPanel(panel),
      onToggleHand: () => this.toggleHand(),
      onReaction: (emoji) => this.sendReaction(emoji),
      onToggleSettings: () => this.openPanel('settings'),
      onToggleRecording: () => void this.toggleRecording(),
      onToggleCaptions: () => void this.toggleCaptions(),
      onToggleAssistant: () => this.openPanel('assistant'),
      onOpenPopover: () => {
        this.pollsPanel?.close();
        if (this.store.getState().settings.panel !== 'none') this.closePanel();
      },
      onTogglePolls: () => {
        this.closePanel();
        if (this.pollsPanel?.isOpen()) this.pollsPanel.close();
        else this.pollsPanel?.open();
      },
      onToggleWhiteboard: () => this.toggleWhiteboard(),
      onToggleAnnotations: () => this.toggleAnnotations(),
      onBreakoutStart: (input) => this.startBreakout(input),
      onBreakoutCloseAll: () => this.closeAllBreakouts(),
      onBreakoutRefresh: () => this.loadBreakoutPlan(),
      onBreakoutReturn: () => {
        void this.returnToMainRoom({ viaApi: true });
      },
      onToggleBreakout: () => this.openPanel('breakout'),
      onLeave: () => this.leave(),
      onClosePanel: () => this.closePanel(),
      onSendChat: async (text) => {
        try {
          await this.sendChat(text);
        } catch (error) {
          const key = error instanceof Error && error.message === 'delivery_unconfirmed'
            ? 'chatDeliveryUnconfirmed' : 'chatSendError';
          this.app.showToast(this.i18n.t(key), 'warning');
          throw error;
        }
      },
      onAttachFile: (file) => {
        const state = this.store.getState();
        if (!this.chat || !canSendChat(state) || !canFeature(state, 'fileShare')) return;
        void this.chat.sendFile(file);
      },
      onDownload: (url, name) => triggerDownload(url, name),
      onSeek: (seconds) => {
        this.openPanel('transcript');
        this.app.showToast(`${this.i18n.t('transcriptTitle')}: ${formatDuration(seconds)}`, 'info', 2500);
      },
      onExportTranscript: () => this.exportTranscript(),
      onAskAssistant: (question) => {
        const state = this.store.getState();
        if (question.length > 2000) {
          this.app.showToast(this.i18n.t('assistantTooLong'), 'warning');
          return;
        }
        if (state.inCallAssistant.available) {
          this.ensureInCallAssistant();
          void this.inCallAssistant?.ask(question);
          return;
        }
        if (!state.assistant.available || !this.assistant) {
          this.app.showToast(state.assistant.denyMessage || this.i18n.t('assistantForbidden'), 'warning');
          return;
        }
        this.assistant.ask(question);
        this.syncAssistantState();
      },
      onNoiseSuppression: (enabled) => this.setNoiseSuppression(enabled),
      onMicDevice: (deviceId) => {
        void this.switchMicrophone(deviceId);
      },
      onCamDevice: (deviceId) => {
        void this.switchCamera(deviceId);
      },
      registerAudioOutput: (element) => this.audioOutput.register(element),
      onSpeakerDevice: async (deviceId) => {
        try {
          await this.audioOutput.select(deviceId, this.root.ownerDocument);
          this.store.patchSection('settings', { speakerDeviceId: deviceId });
          return true;
        } catch {
          this.app.showToast(this.i18n.t('settingsSpeakerError'), 'warning');
          return false;
        }
      },
      onMirrorSelfView: (enabled) => this.store.patchSection('settings', { mirrorSelfView: enabled }),
      onBlurMode: (mode, imageUrl) => void this.setBlurMode(mode, imageUrl),
      onBlurStrength: (value) => {
        this.store.patchSection('settings', { blurStrength: value });
        this.blurProcessor?.setStrength(value);
      },
      onLanguage: (locale) => this.setLocale(locale),
      onThemeScheme: (scheme) => this.setThemeScheme(scheme),
      onLocationConsent: (consent) => this.requestLocation(consent),
      onFullscreen: () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void this.root.requestFullscreen?.().catch(() => undefined);
      },
      onPip: () => {
        const video = this.root.querySelector<HTMLVideoElement>('[data-agil-tile][data-self="true"] video');
        if (!video) return;
        const pipVideo = video as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> };
        if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
        else void pipVideo.requestPictureInPicture?.().catch(() => undefined);
      },
      onCopyLink: () => void this.copyLink(),
      onPin: (participantId) => {
        // Pinning also makes the participant visible: a 200-person gallery may
        // have the pinned tile on another page.
        const state = this.store.getState();
        if (!participantId) {
          this.store.patchSection('settings', { pinnedId: null });
          this.syncSfuSubscriptions();
          return;
        }
        const page = pageForParticipantId(state.participants, participantId, Boolean(state.self), state.gallery.pageSize);
        this.store.patchSection('settings', { pinnedId: participantId });
        if (page !== null && page !== state.gallery.page) {
          this.store.setState({ gallery: { ...this.store.getState().gallery, page } });
        }
        if (this.app instanceof WidgetApp) this.app.revealGalleryParticipant(participantId);
        this.syncSfuSubscriptions();
      },
      onPlayVideo: (participantId) => this.promoteGalleryVideo(participantId),
      onGalleryViewportChange: () => this.syncSfuSubscriptions(),
      getGalleryCamera: (participantId) => this.mediaPlane === 'sfu' ? this.sfu?.galleryCamera(participantId) ?? null : null,
      onManualGalleryScroll: () => this.setFollowSpeaker(false),
      onToggleFollowSpeaker: () => this.setFollowSpeaker(!this.store.getState().gallery.followSpeaker),
      onToggleSpeakerView: () => {
        this.setSpeakerView(this.store.getState().settings.layoutMode !== 'spotlight');
      },
      onSetSpeakerView: (enabled) => {
        this.setSpeakerView(enabled === true);
      },
      onVideoQuality: (quality) => this.setVideoQuality(quality),
      onLocateParticipant: (participantId) => {
        const state = this.store.getState();
        const page = pageForParticipantId(state.participants, participantId, Boolean(state.self), state.gallery.pageSize);
        this.store.patchSection('settings', { pinnedId: participantId });
        if (page !== null) this.store.setState({ gallery: { ...this.store.getState().gallery, page } });
        if (this.app instanceof WidgetApp) this.app.revealGalleryParticipant(participantId, true);
        this.syncSfuSubscriptions();
      },
      onMinimize: () => this.minimize(),
      onRestore: () => this.restore(),
      onRequestPip: () => {
        if (this.pipWindow) this.restore();
        else void this.requestPictureInPicture();
      },
      onToggleFullscreen: () => {
        if (this.store.getState().settings.fullscreen) void this.exitFullscreen();
        else void this.requestFullscreen();
      },
      onOpenNewTab: () => {
        this.openInNewTab();
      },
      getDevices: () => this.media.enumerate(),
    };
  }

  private async acquirePreviewMedia(): Promise<void> {
    const state = this.store.getState();
    const result = await this.media.acquire(this.config, {
      micEnabled: state.settings.micEnabled,
      camEnabled: state.settings.camEnabled && !state.audioOnly,
      micDeviceId: state.settings.micDeviceId,
      camDeviceId: state.settings.camDeviceId,
    });
    this.store.setState({ localStream: result.stream });
    this.store.patchSection('settings', {});
    this.applyLocalTrackState();
    this.syncNoiseDetection();
  }

  async setNoiseSuppression(enabled: boolean): Promise<boolean> {
    try {
      await this.media.setNoiseSuppression(enabled);
      this.store.patchSection('settings', { noiseSuppression: enabled });
      return true;
    } catch {
      this.app.showToast(this.i18n.t('microphoneNoiseSuppressionError'), 'warning');
      return false;
    }
  }

  async switchMicrophone(deviceId: string): Promise<void> {
    // The old track is stopped by MediaController; never keep an analyser on it.
    this.stopNoiseDetection();
    try {
      await this.media.switchMicrophone(this.config, deviceId);
      this.engine?.setLocalStream(this.media.localStream);
      this.engine?.refreshAudioSenders();
      if (this.media.audioTrack) this.media.audioTrack.enabled = this.store.getState().settings.micEnabled;
      void this.sfu?.setAudioTrack(this.media.audioTrack, this.store.getState().settings.micEnabled);
      this.store.patchSection('settings', { micDeviceId: deviceId });
      this.store.setState({ localStream: this.media.localStream });
      this.syncNoiseDetection();
    } catch {
      this.app.showToast(this.i18n.t('micError'), 'warning');
      // Keep the previous device monitored even if the switch failed.
      this.syncNoiseDetection();
    }
  }

  async switchCamera(deviceId: string): Promise<void> {
    if (this.store.getState().audioOnly) {
      this.store.patchSection('settings', { camDeviceId: deviceId });
      return;
    }
    const previousDevice = this.store.getState().settings.camDeviceId;
    try {
      const track = await this.media.switchCamera(this.config, deviceId);
      const actualDevice = track.getSettings?.().deviceId;
      // Some browsers omit deviceId on synthetic/mock tracks; only fail on a real mismatch.
      if (deviceId && actualDevice && actualDevice !== deviceId) {
        throw new Error('device_mismatch');
      }
      this.store.setState({ localStream: this.media.localStream });
      this.engine?.setLocalStream(this.media.localStream);
      this.engine?.refreshVideoSenders();
      if (this.media.videoTrack) this.media.videoTrack.enabled = this.store.getState().settings.camEnabled;
      void this.sfu?.setCameraTrack(this.media.videoTrack, this.store.getState().settings.camEnabled);
      this.store.patchSection('settings', { camDeviceId: deviceId });
      if (this.store.getState().settings.blurMode !== 'off') {
        await this.restartBlurIfNeeded();
      } else {
        this.applySelfPreviewVideo(null);
      }
      void this.setupAudioLevels();
    } catch {
      this.store.patchSection('settings', { camDeviceId: previousDevice });
      this.app.showToast(this.i18n.t('cameraSwitchFailed'), 'warning', 7000);
    }
  }

  private toggleHand(): void {
    this.raiseHand(!this.store.getState().settings.handRaised);
  }

  /** Public: raises (`force=true`) or lowers the hand. Returns the new state. */
  raiseHand(force = true): boolean {
    const state = this.store.getState();
    if (!canFeature(state, 'handRaise')) return false;
    const raised = force === true;
    if (state.settings.handRaised === raised) return raised;
    this.store.patchSection('settings', { handRaised: raised });
    this.syncSelfState({ handRaised: raised });
    this.emitLocal('media-state', { handRaised: raised });
    return raised;
  }

  lowerHand(): void {
    this.raiseHand(false);
  }

  /** Public: sends a reaction (max 16 chars). Returns false when rejected. */
  sendReaction(emoji: string): boolean {
    const normalized = normalizeReaction(emoji);
    if (!normalized) return false;
    const state = this.store.getState();
    if (!canFeature(state, 'reactions')) return false;
    this.signaling?.send({ type: 'reaction', emoji: normalized, ts: Date.now() });
    this.app.showReaction(normalized, state.self?.name ?? this.i18n.t('you'));
    this.emitLocal('reaction', {
      emoji: normalized,
      participantId: state.self?.id ?? this.selfId,
      name: state.self?.name ?? this.i18n.t('you'),
      self: true,
    });
    return true;
  }

  private async toggleCaptions(): Promise<void> {
    const state = this.store.getState();
    if (!canFeature(state, 'captions') || !this.config.session.transcription.enabled || this.config.session.transcription.provider === 'off') {
      this.app.showToast(this.i18n.t('notAvailable'), 'warning');
      return;
    }
    if (!this.captions) return;
    if (state.settings.captionsVisible) {
      this.captions.stop();
      this.store.patchSection('settings', { captionsVisible: false });
      this.app.showToast(this.i18n.t('captionsOff'), 'info', 1800);
      return;
    }
    this.store.patchSection('settings', { captionsVisible: true });
    const started = await this.captions.start();
    this.app.showToast(started ? this.i18n.t('captionsOn') : this.i18n.t('transcriptUnavailable'), started ? 'info' : 'warning', 2200);
  }

  private setLocale(locale: Locale): void {
    if (!this.config.session.locales.includes(locale)) return;
    this.i18n.setLocale(locale);
    this.root.setAttribute('lang', locale);
    if (this.options.embedded) document.documentElement.lang = locale;
    this.store.patchSection('settings', { locale });
    this.captions?.setLanguage(this.captionsLanguage());
    this.rebuildApp();
  }

  private rebuildApp(): void {
    this.app.destroy();
    this.app = this.headless
      ? new HeadlessUi(this.root, this.store, (message, kind, actions) =>
          this.emitLocal('toast', { message, kind, ...(actions ? { actions } : {}) }),
        )
      : new WidgetApp(this.root, this.store, this.i18n, this.buildActions(), Boolean(this.options.embedded), this.roomId);
  }

  private enterOfflineDemo(): void {
    this.offlineDemo = true;
    this.mediaPlane = 'mesh';
    this.sfuSession = null;
    this.pendingJoin = { name: this.options.participantName ?? this.i18n.t('guest') };
    this.store.setState({ phase: 'joining', serverOnline: false });
    void (async () => {
      await this.acquireLocalMedia();
      const self: Participant = {
        id: 'demo-self',
        name: this.options.participantName ?? this.i18n.t('guest'),
        role: this.options.role ?? 'guest',
        joinedAt: Date.now(),
        state: { mic: 'on', cam: 'on', screen: false, handRaised: false, network: 'good' },
        verified: false,
        integrity: 'unknown',
      };
      this.selfId = self.id;
      this.store.setState({
        self,
        phase: 'joined',
        serverOnline: false,
        permissions: resolveLocalPermissions(this.config, self.role),
        room: { id: this.roomId, tenantId: this.tenantId, name: this.config.room.name, createdAt: Date.now(), locked: false },
      });
      this.applyAssistantAvailability();
      this.enterJoinedState();
      this.startTimers();
      this.store.setState({ serverOnline: false });
      this.app.showToast(this.i18n.t('demoModeBanner'), 'warning', 6000);
    })();
  }

  private stopTimers(): void {
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
  }

  private emitLocal(eventName: AgilWidgetEventName, payload: unknown): void {
    const event: AgilWidgetEvent = { type: eventName, payload, ts: Date.now() };
    this.events.emit(eventName, payload as never);
    this.options.onEvent?.(event);
  }
}

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const result: ChatMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message.id !== 'string' || seen.has(message.id)) continue;
    seen.add(message.id);
    result.push(message);
  }
  return result;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mounts the widget into a container.
 *
 * The join screen is shown immediately; camera/microphone access is only
 * requested after the user presses «Войти» (or when a join token is supplied).
 */
export async function mountWidget(container: HTMLElement, options: AgilCallOptions): Promise<AgilWidgetInstance> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('mountWidget() requires a browser environment');
  }
  if (!container) throw new Error('mountWidget(): container element is required');
  if (!options) throw new Error('mountWidget(): options are required');
  const effectiveOptions = mergeResumedOptions(options);
  if (typeof effectiveOptions.room !== 'string' || effectiveOptions.room.length === 0) {
    throw new Error('mountWidget(): options.room is required (or pass resume:true with a saved session)');
  }
  const session = new AgilWidgetSession(container, effectiveOptions);
  await session.init();
  return session;
}

export { EVENTS as agilWidgetEventNames };
export { parseClientMessage };
