/**
 * Public API types of `@agil/calls-widget` (contract §6).
 *
 * These names/signatures are frozen by the contract — other packages and
 * integrators depend on them. Internal types live next to the modules that use
 * them; everything exported from here is part of the public surface.
 */
import type {
  AssistantAction,
  AssistantSpotlight,
  BreakoutPlan,
  ChatMessage,
  ComplianceFinding,
  FeatureKey,
  KnowledgeCitation,
  Locale,
  LobbyJoinResponse,
  LobbyRequestInfo,
  MeetingNotes,
  Participant,
  ParticipantIntegrity,
  ParticipantState,
  RoomInfo,
  TenantConfig,
  TenantConfigPatch,
  ThemePatch,
  ThemePresetName,
  ThemeScheme,
  ThemeTokens,
  TranscriptSegment,
  QualityTier,
} from '@agil/protocol';
import type { NoiseLevel } from './call/noise-detection.js';
import type { VideoQualityPreference } from './call/large-room.js';

/* ------------------------------------------------------------------ */
/* Options / instance                                                  */
/* ------------------------------------------------------------------ */

/** `default` renders the built-in UI; `headless` leaves rendering to the host. */
export type AgilUiMode = 'default' | 'headless';

export interface CreatePollInput {
  question: string;
  /** 2..10 options; each option becomes one poll answer. */
  options: string[];
  multiple?: boolean;
  anonymous?: boolean;
  kind?: 'poll' | 'qna';
}

/** Public, DOM-free poll shape returned by the controller poll methods. */
export interface AgilPollOption {
  id: string;
  text: string;
  votes: number;
  /** 0..1 share of the total votes (server-provided or computed). */
  share?: number;
}

export interface AgilPoll {
  id: string;
  question: string;
  options: AgilPollOption[];
  multiple: boolean;
  anonymous: boolean;
  kind: 'poll' | 'qna';
  status: 'active' | 'closed';
  votes: number;
  /** Option ids already selected by the local participant. */
  myVotes?: string[];
}

export interface AgilCallOptions {
  /** Base HTTP(S) URL of the AgilFrame server. Defaults to `window.location.origin`. */
  serverUrl?: string;
  /** Room id (`/v1/rooms/:roomId`). */
  room: string;
  /** Start with microphone only. Video upgrades are supported in direct P2P rooms. */
  audioOnly?: boolean;
  /**
   * UI mode. `default` (built-in widget) unless `headless: true` or
   * `ui: 'headless'`; `ui` wins when both are set. In `headless` mode the widget
   * still joins, publishes/subscribes media, chat and state, but renders no
   * built-in markup — the host renders its own UI from the instance API.
   */
  ui?: AgilUiMode;
  /** Convenience alias for `ui: 'headless'` (`ui` takes precedence). */
  headless?: boolean;
  /**
   * Replaces built-in default-UI icons by URL. Keys are `IconName` values
   * (`mic`, `camera`, `chat`, ...); values are http(s) URLs (relative allowed).
   * Rendered as `<img>` only — never as HTML/SVG markup. Unknown names and
   * non-http(s) URLs are ignored. Headless mode has no built-in icons.
   */
  iconUrls?: Record<string, string>;
  /**
   * Host-supplied CSS appended for this widget root. Selectors are scoped under
   * the widget root (`:root`, `html`, `body` map to the root itself); `@import`
   * is ignored. Treat it as trusted host code: it is not sanitized.
   */
  customCss?: string;
  /** Join token (JWT). When omitted the widget calls `POST /v1/rooms/:roomId/join`. */
  token?: string;
  /** Tenant id, default `demo`. */
  tenantId?: string;
  /** Display name, default `Гость`. */
  participantName?: string;
  role?: 'host' | 'moderator' | 'guest';
  locale?: 'ru' | 'en';
  /** Local theme override applied on top of the server theme. */
  theme?: ThemePatch;
  /** Local config override applied on top of the server config. */
  config?: TenantConfigPatch;
  /** Server configuration returned with this room's join token. Welcome refreshes it. */
  initialServerConfig?: TenantConfig;
  /** The pending response from this room's join request, when the host has already sent it. */
  initialLobby?: LobbyJoinResponse;
  /** Corporate OIDC identity token (SSO); never logged or put in URLs by SDK. */
  identityToken?: string;
  /** ICE policy: `all` (default) or `relay` (TURN only) for tests/enterprise. */
  iceTransportPolicy?: 'all' | 'relay';
  /** Alias for iceTransportPolicy='relay'. */
  relayOnly?: boolean;
  /** True = edge-to-edge layout without outer frame/shadow. */
  embedded?: boolean;
  /** Restore the last session from sessionStorage (SPA / multi-page handoff). */
  resume?: boolean;
  onEvent?: (event: AgilWidgetEvent) => void;
  onChat?: (message: ChatMessage) => void;
}

