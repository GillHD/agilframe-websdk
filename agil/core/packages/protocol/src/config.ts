/**
 * Tenant configuration: everything a corporate client can tune through the
 * REST API, the visual editor or the MCP server.
 *
 * Shape: { configVersion, tenantId, branding, theme, features, audio, video,
 *          limits, fallback, security, layout, session, room }
 */
import { z } from 'zod';
import { billingConfigSchema, DEFAULT_BILLING } from './billing.js';
import { managedNodeIdSchema } from './cluster.js';
import { aiAgentConfigSchema } from './compliance.js';
import { DEFAULT_INTEGRATIONS, integrationsConfigSchema } from './integrations.js';
import { deepPartialObject } from './patch-schema.js';
import { DEFAULT_SCALE, scaleConfigPatchSchema, scaleConfigSchema } from './scaling.js';
import { deepMerge, resolveTheme, themeSchema, type ThemePatch, type ThemePresetName, themePresets } from './theme.js';

export const DEFAULT_TENANT_ID = 'demo';
export const CONFIG_VERSION = 1;

export const localeSchema = z.enum(['ru', 'en']);
export type Locale = z.infer<typeof localeSchema>;

export const featureFlagsSchema = z.object({
  chat: z.boolean(),
  chatHistoryOnJoin: z.boolean(),
  fileShare: z.boolean(),
  screenShare: z.boolean(),
  handRaise: z.boolean(),
  reactions: z.boolean(),
  participantList: z.boolean(),
  selfView: z.boolean(),
  gridPinning: z.boolean(),
  fullscreen: z.boolean(),
  pictureInPicture: z.boolean(),
  statsPanel: z.boolean(),
  deviceSettings: z.boolean(),
  backgroundBlur: z.boolean(),
  backgroundReplace: z.boolean(),
  noiseSuppression: z.boolean(),
  /** Advisory mic noise detection (local Web Audio analysis; no audio leaves the browser). */
  noiseDetection: z.boolean(),
  lowBandwidthFallback: z.boolean(),
  recording: z.boolean(),
  captions: z.boolean(),
  waitingRoom: z.boolean(),
  inviteLink: z.boolean(),
  keyboardShortcuts: z.boolean(),
  // ---- Competitor-parity flags (UI hides them when false) ----
  breakoutRooms: z.boolean(),
  polls: z.boolean(),
  whiteboard: z.boolean(),
  annotations: z.boolean(),
  liveStreaming: z.boolean(),
  sipDialIn: z.boolean(),
  calendarIntegration: z.boolean(),
  translation: z.boolean(),
  aiAssistant: z.boolean(),
  aiCompliance: z.boolean(),
  knowledgeAgent: z.boolean(),
  autoFraming: z.boolean(),
  lowLightEnhancement: z.boolean(),
  speakerSpotlight: z.boolean(),
  remoteControl: z.boolean(),
  webinarMode: z.boolean(),
  meetingNotes: z.boolean(),
});

export type FeatureFlags = z.infer<typeof featureFlagsSchema>;
export type FeatureKey = keyof FeatureFlags;

/** Runtime enum of every feature flag key — used by access policies and tokens. */
export const featureKeySchema = z.enum(
  Object.keys(featureFlagsSchema.shape) as unknown as [FeatureKey, ...FeatureKey[]],
);
export const featureKeys = Object.keys(featureFlagsSchema.shape) as FeatureKey[];

/**
 * Per-tenant access policy: which functionality each role gets, plus explicit
 * per-user grants and global denials. Effective features are the intersection
 * of the policy, the token permissions and the enabled feature flags.
 */
export const accessPolicySchema = z.object({
  /** 'role-defaults' uses roleDefaults; 'strict' allows only explicit grants. */
  mode: z.enum(['role-defaults', 'strict']),
  roleDefaults: z.object({
    host: z.array(featureKeySchema),
    moderator: z.array(featureKeySchema),
    guest: z.array(featureKeySchema),
  }),
  deniedFeatures: z.array(featureKeySchema),
  /** userId -> explicit feature list (replaces the role defaults for that user). */
  userOverrides: z.record(z.string(), z.array(featureKeySchema)),
  /**
   * Company-defined roles (in addition to the built-in host/moderator/guest).
   * A token can be issued with `roleId`; the effective features are the role's
   * features (then the same deniedFeatures/feature-flag filtering applies).
   * Built-in roles cannot be deleted; custom roles can be created/edited/removed.
   */
  customRoles: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(40)
          .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase latin, digits, _ and - only'),
        name: z.string().min(1).max(80),
        description: z.string().max(300),
        /** Transport/base role used for moderation/DB records and as fallback. */
        baseRole: z.enum(['host', 'moderator', 'guest']),
        features: z.array(featureKeySchema),
        canModerate: z.boolean(),
        /** Optional brand color for UI badges (#rrggbb). */
        color: z.string().max(9),
      }),
    )
    .max(30),
});

export type CustomRole = z.infer<typeof accessPolicySchema>['customRoles'][number];
export type AccessPolicy = z.infer<typeof accessPolicySchema>;

export const accessPolicyPatchSchema = accessPolicySchema.partial().extend({
  roleDefaults: accessPolicySchema.shape.roleDefaults.partial().optional(),
});
export type AccessPolicyPatch = z.infer<typeof accessPolicyPatchSchema>;

