/**
 * DTOs shared by the server admin API, the developer dashboard, the MCP server
 * and the demo. Kept free of runtime dependencies so browsers can import them.
 */
import type { ChatMessage, Participant, RoomInfo, RoomTransport } from './signaling.js';
import type { FeatureKey, Locale, TenantConfig, TenantConfigPatch } from './config.js';
import type { TurnNodeState } from './scaling.js';
import type {
  BillingConfig,
  BillingOveragePolicy,
  BillingPlanLimits,
  BillingPlanName,
} from './billing.js';

/** Non-blocking quota warning returned when `billing.overagePolicy='warn'`. */
export interface BillingQuotaWarning {
  code: 'quota_warning';
  metric: 'minutes' | 'rooms' | 'participants';
  used: number;
  limit: number;
  policy: BillingOveragePolicy;
  message: string;
}

/** Persisted monthly usage counter (one JSON file per tenant per month). */
export interface BillingUsageRecordDto {
  tenantId: string;
  /** Calendar month in UTC: `YYYY-MM`. */
  month: string;
  /** Settled room minutes (rooms with at least one connected participant). */
  minutes: number;
  roomsCreated: number;
  participantJoins: number;
  peakParticipants: number;
  recordings: number;
  recordingMinutes: number;
  createdAt: number;
  updatedAt: number;
}

export interface BillingLiveUsage {
  activeRooms: number;
  activeParticipants: number;
  /** Not-yet-settled minutes of rooms that are currently occupied. */
  liveMinutes: number;
  totalMinutes: number;
}

export interface BillingUsageResponse {
  tenantId: string;
  month: string;
  billing: BillingConfig;
  usage: BillingUsageRecordDto;
  live: BillingLiveUsage;
  quota: {
    includedMinutes: number;
    maxParticipants: number;
    maxRooms: number;
    overagePolicy: BillingOveragePolicy;
    minutesRemaining: number;
    overageMinutes: number;
  };
  /** Months with persisted usage, newest first (UTC). */
  months: string[];
  warnings: BillingQuotaWarning[];
}

export interface BillingPlanResponse {
  tenantId: string;
  billing: BillingConfig;
  plans: Record<BillingPlanName, BillingPlanLimits>;
  usage: {
    month: string;
    minutes: number;
    totalMinutes: number;
    roomsCreated: number;
    participantJoins: number;
    peakParticipants: number;
    recordings: number;
    activeRooms: number;
    activeParticipants: number;
  };
}

export const ADMIN_API_PREFIX = '/v1/admin';

export interface CreateRoomRequest {
  tenantId?: string;
  roomId?: string;
  name?: string;
  /** Plain password; the server stores only a scrypt hash and never returns it. */
  password?: string;
  maxParticipants?: number;
  /** Room TTL after last participant leaves, seconds. 0 = keep forever. */
  ttlSec?: number;
  /** Deep-partial tenant config overrides validated by the server. */
  configOverrides?: TenantConfigPatch;
  /** 'direct' for a 1:1 call from a messenger chat, 'group' for group talks. */
  mode?: 'direct' | 'group';
  /**
   * Explicit media transport for `mode:'direct'` only:
   * `p2p` forces `mediaMode:'mesh'` + 2 seats (no server media);
   * `sfu` keeps the current effective media plane; omitted = current behaviour.
   */
  transport?: RoomTransport;
  context?: import('./signaling.js').RoomContext;
  /** Require a signed token for one of these company participant IDs. */
  allowedParticipantIds?: string[];
}

export interface CreateRoomResponse {
  room: RoomInfo;
  joinUrl: string;
  embedUrl: string;
  token?: string;
  expiresAt?: number;
  passwordProtected: boolean;
  /** Set when a soft quota is exceeded (`billing.overagePolicy='warn'`). */
  billingWarning?: BillingQuotaWarning;
}

export interface InviteLink {
  roomId: string;
  joinUrl: string;
  embedUrl: string;
  token: string;
  expiresAt: number;
  passwordProtected: boolean;
}

export interface JoinRoomRequest {
  name?: string;
  password?: string;
  participantId?: string;
  locale?: 'ru' | 'en';
  /** Verified OIDC identity JWT (SSO); checked when present / required by config. */
  identityToken?: string;
}

export interface JoinRoomResponse {
  token: string;
  expiresAt: number;
  room: RoomInfo;
  participant: { id: string; name: string; role: 'host' | 'moderator' | 'guest' };
  config: TenantConfig;
  /** True when the room is protected but the password was correct. */
  passwordAccepted: boolean;
  /** Effective feature permissions resolved for this participant. */
  permissions?: import('./config.js').FeatureKey[];
  /** Present when the room runs on the SFU (LiveKit); absent for mesh. */
  media?: import('./signaling.js').SfuMediaSession;
  /** Set when a soft quota is exceeded (`billing.overagePolicy='warn'`). */
  billingWarning?: BillingQuotaWarning;
}