export interface AgilWidgetInstance {
  join(): Promise<void>;
  leave(): void;
  destroy(): void;
  updateTheme(patch: ThemePatch): void;
  /** Merges into the current config, or applies a complete snapshot with `replace`. */
  updateConfig(patch: TenantConfigPatch, options?: { replace?: boolean }): void;
  setThemeScheme(scheme: 'light' | 'dark' | 'auto'): void;
  sendChat(text: string): Promise<ChatMessage>;
  toggleMic(force?: boolean): Promise<boolean>;
  toggleCamera(force?: boolean): Promise<boolean>;
  /** Ask the other participant to switch a direct P2P audio call to video. */
  requestVideoUpgrade(): boolean;
  /** Respond to the current incoming request. Use getState().videoUpgrade for custom UI. */
  respondToVideoUpgrade(requestId: string, accept: boolean): Promise<boolean>;
  toggleScreenShare(force?: boolean): Promise<boolean>;
  switchMicrophone(deviceId: string): Promise<void>;
  switchCamera(deviceId: string): Promise<void>;
  setNoiseSuppression(enabled: boolean): Promise<boolean>;
  setBlurMode(mode: 'off' | 'blur' | 'image', imageUrl?: string): Promise<void>;
  getStats(): Promise<CallStats>;
  getState(): CallState;
  /** Current local camera/mic stream (blur-processed video included), if any. */
  getLocalStream(): MediaStream | null;
  /** Snapshot of participant id → remote MediaStream (safe to keep; copy on each call). */
  getRemoteStreams(): Record<string, MediaStream>;
  /** Local screen-share stream while sharing, otherwise `null`. */
  getScreenStream(): MediaStream | null;
  /** The local participant after join, `null` before join/after leave. */
  getSelf(): Participant | null;
  /** Copy of the current remote participant list. */
  getParticipants(): Participant[];
  /** Raises the hand (`force=false` lowers it). Returns the resulting state. */
  raiseHand(force?: boolean): boolean;
  /** Lowers the hand. */
  lowerHand(): void;
  /** Sends a reaction (max 16 chars). Returns false when filtered/not permitted. */
  sendReaction(emoji: string): boolean;
  /**
   * Starts local recording. Resolves false when unsupported/denied/declined.
   * Headless hosts render their own consent UI and pass `{ consent: true }`.
   */
  startRecording(options?: { consent?: boolean }): Promise<boolean>;
  /** Stops local recording (no-op when not recording). */
  stopRecording(): Promise<void>;
  /** Polls are optional per tenant; server permissions are still enforced. */
  listPolls(): Promise<AgilPoll[]>;
  createPoll(input: CreatePollInput): Promise<AgilPoll>;
  votePoll(pollId: string, optionIds: string[]): Promise<AgilPoll>;
  closePoll(pollId: string): Promise<AgilPoll>;
  /** Store subscription; the listener receives every state change (not DOM-bound). */
  subscribe(listener: (state: CallState) => void): () => void;
  on(event: AgilWidgetEventName, listener: (payload: unknown) => void): () => void;
  /** Collapses the call into a floating mini window (contract §22.2). */
  minimize(): void;
  /** Restores the call from the mini window. */
  restore(): void;
  isMinimized(): boolean;
  /** Document Picture-in-Picture (Chromium); returns false and minimizes as a fallback. */
  requestPictureInPicture(): Promise<boolean>;
  /** Writes/removes the sessionStorage handoff used on the next page (contract §22.2). */
  persistSession(enabled?: boolean): void;
  /** Restores the call from the sessionStorage handoff. */
  resume(): Promise<void>;
  /** `builtin` = widget chat panel, `external` = host page owns chat, `hidden` = no chat. */
  setChatMode(mode: 'builtin' | 'external' | 'hidden'): void;
  /** Fullscreen API on the widget root (button + Esc are synced). */
  requestFullscreen(): Promise<void>;
  exitFullscreen(): Promise<void>;
  isFullscreen(): boolean;
  /** Deep link to the current call (`/embed.html?...`, includes the short-lived token). */
  getCallUrl(): string;
  /** Opens the call in a new browser tab; `null` when the popup was blocked. */
  openInNewTab(): Window | null;
  simulateParticipants(
    count: number,
    opts?: {
      names?: string[];
      layout?: LayoutMode;
      controls?: 'bar' | 'island' | 'minimal';
      /** Render synthetic tiles as camera-on to exercise the play-video affordance. */
      camera?: 'on' | 'off';
    },
  ): void;
  clearSimulatedParticipants(): void;
  /** Reveal the requested group in the Web gallery. Custom renderers use the clamped page state. */
  setGalleryPage(page: number): void;
  /** Large-room gallery: auto-follow the active speaker on/off. */
  setFollowSpeaker(enabled: boolean): void;
  /** Manual remote video quality (`auto` uses adaptive stream). */
  setVideoQuality(quality: VideoQualityPreference): void;
}