export const accessPolicyExpectedSchema = accessPolicyPatchSchema.omit({ customRoles: true }).extend({
  userOverrides: z.record(z.string(), z.array(featureKeySchema).nullable()).optional(),
});
export type AccessPolicyExpected = z.infer<typeof accessPolicyExpectedSchema>;

export const ALL_FEATURE_KEYS = featureKeys;
const GUEST_DENIED: FeatureKey[] = [
  'recording',
  'knowledgeAgent',
  'translation',
  'remoteControl',
  'breakoutRooms',
  'liveStreaming',
  'webinarMode',
  'sipDialIn',
  'calendarIntegration',
];
export const DEFAULT_ACCESS_POLICY: AccessPolicy = {
  mode: 'role-defaults',
  roleDefaults: {
    host: [...ALL_FEATURE_KEYS],
    moderator: [...ALL_FEATURE_KEYS],
    guest: ALL_FEATURE_KEYS.filter((key) => !GUEST_DENIED.includes(key)),
  },
  deniedFeatures: [],
  userOverrides: {},
  customRoles: [],
};

export const audioConfigSchema = z.object({
  codecs: z.array(z.enum(['opus', 'red', 'pcmu', 'g722'])).min(1),
  preferredCodec: z.enum(['opus', 'pcmu', 'g722']),
  echoCancellation: z.boolean(),
  noiseSuppression: z.boolean(),
  autoGainControl: z.boolean(),
  dtx: z.boolean(),
  ptimeMs: z.number().int().min(10).max(60),
  opusBitrateKbps: z.number().int().min(6).max(128),
  stereo: z.boolean(),
  jitterBufferTargetMs: z.number().int().min(0).max(500),
});

export const videoConfigSchema = z.object({
  codecs: z.array(z.enum(['av1', 'vp9', 'h264', 'vp8'])).min(1),
  preferredCodec: z.enum(['av1', 'vp9', 'h264', 'vp8']),
  simulcast: z.boolean(),
  scalableVideoCoding: z.boolean(),
  maxResolution: z.enum(['1080p', '720p', '540p', '360p']),
  maxFps: z.number().int().min(1).max(60),
  maxBitrateKbps: z.number().int().min(100).max(8000),
  degradationPreference: z.enum(['maintain-framerate', 'maintain-resolution', 'balanced']),
  keyFrameIntervalMs: z.number().int().min(500).max(10000),
  contentHint: z.enum(['motion', 'detail', 'text']),
  /**
   * Encoding policy: prefer already-supported camera codecs (hardware H.264/
   * AV1 where available), then hardware encoder, then software. The server
   * must not transcode for normal calls.
   */
  encoding: z
    .object({
      strategy: z.enum(['auto', 'prefer-hardware', 'software-only']).default('auto'),
      /** Ordered codec preference (only WebRTC-supported codecs are used). */
      preferredCodecs: z
        .array(z.enum(['av1', 'h264', 'vp9', 'vp8']))
        .min(1)
        .default(['av1', 'h264', 'vp9', 'vp8']),
      /** Reserved for custom clients with HEVC support. The hosted widget excludes it. */
      allowH265: z.boolean().default(false),
    })
    .default({ strategy: 'auto', preferredCodecs: ['av1', 'h264', 'vp9', 'vp8'], allowH265: false }),
});

export const limitsSchema = z.object({
  maxParticipants: z.number().int().min(2).max(50000),
  maxDurationMin: z.number().int().min(1).max(1440),
  maxVideoSubscriptions: z.number().int().min(1).max(1000),
  /**
   * Optional fixed gallery video budget: how many remote videos a client
   * subscribes per page. Unset = adaptive (≤8 participants: all visible videos;
   * 9+ participants: the capacity profile budget — low 2, standard 6, high 12;
   * pinned + active speaker first). The self preview is not part of the remote
   * budget. Both room and scaling subscription limits cap this budget.
   * `scale.maxVisibleVideos` is an equivalent alias (this field wins).
   * See `agil/core/docs/large-rooms.md`.
   */
  galleryVideoBudget: z.number().int().min(1).max(1000).optional(),
});

export const lowBandwidthSchema = z.object({
  enabled: z.boolean(),
  strategy: z.enum(['reduce-video', 'audio-only', 'chat-first']),
  chatOverSignaling: z.boolean(),
  enterThreshold: z.object({
    rttMs: z.number().min(20).max(5000),
    lossPct: z.number().min(0).max(100),
    jitterMs: z.number().min(0).max(2000),
    minBitrateKbps: z.number().min(10).max(20000),
  }),
  restoreThreshold: z.object({
    rttMs: z.number().min(10).max(5000),
    lossPct: z.number().min(0).max(100),
    minBitrateKbps: z.number().min(10).max(20000),
  }),
  autoReconnect: z.object({
    enabled: z.boolean(),
    attempts: z.number().int().min(0).max(20),
    backoffMs: z.number().int().min(100).max(10000),
    maxBackoffMs: z.number().int().min(500).max(60000),
  }),
  iceRestartOnFailure: z.boolean(),
});

export const publicAbuseModeSchema = z.enum(['off', 'observe', 'enforce']);
export type PublicAbuseMode = z.infer<typeof publicAbuseModeSchema>;