export interface AdminRoomSummary {
  room: RoomInfo;
  participants: number;
  maxParticipants: number;
  passwordProtected: boolean;
  createdAt: number;
  lastActivityAt: number;
  recordings: number;
  joinUrl: string;
  embedUrl: string;
}

export interface AdminOverview {
  tenantId: string;
  serverTime: number;
  uptimeSec: number;
  activeRooms: number;
  activeParticipants: number;
  /** Rooms created by the tenant since this Core process started. */
  totalRoomsCreated: number;
  waitingParticipants?: number;
  recordings: number;
  sharedFiles: number;
  securityEvents24h: number;
  countries: Record<string, number>;
}

export type AuditSeverity = 'info' | 'warn' | 'critical';

export const auditEventTypes = [
  'room.created',
  'room.closed',
  'room.locked',
  'join.allowed',
  'join.denied',
  'public_abuse.threshold',
  'password.failed',
  'geo.blocked',
  'lockout',
  'config.updated',
  'recording.started',
  'recording.saved',
  'file.shared',
  'file.scanned',
  'file.quarantined',
  'file.quarantine_failed',
  'file.scan_unavailable',
  'liveness.challenge',
  'liveness.verified',
  'liveness.failed',
  'liveness.unavailable',
  'chat.sent',
  'call.ended',
  'integrity.flagged',
  'session.bound',
  'knowledge.query',
  'knowledge.denied',
  'access.updated',
  'webhook.delivered',
  'webhook.failed',
  'admin.action',
  'lobby.pending',
  'lobby.admitted',
  'lobby.rejected',
  'lobby.expired',
  'domain.updated',
  'domain.verified',
  'domain.verify_failed',
  'route.created',
  'route.updated',
  'route.deleted',
  'route.tested',
  'route.matched',
  'route.egress.started',
  'route.egress.failed',
  'route.edge_token_issued',
  'route.edge_token_revoked',
  'edge.joined',
  'flow.created',
  'flow.updated',
  'flow.deleted',
  'flow.tested',
  'flow.matched',
  'flow.started',
  'flow.pending',
  'flow.failed',
  'flow.schedule.tick',
  'poll.created',
  'poll.voted',
  'poll.closed',
  'breakout.started',
  'breakout.closed',
  'whiteboard.opened',
  'whiteboard.cleared',
  'whiteboard.closed',
  'annotation.cleared',
  /** A dropped signaling socket resumed an existing participant (continuity). */
  'session.resumed',
  /** A room snapshot was restored from disk/Redis after a Core restart. */
  'room.restored',
  /** An SFU node entered/left drain mode; its rooms stay joinable. */
  'room.draining',
  'sip.dialin.started',
  'sip.dialin.stopped',
  'sip.dialin.failed',
  /** Participant granted/withdrew consent for server STT / transcript storage. */
  'transcript.consent',
  /** Stored transcript was purged (retention, host action or erasure request). */
  'transcript.purged',
] as const;

export type AuditEventType = (typeof auditEventTypes)[number];