export type AgilWidgetEventName =
  | 'ready'
  | 'joined'
  | 'left'
  | 'participant-joined'
  | 'participant-left'
  | 'remote-stream'
  | 'chat'
  | 'quality-changed'
  | 'connection-state'
  | 'error'
  | 'screen-share-changed'
  | 'theme-changed'
  | 'media-state'
  | 'minimized-changed'
  | 'chat-mode-changed'
  /** Full call-state snapshot on every store change (custom UI rendering). */
  | 'state'
  /** A local or remote reaction ({ emoji, participantId, name, self }). */
  | 'reaction'
  /** A poll was created/updated/closed (`AgilPoll`). */
  | 'poll'
  /** Local mic noise crossed the advisory threshold (`AgilNoiseDetectedEvent`). */
  | 'noise-detected'
  /** Headless mode only: a message the default UI would have shown as a toast. */
  | 'toast';

export interface AgilWidgetEvent {
  type: AgilWidgetEventName;
  payload?: unknown;
  ts: number;
}

/** Payload of `remote-stream`; `stream: null` means the stream was removed. */
export interface AgilRemoteStreamEvent {
  participantId: string;
  stream: MediaStream | null;
}

export interface AgilReactionEvent {
  emoji: string;
  participantId?: string;
  name?: string;
  /** True for the local participant's reaction. */
  self: boolean;
}

/** An actionable headless toast button (e.g. retry SFU, open the lobby queue). */
export interface AgilToastAction {
  label: string;
  /** Runs the same handler the default UI would wire to the button. */
  onClick: () => void;
}

export interface AgilToastEvent {
  message: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  /** Actionable recovery affordances; omitted for informational toasts. */
  actions?: AgilToastAction[];
}

/** Payload of `noise-detected`; never contains audio samples or spectra. */
export interface AgilNoiseDetectedEvent {
  level: NoiseLevel;
  /** Linear RMS of the analyzed frame (0..1). */
  rms: number;
  /** Epoch milliseconds when the warning was triggered. */
  at: number;
}