export const securitySchema = z.object({
  requireToken: z.boolean(),
  waitingRoom: z.boolean(),
  lockRoom: z.boolean(),
  moderatorJoinFirst: z.boolean(),
  e2ee: z.boolean(),
  guestCanShareScreen: z.boolean(),
  guestCanChat: z.boolean(),
  guestCanUnmute: z.boolean(),
  /** Room password is set per room and stored only as a scrypt hash server-side. */
  passwordRequired: z.boolean(),
  maxFailedJoinAttempts: z.number().int().min(1).max(50),
  lockoutSec: z.number().int().min(0).max(86400),
  requireVerifiedIdentity: z.boolean(),
  /** Organization policy for anonymous creation/join. Omitted means inherit the Core default. */
  publicAbuseMode: publicAbuseModeSchema.nullable().optional(),
  auditLog: z.boolean(),
  geo: z.object({
    enabled: z.boolean(),
    /** ISO-3166 alpha-2, uppercase. Empty array = allow all. */
    allowedCountries: z.array(z.string().length(2)),
    blockedCountries: z.array(z.string().length(2)),
    blockVpn: z.boolean(),
    /** Ask the participant for device geolocation (browser permission prompt). */
    gpsEnabled: z.boolean(),
    /** Require explicit consent before collecting/using GPS coordinates. */
    requireConsent: z.boolean(),
  }),
  mediaIntegrity: z.object({
    enabled: z.boolean(),
    /** Random liveness challenge on join (turn head / blink), MediaPipe-based. */
    livenessChallenge: z.boolean(),
    /** Client-side frame-timing / synthetic-media heuristics. */
    frameHeuristics: z.boolean(),
    /** Optional server-side deepfake/voice-clone detector endpoint. */
    externalProvider: z.string(),
    /** Score (0..1) above which a participant is flagged suspicious. */
    flagThreshold: z.number().min(0).max(1),
    autoMuteOnHighRisk: z.boolean(),
  }),
  /**
   * Server-issued liveness sessions (MediaPipe/OpenCV challenge run in the
   * browser, adjudicated by the server). Advisory only — it proves *some*
   * responsive human at that moment, never a certified deepfake verdict.
   * Independent from `mediaIntegrity.livenessChallenge` (client-only check).
   */
  liveness: z
    .object({
      /** The widget requests `POST /v1/rooms/:roomId/liveness/challenge` on join. */
      enabled: z.boolean(),
      /**
       * Engine failure/timeout policy: `fail-open` treats an unavailable engine
       * as "unknown" (never accuses the participant), `fail-closed` treats it as
       * a failed challenge.
       */
      onEngineError: z.enum(['fail-open', 'fail-closed']),
    })
    .default({ enabled: false, onEngineError: 'fail-open' }),
  /**
   * Uploaded-file malware scanning (ClamAV via clamd INSTREAM, optional YARA).
   * Disabled by default; availability also needs the deployment to configure
   * `AGIL_CLAMAV_*` / `AGIL_YARA_RULES` (see docs/liveness-av.md).
   */
  avScan: z
    .object({
      enabled: z.boolean(),
      /** `async` = answer first and quarantine afterwards; `sync` = block the upload. */
      mode: z.enum(['async', 'sync']),
      /** Scanner error/timeout policy: `fail-open` keeps the file, `fail-closed` quarantines it. */
      onScanError: z.enum(['fail-open', 'fail-closed']),
      /** Larger files are reported as `skipped` and never streamed to the daemon. */
      maxScanMb: z.number().int().min(1).max(100),
    })
    .default({ enabled: false, mode: 'async', onScanError: 'fail-open', maxScanMb: 25 }),
  sessionBinding: z.object({
    enabled: z.boolean(),
    bindToIp: z.boolean(),
    bindToDevice: z.boolean(),
  }),
  accessPolicy: accessPolicySchema,
});

/** Stable control ids used by layout.hiddenControls / controlOrder. */
export const controlIds = [
  'mic',
  'camera',
  'screen',
  'blur',
  'chat',
  'hand',
  'reactions',
  'participants',
  'notes',
  'transcript',
  'assistant',
  'recording',
  'fullscreen',
  'newtab',
  'minimize',
  'settings',
  'leave',
] as const;
export const controlIdSchema = z.enum(controlIds);
export type ControlId = (typeof controlIds)[number];

export const layoutSchema = z.object({
  mode: z.enum(['grid', 'spotlight', 'sidebar']),
  selfView: z.enum(['corner', 'pip', 'hidden']),
  controlsPosition: z.enum(['bottom-center', 'bottom-bar']),
  /** 'bar' = classic bottom bar, 'island' = floating pill (popular style), 'minimal' = only key buttons. */
  controlsStyle: z.enum(['bar', 'island', 'minimal']),
  /** Where the control bar/island is anchored inside the widget. */
  controlsAnchor: z.enum(['bottom-center', 'bottom-left', 'bottom-right', 'top-center', 'top-right']),
  /** Controls hidden by the tenant (still available via API/shortcuts if allowed). */
  hiddenControls: z.array(controlIdSchema),
  /** Explicit order; controls absent here keep their default order after these. */
  controlOrder: z.array(controlIdSchema),
  /** Auto-hide the control bar/island while the user is idle. */
  autoHideControls: z.boolean(),
  autoHideDelaySec: z.number().int().min(1).max(120),
  chatPosition: z.enum(['right', 'left', 'hidden']),
  chatDefaultOpen: z.boolean(),
  showRoomName: z.boolean(),
  showParticipantCount: z.boolean(),
  showQualityIndicator: z.boolean(),
  showTimer: z.boolean(),
  tileAspectRatio: z.enum(['16:9', '4:3', '1:1']),
  gridMaxTiles: z.number().int().min(1).max(64),
  spotlightFollowSpeaker: z.boolean(),
  /** How much chrome the embed renders: full UI, compact bar or none (host UI). */
  chrome: z.enum(['full', 'compact', 'none']),
  /** Call header density: full (brand+badges+actions), compact (title+status), hidden (overlay on video). */
  header: z.enum(['full', 'compact', 'hidden']).default('full'),
  /** How media fills its tile/canvas. */
  videoFit: z.enum(['contain', 'cover']).default('contain'),
  /** Immersive video: media fills the whole widget/container, header/controls float over it. */
  immersiveVideo: z.boolean().default(false),
  /**
   * "Свернуть звонок в маленькое окно": floating bar/bubble that stays visible
   * while the user navigates the company app (SPA) or via Document PiP.
   */
  minimized: z.object({
    enabled: z.boolean(),
    mode: z.enum(['bar', 'bubble']),
    position: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']),
    showSelfView: z.boolean(),
    keepControls: z.boolean(),
  }),
  /** Remember room/token in sessionStorage so SPA route changes can re-mount. */
  persistAcrossPages: z.boolean(),
  /** Inherit host page fonts/colors where tokens are not explicitly set. */
  inheritHostStyles: z.boolean(),
});