export interface AuditEntry {
  id: string;
  ts: number;
  type: AuditEventType;
  severity: AuditSeverity;
  tenantId?: string;
  roomId?: string;
  participantId?: string;
  /** SHA-256 of the IP with the server salt; never the raw address. */
  ipHash?: string;
  country?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface FileRecord {
  id: string;
  tenantId: string;
  roomId: string;
  name: string;
  size: number;
  mime: string;
  url: string;
  createdAt: number;
  expiresAt: number;
  uploadedBy: string;
}

export interface RecordingRecord {
  id: string;
  tenantId: string;
  roomId: string;
  mime: string;
  size: number;
  durationSec: number;
  url: string;
  createdAt: number;
  createdBy: string;
  transcript?: string;
  /** Omitted for browser recordings uploaded to the Core store. */
  source?: 'egress';
  /** Storage-side deletion permission for archived Egress objects. */
  canDelete?: boolean;
}

export interface SttRequest {
  language?: 'ru' | 'en' | 'auto';
}

export interface SttSegment {
  start: number;
  end: number;
  text: string;
  lang?: string;
  /** Machine translation of this segment (only when translation was requested). */
  translation?: import('./compliance.js').TranscriptTranslation;
}

export interface SttResponse {
  text: string;
  /**
   * `browser`/`server` name where STT ran; `local` marks an on-box
   * whisper.cpp / faster-whisper result.
   */
  provider: 'browser' | 'server' | 'local' | 'stub';
  language?: string;
  durationSec?: number;
  segments?: SttSegment[];
  /** Local engine label (e.g. `whisper.cpp:small`, `faster-whisper:small`). */
  engine?: string;
  model?: string;
  /** True when audio never left the deployment (local STT). */
  local?: boolean;
  /** Summary of the translation pass, when one ran. */
  translation?: {
    targetLang: 'ru' | 'en';
    provider: 'local' | 'llm' | 'stub';
    engine?: string;
  };
  /** Machine-translation quality/limitation note (never claims human quality). */
  notice?: string;
}

export interface RoomDetail {
  room: RoomInfo;
  participants: Participant[];
  messages: ChatMessage[];
  passwordProtected: boolean;
  createdAt: number;
  lastActivityAt: number;
  joinUrl: string;
  embedUrl: string;
  /**
   * Effective join cap for this room:
   * `min(room.maxParticipants, scale.maxParticipants, profile participants,
   * scale.sfu.maxParticipants)` for SFU/broadcast; `min(room, scale)` for mesh.
   */
  effectiveMaxParticipants: number;
  /** Breakdown of the limits and the binding constraint (`room|scale|profile|sfu`). */
  capacity: import('./scaling.js').ParticipantCapacity;
}

/**
 * Public room info shown on the join screen *before* authentication, so the
 * widget knows whether to ask for a password or show "room locked/closed".
 * Contains no secrets and no participant data.
 */
export interface RoomPublicInfo {
  roomId: string;
  tenantId: string;
  name: string;
  passwordProtected: boolean;
  locked: boolean;
  open: boolean;
  participants: number;
  maxParticipants: number;
  /** Effective permissions for the guest role (UI can pre-hide features). */
  guestFeatures?: import('./config.js').FeatureKey[];
  mode?: 'direct' | 'group';
  context?: import('./signaling.js').RoomContext;
}

export interface SecurityOverview {
  tenantId: string;
  events: AuditEntry[];
  failedJoins24h: number;
  blockedJoins24h: number;
  suspiciousParticipants: number;
  countries: Record<string, number>;
}

/** Paginated audit response (stable offset/limit + total for UI tables). */
export interface AuditListResponse {
  entries: AuditEntry[];
  total: number;
  offset: number;
  limit: number;
  /** Send back when paging or exporting the same view. */
  anchorId?: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * Post a chat message into a room from the company's own system (bot, CRM,
 * external chat bridge) or from the host page. Works without a WebSocket.
 */
export interface ChatPostRequest {
  text: string;
  /** 'system' renders as a centred notice instead of a bubble. */
  kind?: 'text' | 'system';
  /** Anonymous display identity for imports from the company chat. */
  from?: { id?: string; name?: string; role?: 'host' | 'moderator' | 'guest' };
  /** Idempotency key: repeated posts with the same id are ignored. */
  id?: string;
}

export interface ChatPostResponse {
  message: ChatMessage;
}

export interface HealthResponse {
  ok: boolean;
  name: string;
  version: string;
  uptimeSec: number;
  rooms: number;
  tenants: number;
  security: {
    geoEnabled: boolean;
    integrityEnabled: boolean;
    /** True when the default tenant has a working STT path (remote or local engine). */
    sttConfigured: boolean;
    /** Effective server STT mode (`local` | `none` | `browser` | legacy `remote`). */
    sttProvider?: 'local' | 'none' | 'browser' | 'remote';
    /** Effective machine-translation provider (`local` | `none` | `llm`). */
    translationProvider?: 'local' | 'none' | 'llm';
    /** Privacy mode: `local` refuses external ASR/MT/LLM paths. */
    privacyMode?: 'standard' | 'local';
    aiAgentConfigured: boolean;
    recordingsDir: string;
    /** Whether /docs, /openapi.json and /docs/:file are reachable (env gating). */
    docsEnabled?: boolean;
    /** Whether /v1/admin/* is enabled at all (env switch for microservice setups). */
    adminApiEnabled?: boolean;
    /** Whether the HTTP MCP endpoint (/mcp) is enabled. */
    mcpHttpEnabled?: boolean;
  };
}

export interface AiAgentSettingsResponse {
  config: import('./compliance.js').AiAgentConfig;
  /** Whether the server can resolve the API key from the environment. */
  endpointConfigured: boolean;
  apiKeyConfigured: boolean;
}

export interface TranscriptResponse {
  roomId: string;
  segments: import('./compliance.js').TranscriptSegment[];
  updatedAt: number;
  /** Translation policy in effect for this tenant (never secrets). */
  translation?: {
    enabled: boolean;
    target: 'ru' | 'en' | 'none';
    provider: 'local' | 'llm' | 'none';
    engine?: string;
  };
  /** Retention/consent policy applied to the returned segments. */
  retention?: {
    retentionSec: number;
    consentRequired: boolean;
    /** True when the calling participant (join-token callers only) consented. */
    consented?: boolean;
  };
}

export interface AnalysisResponse {
  roomId: string;
  report: import('./compliance.js').ComplianceReport | null;
  findings: import('./compliance.js').ComplianceFinding[];
  notes: import('./compliance.js').MeetingNotes | null;
}

/** Effective permissions per role + the raw policy (our side owns resolution). */
export interface AccessPolicyResponse {
  policy: import('./config.js').AccessPolicy;
  featureKeys: import('./config.js').FeatureKey[];
  effective: Record<'host' | 'moderator' | 'guest', import('./config.js').FeatureKey[]>;
}

export interface KnowledgeAgentSettingsResponse {
  config: import('./config.js').TenantConfig['session']['knowledgeAgent'];
  endpointConfigured: boolean;
  apiKeyConfigured: boolean;
}

export interface KnowledgeAskRequest {
  question: string;
  userId?: string;
  role?: 'host' | 'moderator' | 'guest';
  roomId?: string;
  locale?: 'ru' | 'en';
}

export interface KnowledgeAskResponse {
  answer: string;
  citations: import('./compliance.js').KnowledgeCitation[];
  confidence?: number;
  provider?: string;
  model?: string;
  refused?: boolean;
}

export interface WebhookTestResponse {
  endpointId: string;
  status: 'delivered' | 'failed';
  statusCode?: number;
  error?: string;
}

export interface WebhooksResponse {
  webhooks: import('./integrations.js').WebhookEndpointConfig[];
  recentDeliveries: import('./integrations.js').WebhookDeliveryRecord[];
}

/* ------------------------------------------------------------------ */
/* Scale-out: media mode, cluster, TURN pool, SFU, webinar             */
/* ------------------------------------------------------------------ */

export interface ScaleStatusResponse {
  config: import('./scaling.js').ScaleConfig;
  /** Effective media mode for new rooms. */
  mediaMode: import('./scaling.js').MediaMode;
  cluster: {
    nodeId: string;
    nodes: Array<{ id: string; url: string; region: string; weight: number; healthy: boolean | null; note?: string }>;
    strategy: string;
    redisConfigured: boolean;
    stickySessions: boolean;
  };
  turn: Array<{
    id: string;
    nodeId?: string;
    nodeAvailable?: boolean;
    nodeState?: TurnNodeState;
    automatic?: boolean;
    urls: string[];
    region: string;
    weight: number;
    usernameConfigured: boolean;
    credentialConfigured: boolean;
    credentialMode?: 'static' | 'rest';
  }>;
  sfuConfigured: boolean;
  /**
   * Effective client gallery capacity profile (env `AGIL_SFU_PROFILE` wins over
   * `scale.sfu.capacityProfile`; default `standard`). Surfaces the remote-video
   * budget the widget will use, without deploying the SFU here.
   */
  sfuProfile?: import('./scaling.js').SfuCapacityProfile;
  /** Planning table entry for {@link sfuProfile} (sizing guidance, not a benchmark). */
  sfuCapacity?: import('./scaling.js').SfuCapacityProfileSpec;
  /**
   * Effective participant cap for a default group room:
   * `min(scale.maxParticipants, profile participants, scale.sfu.maxParticipants)`
   * (mesh: `min(scale.maxParticipants)`). The dashboard uses it to warn when a
   * requested room limit exceeds the deployed capacity profile.
   */
  effectiveMaxParticipants: number;
  /** Limit breakdown + binding constraint for {@link effectiveMaxParticipants}. */
  capacity: import('./scaling.js').ParticipantCapacity;
  webinarEnabled: boolean;
  streamingProvider: string;
  /** Declared for clients/dashboards; a single-node install does not implement it. */
  limitations: string[];
}

export interface ClusterStatusResponse {
  nodeId: string;
  nodes: Array<{ id: string; url: string; region: string; weight: number; healthy: boolean | null; note?: string }>;
  strategy: string;
  redisConfigured: boolean;
  stickySessions: boolean;
  /** true when the server actually runs multi-node pub/sub. */
  multiNodeActive: boolean;
  /**
   * Enrollment registry (added by newer servers; optional so the panel also
   * works against an older Core). See docs/api/cluster.md.
   */
  cluster?: import('./cluster.js').Cluster;
  standbys?: import('./cluster.js').StandbyCoreSummary[];
  enrolledNodes?: import('./cluster.js').NodeSummary[];
  counts?: import('./cluster.js').ClusterNodeCounts;
  /** Leader lease / failover state (HA stage). */
  leader?: import('./cluster.js').ClusterLeaderStatus;
  lease?: import('./cluster.js').LeaderLeaseStatus;
  ha?: import('./cluster.js').ClusterHaStatus;
  failover?: import('./cluster.js').ClusterFailoverStatus;
  limitations?: string[];
}

/** Replaceable capability providers. */
export type ProviderSlotName = 'chat' | 'files' | 'stt' | 'notifications' | 'recording' | 'backgrounds';

export interface ProviderStatus {
  slot: ProviderSlotName;
  mode: 'builtin' | 'external' | 'disabled';
  providerName: string;
  configured: boolean;
  /** Whether the active provider currently looks usable (env/secret/endpoint). */
  available: boolean;
  fallback: 'builtin' | 'fail';
  note?: string;
}

export interface ProvidersResponse {
  providers: ProviderStatus[];
}

export interface ProviderTestRequest {
  slot: ProviderSlotName;
  /** Optional synthetic payload; defaults to a small capability-specific probe. */
  payload?: Record<string, unknown>;
}

export interface ProviderTestResponse {
  slot: ProviderSlotName;
  ok: boolean;
  providerName: string;
  latencyMs: number;
  detail?: string;
}

export interface BackgroundItem {
  id: string;
  name: string;
  url: string;
}

export interface BackgroundsResponse {
  /** Builtin backgrounds from config.session.virtualBackgrounds (or external provider). */
  backgrounds: BackgroundItem[];
  provider: string;
}

export interface TokenResponse {
  token: string;
  expiresAt: number;
  tenantId: string;
  roomId: string;
  /** Effective permissions that will be resolved for this token. */
  permissions: import('./config.js').FeatureKey[];
  /** Custom role id when the token was issued for a company-defined role. */
  roleId?: string;
  /** Display name of the custom role. */
  roleName?: string;
}

/* ------------------------------------------------------------------ */
/* Roles: built-in host/moderator/guest + company-defined custom roles */
/* ------------------------------------------------------------------ */

export interface RoleDefinition {
  id: string;
  name: string;
  description: string;
  baseRole: 'host' | 'moderator' | 'guest';
  features: import('./config.js').FeatureKey[];
  canModerate: boolean;
  color: string;
  /** Built-in roles cannot be deleted; their defaults are edited via access-policy. */
  builtin: boolean;
  /** How many participants currently use this role (0 for built-in base roles). */
  assigned?: number;
}

export interface RolesResponse {
  roles: RoleDefinition[];
}

export interface RoleWriteRequest {
  id: string;
  name: string;
  description?: string;
  baseRole: 'host' | 'moderator' | 'guest';
  features: import('./config.js').FeatureKey[];
  canModerate?: boolean;
  color?: string;
}

/* ------------------------------------------------------------------ */
/* Dashboard mascot assistant + critical-change guard                   */
/* ------------------------------------------------------------------ */

export type GuardRisk = 'low' | 'medium' | 'high' | 'critical';

export interface GuardFinding {
  id: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  description: string;
  /** What exactly may break / who is affected. */
  impact: string;
  affected: string[];
  requiresConfirmation: boolean;
}

export interface GuardAssessRequest {
  kind: 'config' | 'roles' | 'access' | 'scale' | 'providers' | 'webhook' | 'room' | 'integrations';
  /** Language of explanations. Defaults to Russian for existing clients. */
  locale?: Locale;
  /** Current value (server uses live tenant config when omitted). */
  current?: unknown;
  /** Proposed value. */
  next: unknown;
  /** A complete editor draft replaces the per-user overrides and mascot image maps. */
  editorDraft?: boolean;
  /** Human-readable intent from the admin UI ("выключить запись"). */
  intent?: string;
}

export interface GuardAssessResponse {
  risk: GuardRisk;
  requiresConfirmation: boolean;
  summary: string;
  /** What the mascot should say to the admin in the requested language. */
  message: string;
  findings: GuardFinding[];
  /** Suggestions / safer alternatives. */
  recommendations: string[];
}

export type DashboardAssistantRole =
  | 'assistant'
  | 'config-guardian'
  | 'security-reviewer'
  | 'onboarding'
  | 'api-helper'
  | 'scaling-advisor'
  | 'roles-admin';

export interface DashboardAssistantMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface DashboardAssistantRequest {
  messages: DashboardAssistantMessage[];
  role?: DashboardAssistantRole;
  context?: {
    screen?: string;
    tenantId?: string;
    roomId?: string;
    currentConfig?: unknown;
    /** Relevant excerpts from previous chats (agent memory across conversations). */
    memory?: string;
    /** Current chat session id (for logs/history). */
    chatId?: string;
  };
}

export interface DashboardAssistantResponse {
  reply: string;
  role: DashboardAssistantRole;
  model: string;
  /** true when the local rule-based fallback answered (no API key / provider error). */
  fallback: boolean;
  /** Optional risk assessment produced alongside the answer. */
  risk?: GuardAssessResponse;
  suggestions: string[];
}

export interface AssistantPromptInfo {
  role: DashboardAssistantRole;
  title: string;
  description: string;
  starters: string[];
}

/* ------------------------------------------------------------------ */
/* Документация: просмотр/редактирование/загрузка/версии из панели     */
/* ------------------------------------------------------------------ */

export interface DocEntry {
  /** File name inside the docs directory, e.g. `security-audit.md`. */
  name: string;
  title: string;
  sizeBytes: number;
  updatedAt: number;
  /** True for the bundled repository document (no edits yet). */
  bundled: boolean;
  /** True when an edited copy exists in the data dir. */
  custom: boolean;
  /** Selected as the primary document shown in the panel/docs menu. */
  isDefault: boolean;
  versions: number;
}

export interface DocsListResponse {
  docs: DocEntry[];
  defaultName: string;
  /** Directory is writable (editing available). */
  editable: boolean;
  /** Core supports checking expectedRevision on the restore endpoint. */
  revisionRestore?: boolean;
  /** Core accepts expectedRevision: null to create a new document conditionally. */
  conditionalCreate?: boolean;
}

export interface DocContentResponse {
  name: string;
  title: string;
  content: string;
  updatedAt: number;
  bundled: boolean;
  custom: boolean;
  isDefault: boolean;
  /** Opaque identifier of the effective publication, returned by newer servers. */
  revision?: string;
}

export interface DocWriteRequest {
  content: string;
  /** Optional new title (heading shown in the panel). */
  title?: string;
  /** Match the current revision. Null requires that the document does not exist. */
  expectedRevision?: string | null;
}

export interface DocRevisionRequest {
  expectedRevision?: string;
}

export interface DocVersion {
  id: string;
  name: string;
  createdAt: number;
  sizeBytes: number;
  author: string;
  note?: string;
  isCurrent: boolean;
}

export interface DocHistoryResponse {
  name: string;
  versions: DocVersion[];
}

export interface DocDefaultRequest {
  name: string;
}

/* ------------------------------------------------------------------ */
/* Multi-organization SaaS: platform owner manages organizations       */
/* ------------------------------------------------------------------ */

export interface TenantSummary {
  tenantId: string;
  name: string;
  organizationName: string;
  productName: string;
  logoUrl: string;
  scheme: 'light' | 'dark' | 'auto' | 'auto-light' | 'auto-dark';
  /** Counts for the platform dashboard. */
  rooms: number;
  participants: number;
  recordings: number;
  /** API key exists (value is never returned in lists). */
  apiKeyConfigured: boolean;
  createdAt?: number;
}

export interface TenantsResponse {
  tenants: TenantSummary[];
  /** True when the caller is the platform owner (AGIL_PLATFORM_KEY). */
  platform: boolean;
}

export interface TenantCreateRequest {
  tenantId: string;
  name: string;
  organizationName?: string;
  branding?: {
    productName?: string;
    logoUrl?: string;
    faviconUrl?: string;
    supportUrl?: string;
    footerText?: string;
  };
  theme?: {
    preset?: string;
    scheme?: 'light' | 'dark' | 'auto';
    colors?: Record<string, string>;
  };
  /** Copy features/layout/security from this tenant (defaults to demo/common preset). */
  templateTenantId?: string;
  /** Preset for a quick start: default, corporate (strict), minimal. */
  preset?: 'default' | 'corporate' | 'minimal';
  /** Explicit feature overrides applied on top of the selected preset. */
  features?: Partial<Record<FeatureKey, boolean>>;
}

export interface TenantCreatedResponse {
  tenant: TenantSummary;
  /** Plaintext API key, returned ONLY once (store it now). */
  apiKey: string;
  embedUrl: string;
}

export interface TenantKeyResponse {
  tenantId: string;
  apiKey: string;
}

export interface TenantCreatedInfo {
  tenantId: string;
  createdAt: number;
  name: string;
}

/* ------------------------------------------------------------------ */
/* Лобби (waiting room) с admit/reject + календарь + домен             */
/* ------------------------------------------------------------------ */

export interface LobbyRequestInfo {
  id: string;
  name: string;
  country?: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending';
}

export interface LobbyJoinResponse {
  pending: true;
  requestId: string;
  cancelToken?: string;
  roomId: string;
  status: 'pending';
  expiresAt: number;
  pollAfterMs: number;
  waitingMessage?: string;
}

export interface LobbyRequestsResponse {
  roomId: string;
  requests: LobbyRequestInfo[];
}

export interface LobbyStatusResponse {
  requestId: string;
  status: 'pending' | 'admitted' | 'rejected' | 'expired';
  token?: string;
  expiresAt?: number;
  joinUrl?: string;
  embedUrl?: string;
  reason?: string;
}

export interface LobbyDecisionResponse {
  requestId: string;
  status: 'admitted' | 'rejected';
}

export interface DomainConfigRequest {
  domain: string;
}

export type DomainStatus = 'none' | 'pending' | 'verified';

export interface DomainDnsRecord {
  type: 'TXT' | 'CNAME';
  name: string;
  value: string;
  ttl: number;
}

export interface DomainVerificationInfo {
  /** Public verification secret; publish it as `agil-verify=<token>` in TXT. */
  token: string;
  method: 'txt' | 'cname';
  txt: { name: string; value: string; ttl: number };
  cname: { name: string; value: string; ttl: number };
  verifiedAt?: number;
  lastCheckedAt?: number;
  lastError?: string;
}

export interface DomainConfigResponse {
  domain: string;
  status: DomainStatus;
  verified: boolean;
  /** Empty when no domain is configured. */
  verification?: DomainVerificationInfo;
  dnsInstructions: {
    type: 'CNAME';
    name: string;
    value: string;
    ttl: number;
  };
  docsHint: string;
}

/** `GET /v1/host` — public tenant resolution for the current request host. */
export interface HostInfoResponse {
  /** Bare, lowercase Host used for resolution ('' when the header is invalid). */
  host: string;
  tenantId: string;
  defaultTenantId: string;
  resolved: 'domain' | 'default';
  /** Verified custom domain, or '' on the default host. */
  customDomain: string;
  verified: boolean;
  branding: {
    productName: string;
    organizationName: string;
    logoUrl: string;
    faviconUrl: string;
    supportUrl: string;
    footerText: string;
  };
}

/**
 * `GET /v1/domain/ask` — Caddy/HAProxy on-demand TLS approval hook.
 *
 * Proxy-only surface: it never discloses `tenantId` (a certificate check needs
 * only the HTTP status), and unverified domains are answered with 404.
 */
export interface DomainAskResponse {
  allowed: boolean;
  domain: string;
}

/** Admin API paths (dashboard + MCP use these instead of hardcoding strings). */
export const adminPaths = {
  overview: `${ADMIN_API_PREFIX}/overview`,
  rooms: `${ADMIN_API_PREFIX}/rooms`,
  room: (roomId: string) => `${ADMIN_API_PREFIX}/rooms/${roomId}`,
  roomInvites: (roomId: string) => `${ADMIN_API_PREFIX}/rooms/${roomId}/invites`,
  roomLock: (roomId: string) => `${ADMIN_API_PREFIX}/rooms/${roomId}/lock`,
  roomKick: (roomId: string) => `${ADMIN_API_PREFIX}/rooms/${roomId}/kick`,
  roomTranscript: (roomId: string) => `${ADMIN_API_PREFIX}/rooms/${roomId}/transcript`,
  roomAnalysis: (roomId: string) => `${ADMIN_API_PREFIX}/rooms/${roomId}/analysis`,
  roomAnalysisRun: (roomId: string) => `${ADMIN_API_PREFIX}/rooms/${roomId}/analysis/run`,
  roomConversationReview: (roomId: string) => `${ADMIN_API_PREFIX}/rooms/${roomId}/conversation-review`,
  roomChat: (roomId: string) => `${ADMIN_API_PREFIX}/rooms/${roomId}/chat`,
  aiAgent: `${ADMIN_API_PREFIX}/ai-agent`,
  knowledgeAgent: `${ADMIN_API_PREFIX}/knowledge-agent`,
  knowledgeAsk: `${ADMIN_API_PREFIX}/knowledge/ask`,
  accessPolicy: `${ADMIN_API_PREFIX}/access-policy`,
  webhooks: `${ADMIN_API_PREFIX}/webhooks`,
  webhooksTest: `${ADMIN_API_PREFIX}/webhooks/test`,
  scale: `${ADMIN_API_PREFIX}/scale`,
  routes: `${ADMIN_API_PREFIX}/routes`,
  route: (routeId: string) => `${ADMIN_API_PREFIX}/routes/${encodeURIComponent(routeId)}`,
  routeTest: (routeId: string) => `${ADMIN_API_PREFIX}/routes/${encodeURIComponent(routeId)}/test`,
  routeEdgeTokens: `${ADMIN_API_PREFIX}/routes/edge-tokens`,
  routeEdgeToken: (tokenId: string) => `${ADMIN_API_PREFIX}/routes/edge-tokens/${encodeURIComponent(tokenId)}`,
  // Generic media flows (docs/flows.md). `/routes` stays the legacy alias surface.
  flows: `${ADMIN_API_PREFIX}/flows`,
  flow: (flowId: string) => `${ADMIN_API_PREFIX}/flows/${encodeURIComponent(flowId)}`,
  flowTest: (flowId: string) => `${ADMIN_API_PREFIX}/flows/${encodeURIComponent(flowId)}/test`,
  flowStatus: (flowId: string) => `${ADMIN_API_PREFIX}/flows/${encodeURIComponent(flowId)}/status`,
  flowTick: `${ADMIN_API_PREFIX}/flows/tick`,
  flowEdgeTokens: `${ADMIN_API_PREFIX}/flows/edge-tokens`,
  flowEdgeToken: (tokenId: string) => `${ADMIN_API_PREFIX}/flows/edge-tokens/${encodeURIComponent(tokenId)}`,
  clusterStatus: `${ADMIN_API_PREFIX}/cluster/status`,
  clusterTokens: `${ADMIN_API_PREFIX}/cluster/tokens`,
  clusterToken: (tokenId: string) => `${ADMIN_API_PREFIX}/cluster/tokens/${encodeURIComponent(tokenId)}`,
  nodes: `${ADMIN_API_PREFIX}/nodes`,
  node: (nodeId: string) => `${ADMIN_API_PREFIX}/nodes/${encodeURIComponent(nodeId)}`,
  nodeDisable: (nodeId: string) => `${ADMIN_API_PREFIX}/nodes/${encodeURIComponent(nodeId)}/disable`,
  nodeDrain: (nodeId: string) => `${ADMIN_API_PREFIX}/nodes/${encodeURIComponent(nodeId)}/drain`,
  turnTest: `${ADMIN_API_PREFIX}/scale/turn/test`,
  providers: `${ADMIN_API_PREFIX}/providers`,
  providersTest: `${ADMIN_API_PREFIX}/providers/test`,
  roles: `${ADMIN_API_PREFIX}/roles`,
  role: (roleId: string) => `${ADMIN_API_PREFIX}/roles/${roleId}`,
  assistant: `${ADMIN_API_PREFIX}/assistant`,
  assistantPrompts: `${ADMIN_API_PREFIX}/assistant/prompts`,
  guardAssess: `${ADMIN_API_PREFIX}/guard/assess`,
  docs: `${ADMIN_API_PREFIX}/docs`,
  doc: (name: string) => `${ADMIN_API_PREFIX}/docs/${encodeURIComponent(name)}`,
  docVersions: (name: string) => `${ADMIN_API_PREFIX}/docs/${encodeURIComponent(name)}/versions`,
  docVersion: (name: string, versionId: string) => `${ADMIN_API_PREFIX}/docs/${encodeURIComponent(name)}/versions/${encodeURIComponent(versionId)}`,
  docRestore: (name: string, versionId: string) => `${ADMIN_API_PREFIX}/docs/${encodeURIComponent(name)}/versions/${encodeURIComponent(versionId)}/restore`,
  docDefault: `${ADMIN_API_PREFIX}/docs/default`,
  docUpload: `${ADMIN_API_PREFIX}/docs/upload`,
  tenants: `${ADMIN_API_PREFIX}/tenants`,
  tenant: (tenantId: string) => `${ADMIN_API_PREFIX}/tenants/${encodeURIComponent(tenantId)}`,
  tenantKeys: (tenantId: string) => `${ADMIN_API_PREFIX}/tenants/${encodeURIComponent(tenantId)}/keys`,
  domain: `${ADMIN_API_PREFIX}/domain`,
  domainVerify: `${ADMIN_API_PREFIX}/domain/verify`,
  audit: `${ADMIN_API_PREFIX}/audit`,
  security: `${ADMIN_API_PREFIX}/security`,
  recordings: `${ADMIN_API_PREFIX}/recordings`,
  files: `${ADMIN_API_PREFIX}/files`,
} as const;

/** Public (participant) API paths. */
export const publicPaths = {
  health: '/v1/health',
  host: '/v1/host',
  domainAsk: '/v1/domain/ask',
  ice: '/v1/ice',
  tokens: '/v1/tokens',
  roomInfo: (roomId: string) => `/v1/rooms/${roomId}`,
  join: (roomId: string) => `/v1/rooms/${roomId}/join`,
  roomChat: (roomId: string) => `/v1/rooms/${roomId}/chat`,
  roomLobby: (roomId: string) => `/v1/rooms/${roomId}/lobby`,
  roomLobbyRequest: (roomId: string, requestId: string) => `/v1/rooms/${roomId}/lobby/${requestId}`,
  roomLobbyAdmit: (roomId: string, requestId: string) => `/v1/rooms/${roomId}/lobby/${requestId}/admit`,
  roomLobbyReject: (roomId: string, requestId: string) => `/v1/rooms/${roomId}/lobby/${requestId}/reject`,
  roomCalendar: (roomId: string) => `/v1/rooms/${roomId}/calendar.ics`,
  roomPolls: (roomId: string) => `/v1/rooms/${roomId}/polls`,
  roomPollVote: (roomId: string, pollId: string) => `/v1/rooms/${roomId}/polls/${pollId}/vote`,
  roomPollClose: (roomId: string, pollId: string) => `/v1/rooms/${roomId}/polls/${pollId}/close`,
  roomBreakouts: (roomId: string) => `/v1/rooms/${roomId}/breakouts`,
  roomBreakoutStart: (roomId: string) => `/v1/rooms/${roomId}/breakouts/start`,
  roomBreakoutClose: (roomId: string) => `/v1/rooms/${roomId}/breakouts/close`,
  roomConfig: (tenantId: string) => `/v1/tenants/${tenantId}/config`,
  backgrounds: (tenantId: string) => `/v1/tenants/${tenantId}/backgrounds`,
  files: '/v1/files',
  recordings: '/v1/recordings',
  stt: '/v1/stt/transcribe',
  edgeJoin: '/v1/edge/join',
  ws: '/ws',
} as const;