/** Payloads documented for the public `on()` event names. */
export interface AgilWidgetEventPayloads {
  ready: { serverUrl: string };
  joined: { room: RoomInfo | null; self: Participant | null };
  left: Record<string, never>;
  'participant-joined': Participant;
  'participant-left': { participantId: string; reason?: string };
  'remote-stream': AgilRemoteStreamEvent;
  chat: ChatMessage;
  'media-state': Partial<CallSettingsState>;
  'screen-share-changed': { active: boolean; track?: MediaStreamTrack };
  'theme-changed': { theme?: ThemeTokens; scheme?: ThemeScheme };
  'connection-state': Record<string, unknown>;
  'quality-changed': unknown;
  error: unknown;
  state: CallState;
  reaction: AgilReactionEvent;
  poll: AgilPoll;
  'noise-detected': AgilNoiseDetectedEvent;
  toast: AgilToastEvent;
  'minimized-changed': { minimized: boolean; pictureInPicture: boolean };
  'chat-mode-changed': { mode: ChatMode };
}

/* ------------------------------------------------------------------ */
/* Runtime state                                                       */
/* ------------------------------------------------------------------ */

export type BlurMode = 'off' | 'blur' | 'image';

export type CallPhase = 'idle' | 'loading' | 'join-screen' | 'joining' | 'lobby' | 'joined' | 'left' | 'error';

export type CallConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'closed';

/**
 * Live-call continuity state exposed to hosts and the built-in UI
 * (docs/call-continuity.md):
 * `reconnecting` → socket dropped / resume in flight;
 * `restoring` → socket is back, waiting for the welcome/media plane;
 * `restored` → the server resumed the same participant and media was restored;
 * `failed` → resume was rejected or the reconnect budget is exhausted.
 */
export type ResumeStatus = 'idle' | 'reconnecting' | 'restoring' | 'restored' | 'failed';

export type PanelKind = 'none' | 'chat' | 'participants' | 'notes' | 'transcript' | 'settings' | 'assistant' | 'lobby' | 'breakout';

/** Guest-side waiting room (contract: `security.waitingRoom`). */
export type LobbyGuestStatus = 'idle' | 'pending' | 'admitted' | 'rejected' | 'expired' | 'timeout' | 'cancelled' | 'error';

export interface LobbyGuestState {
  waitingMessage?: string;
  status: LobbyGuestStatus;
  /** Capability id of the pending request; never rendered. */
  requestId: string | null;
  /** Server-side TTL (`expiresAt`, epoch ms). */
  expiresAt: number | null;
  /** Server hint for the poll interval (default 2000 ms). */
  pollAfterMs: number;
  /** When the wait screen was shown (epoch ms). */
  startedAt: number | null;
  /** Whole seconds spent in the queue, ticked by the controller. */
  elapsedSec: number;
  /** Localized reason for rejected/error states (already user-safe). */
  reason?: string;
}

export type LayoutMode = 'grid' | 'spotlight' | 'sidebar';

export type MediaMode = 'mesh' | 'sfu' | 'broadcast';

/** SFU media-plane status shown by the header badge / reconnect banner. */
export type SfuStatus = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export type ChatMode = 'builtin' | 'external' | 'hidden';
export type LayoutChrome = 'full' | 'compact' | 'none';
export type MinimizedMode = 'bar' | 'bubble';
export type MinimizedPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface AssistantEntry {
  id: string;
  question: string;
  answer: string;
  citations: KnowledgeCitation[];
  confidence?: number;
  error?: string;
  pending: boolean;
  ts: number;
}

export interface AssistantState {
  /** Permission + config say the participant may ask. */
  available: boolean;
  asking: boolean;
  entries: AssistantEntry[];
  /** Localized message shown when the server answers with error 'forbidden'. */
  denyMessage: string;
}

/** One chat-like message of the in-call AI assistant (local or external). */
export interface InCallAssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  actions: AssistantAction[];
  spotlight: AssistantSpotlight[];
  source: 'local' | 'external';
  securityPolicy?: { version: string; environment: 'production' | 'test' };
  pending: boolean;
  error?: string;
  ts: number;
}