export const sessionSchema = z.object({
  defaultLocale: localeSchema,
  locales: z.array(localeSchema).min(1),
  allowLocaleSwitch: z.boolean(),
  defaultBlurMode: z.enum(['off', 'blur', 'image']),
  blurStrength: z.number().min(1).max(40),
  virtualBackgrounds: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      // Empty url means "use a built-in gradient/placeholder generated by the widget".
      url: z.string(),
    }),
  ),
  joinWithoutPreview: z.boolean(),
  mirrorSelfView: z.boolean(),
  joinWithMicOff: z.boolean(),
  joinWithCamOff: z.boolean(),
  recording: z.object({
    enabled: z.boolean(),
    storeOnServer: z.boolean(),
    consentRequired: z.boolean(),
    notifyParticipants: z.boolean(),
    format: z.enum(['webm', 'mp4']),
    includeChat: z.boolean(),
  }),
  transcription: z.object({
    enabled: z.boolean(),
    provider: z.enum(['browser', 'server', 'off']),
    /** Optional managed dependency for remote server transcription. */
    nodeId: managedNodeIdSchema.optional(),
    language: z.enum(['ru', 'en', 'auto']),
    showCaptionsByDefault: z.boolean(),
    saveTranscript: z.boolean(),
    /**
     * Translate final transcript segments/captions into this language.
     * `none` disables translation; engines come from `TRANSLATE_PROVIDER`.
     */
    translateTo: z.enum(['none', 'ru', 'en']),
    /**
     * Require explicit participant consent before audio is sent to server STT
     * and before segments are stored in the room transcript.
     */
    consentRequired: z.boolean(),
    /** Delete stored transcript segments older than N seconds (0 = room lifetime). */
    retentionSec: z.number().int().min(0).max(30 * 86400),
  }),
  fileShare: z.object({
    enabled: z.boolean(),
    storeOnServer: z.boolean(),
    maxFileSizeMb: z.number().int().min(1).max(200),
    allowedMimeTypes: z.array(z.string()),
  }),
  screenShare: z.object({
    enabled: z.boolean(),
    maxFps: z.number().int().min(1).max(60),
    maxWidth: z.number().int().min(320).max(3840),
    shareAudio: z.boolean(),
    preferMotion: z.boolean(),
  }),
  /**
   * Chat ownership. The call can use our built-in chat, or the company's own
   * chat UI (external): the widget then hides its chat panel, emits chat events
   * to the host, and the host sends messages through the SDK/postMessage/API.
   */
  chat: z.object({
    ui: z.enum(['builtin', 'external', 'hidden']),
    /** Storage policy for the Core chat. Session preserves the existing RAM buffer. */
    historyStorage: z.enum(['off', 'session', 'local', 'postgres']).default('session'),
    /** Retention for durable history, measured from the first accepted write. */
    historyRetentionSec: z.number().int().min(60).max(90 * 86400).default(7 * 86400),
    /** Free-form provider name for UI/docs ("corp-messenger", "Mattermost", …). */
    externalProviderName: z.string().max(120),
    /** Allow the host page to inject messages into the call chat. */
    allowHostInjection: z.boolean(),
    /** Allow system/bot messages (from the company backend, kind:'system'). */
    allowSystemMessages: z.boolean(),
  }),
  aiAgent: aiAgentConfigSchema,
  knowledgeAgent: z.object({
    enabled: z.boolean(),
    /** Corporate RAG endpoint (wiki / internal knowledge base) — HTTPS. */
    endpoint: z.string().max(300),
    apiKeyEnv: z.string().max(100),
    timeoutMs: z.number().int().min(500).max(30000),
    /** Roles allowed to ask the knowledge agent (before permission checks). */
    allowedRoles: z.array(z.enum(['host', 'moderator', 'guest'])),
    /** Additionally require the `knowledgeAgent` feature permission. */
    requirePermission: z.boolean(),
    citations: z.boolean(),
    maxAnswerChars: z.number().int().min(100).max(20000),
    systemPrompt: z.string().max(4000),
    denyMessage: z.string().max(500),
  }),
  /**
   * In-call assistant acting on behalf of the connected user (permission-scoped
   * tool calls + UI spotlight). Works locally out of the box; any LLM can be
   * plugged through an external agent endpoint.
   */
  inCallAgent: z.object({
    enabled: z.boolean(),
    mode: z.enum(['local', 'external', 'hybrid']),
    endpoint: z.string().max(500),
    apiKeyEnv: z.string().max(100),
    timeoutMs: z.number().int().min(500).max(30000),
    systemPrompt: z.string().max(4000),
    model: z.string().max(120),
    compressContext: z.boolean().default(false),
    /** Allow the assistant to highlight UI controls ("нажмите сюда"). */
    spotlight: z.boolean(),
    allowedTools: z.array(
      z.enum([
        'start_recording',
        'stop_recording',
        'toggle_mic',
        'toggle_camera',
        'toggle_screen_share',
        'raise_hand',
        'send_chat',
        'open_chat',
        'open_files',
        'open_participants',
        'open_notes',
        'open_settings',
        'set_blur',
        'minimize',
        'restore',
        'request_fullscreen',
        'open_new_tab',
        'copy_invite_link',
      ]),
    ),
    maxActionsPerReply: z.number().int().min(1).max(10),
    audit: z.boolean(),
    denyMessage: z.string().max(300),
  }),
});