export interface InCallAssistantState {
  /** `session.inCallAgent.enabled` — the panel is visible even without tool permissions. */
  available: boolean;
  busy: boolean;
  messages: InCallAssistantMessage[];
}

export interface QualityState {
  tier: QualityTier;
  score: number;
  rttMs: number;
  packetLossPct: number;
  jitterMs: number;
  inboundBitrateKbps: number;
  availableOutgoingBitrateKbps: number;
  fps: number;
  width: number;
  height: number;
}

export interface CaptionEntry {
  id: string;
  participantId: string;
  participantName: string;
  text: string;
  isFinal: boolean;
  ts: number;
  start: number;
  /** Machine translation of `text` (opt-in per tenant; never human-quality). */
  translation?: string;
  translationLang?: 'ru' | 'en';
}

export interface RecordingState {
  /** The local participant is recording. */
  active: boolean;
  /** Timestamp of the REC start, `null` when not recording. */
  startedAt: number | null;
  consentPending: boolean;
  degraded: boolean;
  error?: string;
  /** Download/remote URL of the last finished recording. */
  lastUrl?: string;
  /**
   * Another participant is recording (broadcast over signaling participant
   * state). The header indicator is shown for both local and remote recording,
   * so guests have a persistent, non-chat notice.
   */
  remoteActive?: boolean;
  /** Remote recording start (host clock), for the guest-side timer. */
  remoteStartedAt?: number | null;
  /** Display name of the remote participant who started recording. */
  remoteByName?: string | null;
}

export interface CallSettingsState {
  noiseSuppression?: boolean;
  /** Local camera preview override, independent of the outgoing stream. */
  mirrorSelfView?: boolean;
  micEnabled: boolean;
  camEnabled: boolean;
  screenSharing: boolean;
  handRaised: boolean;
  blurMode: BlurMode;
  blurStrength: number;
  backgroundImageUrl: string;
  /** MediaPipe/segmentation unavailable — CSS fallback in use. */
  blurDegraded: boolean;
  locale: Locale;
  scheme: ThemeScheme;
  preset: ThemePresetName;
  chatOpen: boolean;
  panel: PanelKind;
  /** Where chat lives: widget panel, host page, or nowhere (contract §22.1). */
  chatMode: ChatMode;
  /** Floating mini call window (contract §22.2). */
  minimized: boolean;
  /** How much chrome the widget renders (contract §22.2). */
  chrome: LayoutChrome;
  /** Effective layout; a 1:1 messenger call defaults to spotlight. */
  layoutMode: LayoutMode;
  /** Effective media plane (welcome.room.mediaMode or config.scale). */
  mediaMode: MediaMode;
  /** LiveKit/SFU transport state (`off` for mesh rooms). */
  sfuStatus?: SfuStatus;
  /** Broadcast/webinar viewer: receive-only, publishing controls hidden. */
  viewer: boolean;
  /** Fullscreen API state (synced with `fullscreenchange`). */
  fullscreen: boolean;
  /**
   * Manual video quality for remote subscriptions. `auto` uses adaptive-stream
   * tile dimensions; `high`/`medium`/`low` pin a simulcast layer.
   */
  videoQuality: VideoQualityPreference;
  pinnedId: string | null;
  statsOpen: boolean;
  captionsVisible: boolean;
  /** Low-bandwidth fallback engaged: media degraded, chat still works. */
  degraded: boolean;
  micDeviceId: string | null;
  camDeviceId: string | null;
  speakerDeviceId?: string;
}

export interface IntegrityState {
  status: ParticipantIntegrity;
  score: number;
  flags: string[];
}

/**
 * Participant's own sub-room assignment as rendered by the UI.
 * The child-room join token is deliberately **not** part of the observable
 * state (it lives in a private controller field and never reaches the DOM).
 */