export const brandingSchema = z.object({
  productName: z.string().min(1).max(64),
  organizationName: z.string().max(128),
  logoUrl: z.string(),
  logoHeightPx: z.number().int().min(12).max(96),
  faviconUrl: z.string(),
  supportUrl: z.string(),
  footerText: z.string(),
  /**
   * Custom domain for the white-label embed. Read-only mirror of the domain
   * registry: set it through `PUT /v1/admin/domain` (TXT + CNAME verification),
   * not through this config field.
   */
  customDomain: z.string().max(253).optional().default(''),
  /** Animated dashboard mascot (WebP/PNG/GIF URL). Empty = bundled default. */
  mascotUrl: z.string().max(500).optional().default(''),
  /** Display name of the mascot (e.g. "Agil"). */
  mascotName: z.string().max(40).optional().default('Agil'),
  /** Turn the in-panel helper mascot on/off. */
  mascotEnabled: z.boolean().optional().default(true),
  /** Custom mascot expression pack: expression -> URL. */
  mascotExpressions: z.record(z.string(), z.string().max(200)).optional(),
});

/**
 * Capability providers: every product capability works out of the box (builtin)
 * and can be replaced by the company's own system (external) without forking.
 *
 * `endpoint` for external providers receives a signed JSON envelope:
 *   {capability, action, requestId, tenantId, roomId?, payload}
 * and answers {ok, data} (validated by the server adapter).
 */
export const providerSlotSchema = z.object({
  mode: z.enum(['builtin', 'external', 'disabled']),
  /** Free-form provider name shown in UI/dashboards ("corp-messenger", "s3", "deepgram"). */
  providerName: z.string().max(120),
  endpoint: z.string().max(500),
  /** Env variable name holding the HMAC/API secret (never the secret itself). */
  apiKeyEnv: z.string().max(100),
  timeoutMs: z.number().int().min(200).max(30000),
  /** What to do when an external provider fails: transparent builtin fallback or fail the request. */
  fallback: z.enum(['builtin', 'fail']),
  options: z.record(z.string(), z.unknown()),
});

export type ProviderSlot = z.infer<typeof providerSlotSchema>;

const BUILTIN_SLOT: ProviderSlot = {
  mode: 'builtin',
  providerName: '',
  endpoint: '',
  apiKeyEnv: '',
  timeoutMs: 5000,
  fallback: 'builtin',
  options: {},
};

export const providersSchema = z.object({
  /** Chat transport/storage (builtin = room chat; external = company messenger). */
  chat: providerSlotSchema,
  /** File storage (builtin = local .data/files; external = S3/DMS/ECM). */
  files: providerSlotSchema,
  /** Speech-to-text (builtin = browser Web Speech / server STT env; external = vendor). */
  stt: providerSlotSchema,
  /** Outbound notifications (email/Telegram/Teams webhook). */
  notifications: providerSlotSchema,
  /** Recording storage/processing (builtin = client MediaRecorder + local store). */
  recording: providerSlotSchema,
  /** Virtual backgrounds library (builtin = config.session.virtualBackgrounds). */
  backgrounds: providerSlotSchema,
});

export type ProvidersConfig = z.infer<typeof providersSchema>;

export const DEFAULT_PROVIDERS: ProvidersConfig = {
  chat: { ...BUILTIN_SLOT },
  files: { ...BUILTIN_SLOT },
  stt: { ...BUILTIN_SLOT },
  notifications: { ...BUILTIN_SLOT },
  recording: { ...BUILTIN_SLOT },
  backgrounds: { ...BUILTIN_SLOT },
};

export const roomDefaultsSchema = z.object({
  name: z.string().max(120),
  welcomeMessage: z.string().max(500),
  waitingMessage: z.string().max(500),
  soundOnJoinLeave: z.boolean(),
});

/**
 * Where media processing happens. Default: client-only — the server must not
 * decode/transcode/blur video or mix audio for normal calls. Server-assisted
 * paths (egress/transcoding) are opt-in per tenant and off by default.
 */
export const mediaProcessingSchema = z.object({
  mode: z.enum(['client-only', 'server-assisted']).default('client-only'),
  /** Server-side video processing/transcoding (expensive; off). */
  video: z.boolean().default(false),
  /** Server-side audio processing/mixing (expensive; off). */
  audio: z.boolean().default(false),
  /** Cloud recording / egress worker (separate host; off). */
  egress: z.boolean().default(false),
  /** Optional enrolled worker dependency. Empty clears the binding. */
  egressNodeId: managedNodeIdSchema.optional(),
  /** Transcoding between codecs/resolutions (off; SFU forwards, not transcodes). */
  transcoding: z.boolean().default(false),
  provider: z.enum(['none', 'livekit-egress', 'external']).default('none'),
});

export const tenantConfigSchema = z.object({
  configVersion: z.literal(CONFIG_VERSION),
  tenantId: z.string().min(1).max(64),
  branding: brandingSchema,
  theme: themeSchema,
  features: featureFlagsSchema,
  audio: audioConfigSchema,
  video: videoConfigSchema,
  limits: limitsSchema,
  fallback: z.object({ lowBandwidth: lowBandwidthSchema }),
  security: securitySchema,
  layout: layoutSchema,
  session: sessionSchema,
  room: roomDefaultsSchema,
  /** Boundaries with the company's own systems (webhooks, identity, embeds). */
  integrations: integrationsConfigSchema,
  /** Replaceable capability providers (builtin by default). */
  providers: providersSchema,
  /** Media plane mode, multi-node signaling, TURN pool, SFU, webinar/streaming. */
  scale: scaleConfigSchema,
  /** Server-side media processing policy (client-only by default). */
  mediaProcessing: mediaProcessingSchema,
  /**
   * Billing plan and metered quota enforcement (no payments).
   * Metering is always recorded by the server, enforcement is opt-in via
   * `billing.enabled`. Defaults: free plan, off.
   */
  billing: billingConfigSchema.default(DEFAULT_BILLING),
});

/**
 * Deep-partial patch for TenantConfig. `billing` and `scale` are overridden
 * explicitly: their schema-level defaults would otherwise turn a patch into a
 * full replacement. `scale.sip` stays deep-partial; the full
 * `tenantConfigSchema` defaults a missing `scale.sip`.
 */
export const tenantConfigPatchSchema = deepPartialObject(tenantConfigSchema).extend({
  billing: deepPartialObject(billingConfigSchema).optional(),
  scale: scaleConfigPatchSchema.optional(),
});

export type TenantConfig = z.output<typeof tenantConfigSchema>;
export type TenantConfigPatch = z.input<typeof tenantConfigPatchSchema>;

/** Whether the room policy permits starting a browser recording. */
export function browserRecordingEnabled(config: Pick<TenantConfig, 'session' | 'providers'>): boolean {
  return config.session.recording.enabled && config.providers.recording.mode !== 'disabled';
}

export const DEFAULT_MEDIA_PROCESSING: TenantConfig['mediaProcessing'] = {
  mode: 'client-only',
  video: false,
  audio: false,
  egress: false,
  transcoding: false,
  provider: 'none',
};

export const DEFAULT_FEATURES: FeatureFlags = {
  chat: true,
  chatHistoryOnJoin: true,
  fileShare: false,
  screenShare: true,
  handRaise: true,
  reactions: true,
  participantList: true,
  selfView: true,
  gridPinning: true,
  fullscreen: true,
  pictureInPicture: true,
  statsPanel: true,
  deviceSettings: true,
  backgroundBlur: true,
  backgroundReplace: true,
  noiseSuppression: true,
  noiseDetection: false,
  lowBandwidthFallback: true,
  recording: false,
  captions: false,
  waitingRoom: false,
  inviteLink: true,
  keyboardShortcuts: true,
  breakoutRooms: false,
  polls: false,
  whiteboard: false,
  annotations: false,
  liveStreaming: false,
  sipDialIn: false,
  calendarIntegration: false,
  translation: false,
  aiAssistant: false,
  aiCompliance: true,
  knowledgeAgent: true,
  autoFraming: false,
  lowLightEnhancement: false,
  speakerSpotlight: false,
  remoteControl: false,
  webinarMode: false,
  meetingNotes: false,
};

export const DEFAULT_LAYOUT: TenantConfig['layout'] = {
  mode: 'grid',
  selfView: 'corner',
  controlsPosition: 'bottom-center',
  controlsStyle: 'bar',
  controlsAnchor: 'bottom-center',
  hiddenControls: [],
  controlOrder: [],
  autoHideControls: false,
  autoHideDelaySec: 5,
  chatPosition: 'right',
  chatDefaultOpen: false,
  showRoomName: true,
  showParticipantCount: true,
  showQualityIndicator: true,
  showTimer: true,
  tileAspectRatio: '16:9',
  gridMaxTiles: 9,
  spotlightFollowSpeaker: true,
  chrome: 'full',
  header: 'full',
  videoFit: 'contain',
  immersiveVideo: false,
  minimized: {
    enabled: true,
    mode: 'bar',
    position: 'bottom-right',
    showSelfView: false,
    keepControls: true,
  },
  persistAcrossPages: false,
  inheritHostStyles: false,
};