export interface BreakoutAssignmentView {
  planId: string;
  breakoutRoomId: string;
  roomId: string;
  name: string;
  /** 1-based room index shown to the participant («Вы в подкомнате 2»). */
  index: number;
}

/** Breakout rooms panel/banner state (host and participant views). */
export interface BreakoutState {
  /** Last known plan of the **main** room (host view). */
  plan: BreakoutPlan | null;
  /** Current participant's sub-room; `null` while in the main room. */
  assignment: BreakoutAssignmentView | null;
  /** Deployed server does not expose breakout endpoints (404/405/501). */
  unavailable: boolean;
  loading: boolean;
  /** Start/close request in flight. */
  busy: boolean;
  /** Switching the signaling/media plane between main and child room. */
  switching: boolean;
  /** Localized, user-safe error text (also announced via aria-live). */
  error: string | null;
  /** Ticker value: whole seconds until the plan ends (0 when no deadline). */
  remainingSec: number;
  /** Participant id → name cache, so groups from other sub-rooms keep names. */
  names: Record<string, string>;
}

/** Whiteboard panel state (optional `features.whiteboard`). */
export interface WhiteboardState {
  /** The participant may use the whiteboard (permission + feature flag). */
  available: boolean;
  /** Local panel is visible. */
  visible: boolean;
  /** A board session is open in the room. */
  open: boolean;
  /** Host closed the board: only host/moderator can reopen it. */
  locked: boolean;
  /** Strokes in the local model (confirmed + in-flight). */
  strokes: number;
}

/** Screen-share annotation state (optional `features.annotations`). */
export interface AnnotationState {
  /** The participant may annotate. */
  available: boolean;
  /** Local annotation mode is on (drawing captures pointer events). */
  active: boolean;
  /** Participant id whose screen is shared, `null` when nobody shares. */
  presenterId: string | null;
  /** The local participant is the presenter. */
  selfSharing: boolean;
  /** Strokes in the local annotation layer. */
  strokes: number;
}

/**
 * Paginated remote-participant gallery. The UI renders at most one page
 * (25–36 tiles including self); the SFU subscribes video only for that page
 * plus the pinned/active-speaker participant.
 */
export interface GalleryState {
  /** Zero-based current page, clamped to `pageCount - 1`. */
  page: number;
  /** Tiles per full page: 25 on phones (≤640 px), 36 otherwise. */
  pageSize: number;
  pageCount: number;
  /** Remote participant count (self is not included). */
  total: number;
  /** Auto-follow the active speaker (and jump to its page in grid view). */
  followSpeaker: boolean;
  /** Last active remote speaker seen by the SFU/audio analyser. */
  speakerId: string | null;
  /** Hard cap for simultaneous remote video subscriptions (`scale.maxVideoSubscriptions`). */
  maxVideoSubscriptions: number;
  /**
   * Effective gallery video budget for the current room size: ≤8 participants
   * all visible videos, 9+ the capacity-profile budget (low 2, standard 6,
   * high 12; pinned + active speaker first), or a config override. The self
   * preview is not part of this remote budget.
   */
  videoBudget: number;
  /**
   * Tiles the user explicitly promoted with “play video”, newest first. They
   * outrank ordinary page tiles and the automatic active speaker, but never the
   * pinned participant; a promotion evicts the lowest-priority video (off-page
   * first, then the first ordinary page tile, then the speaker) and is
   * remembered per page.
   */
  promotedVideoIds: string[];
}