export const DEFAULT_SESSION: TenantConfig['session'] = {
  defaultLocale: 'ru',
  locales: ['ru', 'en'],
  allowLocaleSwitch: true,
  defaultBlurMode: 'off',
  blurStrength: 12,
  virtualBackgrounds: [
    { id: 'office', name: 'Офис', url: '' },
    { id: 'gradient', name: 'Градиент', url: '' },
    { id: 'brand', name: 'Бренд', url: '' },
  ],
  joinWithoutPreview: false,
  mirrorSelfView: true,
  joinWithMicOff: false,
  joinWithCamOff: false,
  recording: {
    enabled: false,
    storeOnServer: false,
    consentRequired: true,
    notifyParticipants: true,
    format: 'webm',
    includeChat: true,
  },
  transcription: {
    enabled: false,
    provider: 'browser',
    language: 'ru',
    showCaptionsByDefault: false,
    saveTranscript: true,
    translateTo: 'none',
    consentRequired: false,
    retentionSec: 0,
  },
  fileShare: {
    enabled: true,
    storeOnServer: true,
    maxFileSizeMb: 25,
    allowedMimeTypes: [],
  },
  screenShare: {
    enabled: true,
    maxFps: 20,
    maxWidth: 1920,
    shareAudio: true,
    preferMotion: true,
  },
  chat: {
    ui: 'builtin',
    historyStorage: 'session',
    historyRetentionSec: 7 * 86400,
    externalProviderName: '',
    allowHostInjection: true,
    allowSystemMessages: true,
  },
  aiAgent: {
    enabled: false,
    mode: 'local',
    endpoint: '',
    apiKeyEnv: 'AGIL_AI_AGENT_KEY',
    timeoutMs: 8000,
    sendTranscripts: true,
    sendChat: false,
    batchSize: 40,
    retentionMin: 1440,
    notifyModerators: true,
    policyText: '',
    policyRules: [],
  },
  knowledgeAgent: {
    enabled: false,
    endpoint: '',
    apiKeyEnv: 'AGIL_KNOWLEDGE_AGENT_KEY',
    timeoutMs: 10000,
    allowedRoles: ['host', 'moderator'],
    requirePermission: true,
    citations: true,
    maxAnswerChars: 4000,
    systemPrompt: '',
    denyMessage: 'Ассистент по базе знаний недоступен для вашей роли',
  },
  inCallAgent: {
    enabled: true,
    mode: 'local',
    endpoint: '',
    apiKeyEnv: 'AGIL_INCALL_AGENT_KEY',
    timeoutMs: 8000,
    systemPrompt: '',
    model: '',
    compressContext: false,
    spotlight: true,
    allowedTools: [
      'start_recording',
      'stop_recording',
      'toggle_mic',
      'toggle_camera',
      'toggle_screen_share',
      'raise_hand',
      'open_chat',
      'open_files',
      'open_participants',
      'open_notes',
      'open_settings',
      'set_blur',
      'minimize',
      'restore',
      'request_fullscreen',
      'open_new_tab',
      'copy_invite_link',
    ],
    maxActionsPerReply: 3,
    audit: true,
    denyMessage: 'Это действие недоступно с вашими правами',
  },
};

export const DEFAULT_BRANDING: TenantConfig['branding'] = {
  productName: 'AgilFrame',
  organizationName: '',
  logoUrl: '',
  logoHeightPx: 28,
  faviconUrl: '',
  supportUrl: '',
  footerText: '',
  customDomain: '',
  mascotUrl: '',
  mascotName: 'Agil',
  mascotEnabled: true,
  mascotExpressions: {},
};

export const DEFAULT_ROOM: TenantConfig['room'] = {
  name: 'Комната',
  welcomeMessage: '',
  waitingMessage: 'Ожидайте, организатор скоро подключится',
  soundOnJoinLeave: true,
};

export const DEFAULT_AUDIO: TenantConfig['audio'] = {
  codecs: ['opus', 'red', 'pcmu'],
  preferredCodec: 'opus',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  dtx: true,
  ptimeMs: 20,
  opusBitrateKbps: 32,
  stereo: false,
  jitterBufferTargetMs: 0,
};

export const DEFAULT_VIDEO: TenantConfig['video'] = {
  codecs: ['av1', 'vp9', 'h264', 'vp8'],
  preferredCodec: 'vp9',
  simulcast: true,
  scalableVideoCoding: true,
  maxResolution: '720p',
  maxFps: 30,
  maxBitrateKbps: 2500,
  degradationPreference: 'maintain-framerate',
  keyFrameIntervalMs: 2000,
  contentHint: 'motion',
  encoding: {
    strategy: 'auto',
    preferredCodecs: ['av1', 'h264', 'vp9', 'vp8'],
    allowH265: false,
  },
};

/** Explicit priorities among enabled codecs, with a fallback for old drafts. */
export function videoCodecPriority(video: Partial<TenantConfig['video']>): TenantConfig['video']['codecs'] {
  const enabled = video.codecs?.length ? video.codecs : DEFAULT_VIDEO.codecs;
  const configured = video.encoding?.preferredCodecs ?? [];
  const ordered = [...new Set(configured.filter((codec) => enabled.includes(codec)))];
  if (ordered.length) return ordered;
  const preferred = video.preferredCodec;
  return [preferred && enabled.includes(preferred) ? preferred : enabled[0]!];
}

export const DEFAULT_LIMITS: TenantConfig['limits'] = {
  // Large-room profile. The effective per-room cap is min(limits/scale
  // maxParticipants, capacity-profile participants, scale.sfu.maxParticipants).
  maxParticipants: 200,
  maxDurationMin: 480,
  maxVideoSubscriptions: 36,
};

export const DEFAULT_FALLBACK: TenantConfig['fallback'] = {
  lowBandwidth: {
    enabled: true,
    strategy: 'reduce-video',
    chatOverSignaling: true,
    enterThreshold: { rttMs: 400, lossPct: 5, jitterMs: 80, minBitrateKbps: 150 },
    restoreThreshold: { rttMs: 200, lossPct: 1.5, minBitrateKbps: 500 },
    autoReconnect: { enabled: true, attempts: 6, backoffMs: 500, maxBackoffMs: 8000 },
    iceRestartOnFailure: true,
  },
};

export const DEFAULT_SECURITY: TenantConfig['security'] = {
  requireToken: true,
  waitingRoom: false,
  lockRoom: false,
  moderatorJoinFirst: false,
  e2ee: false,
  guestCanShareScreen: true,
  guestCanChat: true,
  guestCanUnmute: true,
  passwordRequired: false,
  maxFailedJoinAttempts: 8,
  lockoutSec: 300,
  requireVerifiedIdentity: false,
  auditLog: true,
  geo: {
    enabled: false,
    allowedCountries: [],
    blockedCountries: [],
    blockVpn: false,
    gpsEnabled: false,
    requireConsent: true,
  },
  mediaIntegrity: {
    enabled: false,
    livenessChallenge: false,
    frameHeuristics: true,
    externalProvider: '',
    flagThreshold: 0.7,
    autoMuteOnHighRisk: false,
  },
  liveness: {
    enabled: false,
    onEngineError: 'fail-open',
  },
  avScan: {
    enabled: false,
    mode: 'async',
    onScanError: 'fail-open',
    maxScanMb: 25,
  },
  sessionBinding: {
    enabled: false,
    bindToIp: true,
    bindToDevice: false,
  },
  accessPolicy: structuredClone(DEFAULT_ACCESS_POLICY),
};

export interface DefaultConfigOptions {
  tenantId?: string;
  themePreset?: ThemePresetName;
  themePatch?: ThemePatch;
  roomName?: string;
  overrides?: TenantConfigPatch;
}

/** Complete, validated default config for a tenant. */
export function defaultConfig(options: DefaultConfigOptions = {}): TenantConfig {
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  const preset = options.themePreset ?? 'light';
  const presetScheme: 'light' | 'dark' = preset === 'dark' || preset === 'night' ? 'dark' : 'light';
  const requestedScheme = (options.themePatch?.scheme as 'light' | 'dark' | 'auto' | undefined) ?? undefined;
  const theme = options.themePatch
    ? resolveTheme(deepMerge(structuredClone(themePresets[preset]), options.themePatch) as ThemePatch, presetScheme)
    : structuredClone(themePresets[preset]);
  // Default behaviour: follow the system scheme for light presets, unless the
  // caller explicitly pinned a scheme (patch.scheme or a dark preset).
  theme.scheme = requestedScheme ?? (presetScheme === 'dark' ? 'dark' : 'auto');

  const base: TenantConfig = {
    configVersion: CONFIG_VERSION,
    tenantId,
    branding: { ...DEFAULT_BRANDING },
    theme,
    features: { ...DEFAULT_FEATURES },
    audio: { ...DEFAULT_AUDIO },
    video: { ...DEFAULT_VIDEO },
    limits: { ...DEFAULT_LIMITS },
    fallback: structuredClone(DEFAULT_FALLBACK),
    security: { ...DEFAULT_SECURITY },
    layout: { ...DEFAULT_LAYOUT },
    session: structuredClone(DEFAULT_SESSION),
    room: { ...DEFAULT_ROOM, name: options.roomName ?? DEFAULT_ROOM.name },
    integrations: structuredClone(DEFAULT_INTEGRATIONS),
    providers: structuredClone(DEFAULT_PROVIDERS),
    scale: structuredClone(DEFAULT_SCALE),
    mediaProcessing: { ...DEFAULT_MEDIA_PROCESSING },
    billing: structuredClone(DEFAULT_BILLING),
  };
  const result = options.overrides ? deepMerge(base, options.overrides) : base;
  return tenantConfigSchema.parse(result);
}

export interface ResolveConfigOptions {
  tenantId?: string;
  themePatch?: ThemePatch;
  themePreset?: ThemePresetName;
}

/** Applies a (deep-partial) patch on top of a base config and validates the result. */
export function resolveTenantConfig(
  patch: TenantConfigPatch,
  base?: TenantConfig,
  options: ResolveConfigOptions = {},
): TenantConfig {
  const fallbackBase =
    base ??
    defaultConfig({
      tenantId: options.tenantId ?? patch.tenantId ?? DEFAULT_TENANT_ID,
      themePreset: options.themePreset,
      themePatch: options.themePatch,
    });
  const merged = deepMerge(fallbackBase, patch);
  merged.tenantId = patch.tenantId ?? fallbackBase.tenantId;
  merged.theme = resolveTheme(merged.theme as ThemePatch, merged.theme?.scheme ?? 'auto');
  return tenantConfigSchema.parse(merged);
}

/** Strips fields that must never be exposed to a browser. */
export function publicConfig(config: TenantConfig): TenantConfig {
  return config;
}

export function enabledFeatures(config: TenantConfig): FeatureKey[] {
  return (Object.keys(config.features) as FeatureKey[]).filter((key) => config.features[key]);
}

export function isEnabled(config: TenantConfig, feature: FeatureKey): boolean {
  return config.features[feature];
}