export interface CallState {
  phase: CallPhase;
  /** Camera capture stays off until the direct peer accepts a video upgrade. */
  audioOnly?: boolean;
  videoUpgrade?: { requestId: string; participantId: string; direction: 'incoming' | 'outgoing' } | null;
  connection: CallConnectionState;
  wsState: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
  /** Live-call continuity status (idle when the call has no interruption). */
  resumeStatus: ResumeStatus;
  quality: QualityState;
  room: RoomInfo | null;
  self: Participant | null;
  participants: Participant[];
  /** Large-room gallery pagination state. */
  gallery: GalleryState;
  /** Local camera/mic stream (may be an empty stream before join). */
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  /** Participant id -> remote MediaStream (reference changes only). */
  remoteStreams: Record<string, MediaStream>;
  /** Selected ICE candidate pair (local/remote type + protocol), mesh only. */
  iceInfo?: { local?: string; remote?: string; protocol?: string };
  /** SFU E2EE state (LiveKit); undefined/disabled for mesh. */
  e2ee?: { status: 'disabled' | 'enabling' | 'enabled' | 'failed'; error?: string; keyIndex?: number };
  mediaError: string | null;
  chat: ChatMessage[];
  chatUnread: number;
  captions: CaptionEntry[];
  transcripts: TranscriptSegment[];
  recording: RecordingState;
  notes: MeetingNotes | null;
  findings: ComplianceFinding[];
  /** Effective feature permissions (access.ts); null until join resolved them. */
  permissions: FeatureKey[] | null;
  /** Virtual backgrounds: config.session.virtualBackgrounds or the external provider list. */
  backgrounds: Array<{ id: string; name: string; url: string }>;
  assistant: AssistantState;
  inCallAssistant: InCallAssistantState;
  integrity: Record<string, IntegrityState>;
  security: {
    passwordProtected: boolean;
    geoEnabled: boolean;
    integrityEnabled: boolean;
    e2ee: boolean;
    auditLog: boolean;
  };
  /** Guest waiting-room state (idle outside a lobby). */
  lobby: LobbyGuestState;
  /** Host/moderator waiting-room queue (from WS `lobby.*` + polling fallback). */
  lobbyQueue: LobbyRequestInfo[];
  /** Breakout rooms: plan + the participant's own assignment. */
  breakout: BreakoutState;
  /** Whiteboard panel state (optional feature). */
  whiteboard: WhiteboardState;
  /** Screen-share annotations (optional feature). */
  annotation: AnnotationState;
  settings: CallSettingsState;
  config: TenantConfig;
  error: { code: string; message: string } | null;
  durationSec: number;
  serverOnline: boolean;
  /** Feature availability discovered at runtime. */
  capabilities: {
    media: boolean;
    screenShare: boolean;
    blur: boolean;
    captions: boolean;
    recording: boolean;
    fileShare: boolean;
  };
}

/** Snapshot returned by `instance.getStats()` — also used by the demo diagnostics page. */
export interface CallStats {
  phase: CallPhase;
  connectionState: CallConnectionState;
  wsState: CallState['wsState'];
  qualityTier: QualityTier;
  qualityScore: number;
  rttMs: number;
  packetLossPct: number;
  jitterMs: number;
  inboundBitrateKbps: number;
  outboundBitrateKbps: number;
  fps: number;
  resolution: { width: number; height: number };
  participants: number;
  durationSec: number;
  screenSharing: boolean;
  recording: boolean;
  captions: boolean;
  blurMode: BlurMode;
  blurDegraded: boolean;
  lowBandwidthDegraded: boolean;
  iceInfo?: { local?: string; remote?: string; protocol?: string };
  minimized: boolean;
  chatMode: ChatMode;
  chrome: LayoutChrome;
  fullscreen: boolean;
  mediaMode: MediaMode;
  viewer: boolean;
  /** Live-call continuity state at the time of the snapshot. */
  resumeStatus: ResumeStatus;
  iceRestarts: number;
  iceServers: number;
  localTracks: { audio: number; video: number };
  remotePeers: number;
  serverOnline: boolean;
  locale: Locale;
  themeScheme: 'light' | 'dark';
}

export type { VideoQualityPreference } from './call/large-room.js';
export type { ChatMessage, ComplianceFinding, FeatureKey, KnowledgeCitation, Locale, MeetingNotes, Participant, ParticipantState, RoomInfo, TenantConfig, TenantConfigPatch, ThemePatch, ThemePresetName, ThemeScheme, ThemeTokens, TranscriptSegment, QualityTier };
