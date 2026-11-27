/**
 * Typed client for the AgilFrame admin/public API (§14 of docs/contract.md).
 *
 * - base URL: localStorage `agil_server_url`, default — the current origin;
 * - key: localStorage `agil_api_key`, default — `dev-key`;
 * - every request carries `x-api-key` (except public endpoints);
 * - 10 s timeout via AbortController, errors parsed from `{error:{code,message}}`.
 *
 * The API key is never logged and never included in error messages.
 */
import { adminPaths, nodeCustomModuleTemplatesSchema, nodeModuleAvailabilitySchema, nodeModuleLogWindowsSchema, nodeModulesPaths, publicPaths } from '@agil/protocol';
import type {
  AccessPolicyExpected,
  AccessPolicyPatch,
  AccessPolicyResponse,
  AdminOverview,
  AdminRoomSummary,
  AiAgentConfig,
  AiAgentSettingsResponse,
  AnalysisResponse,
  ApiErrorBody,
  AssistantPromptInfo,
  AuditEntry,
  AuditListResponse,
  ChatPostRequest,
  ChatPostResponse,
  ClusterStatusResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  DashboardAssistantRequest,
  DashboardAssistantResponse,
  DocContentResponse,
  DocDefaultRequest,
  DocEntry,
  DocHistoryResponse,
  DocsListResponse,
  DocVersion,
  DocWriteRequest,
  DocRevisionRequest,
  EnrollmentTokenCreateRequest,
  EnrollmentTokenCreatedResponse,
  EnrollmentTokenRevokeResponse,
  EnrollmentTokenSummary,
  FeatureKey,
  GuardAssessRequest,
  GuardAssessResponse,
  HealthResponse,
  InviteLink,
  KnowledgeAgentSettingsResponse,
  KnowledgeAskRequest,
  KnowledgeAskResponse,
  ProviderSlotName,
  ProviderTestRequest,
  ProviderTestResponse,
  ProvidersResponse,
  RecordingRecord,
  RoleDefinition,
  RoleWriteRequest,
  RolesResponse,
  RoomDetail,
  ScaleConfig,
  ScaleStatusResponse,
  SecurityOverview,
  TenantConfig,
  TenantConfigPatch,
  TenantCreateRequest,
  TenantCreatedResponse,
  TenantKeyResponse,
  TenantsResponse,
  LobbyDecisionResponse,
  LobbyRequestsResponse,
  NodeModuleAction,
  NodeModuleCatalogResponse,
  NodeModuleCommand,
  NodeModulesResponse,
  NodeSummary,
  NodeUpdateRequest,
  OidcStartResponse,
  OidcLogoutResponse,
  PollListResponse,
  RoomPoll,
  TokenResponse,
  TranscriptResponse,
  WebhookEndpointConfig,
  WebhookTestResponse,
  WebhooksResponse,
} from '@agil/protocol';
import { currentOrigin } from './format.js';

export const API_TIMEOUT_MS = 10_000;
export const DEFAULT_API_KEY = 'dev-key';

export interface AdminApiOptions {
  baseUrl?: string;
  apiKey?: string;
  /**
   * SSO admin session (short-lived JWT). When present it is sent as
   * `Authorization: Bearer` instead of `x-api-key`.
   */
  sessionToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** false for public endpoints (health/ice/config GET/join). */
  auth?: boolean;
  timeoutMs?: number;
  idempotencyKey?: string;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  anchorId?: string;
  type?: string;
  /** Comma-separated audit types (server accepts `types=a,b`). */
  types?: string;
  severity?: string;
  roomId?: string;
  q?: string;
}

export interface CreateTokenRequest {
  tenantId: string;
  roomId: string;
  participant: {
    name: string;
    participantId?: string;
    role?: 'host' | 'moderator' | 'guest';
    /** Company-defined role from GET /v1/admin/roles (effective features). */
    roleId?: string;
  };
  ttlSec?: number;
  /** Pins the exact feature list; empty/omitted = role defaults from the access policy. */
  permissions?: FeatureKey[];
}

export interface IceResponse {
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
}

export interface ConfigEnvelope {
  config: TenantConfig;
  etag?: string;
}

/** GET /v1/admin/media/processing — server media-plane status. */
export interface MediaProcessingStatus {
  serverProcessingActive: boolean;
  sfuForwardingOnly: boolean;
  egressConfigured: boolean;
  misconfigured: boolean;
  /** Optional E2EE capabilities exposed by newer servers. */
  e2eeConfigured?: boolean;
  e2eeActive?: boolean;
  mode?: string;
  provider?: string;
  detail?: string;
}

/** GET /v1/admin/stt — honest local STT/translation status (no paths/keys). */
export interface SttStatus {
  privacyMode: 'standard' | 'local';
  stt: {
    provider: 'local' | 'browser' | 'none' | 'remote';
    configured: boolean;
    local: boolean;
    engine?: string;
    available?: boolean;
    nodeAvailable?: boolean;
    model?: string;
    code?: string;
    ffmpeg?: boolean;
    localFilesOnly?: boolean;
    reason?: string;
  };
  translation: {
    provider: 'local' | 'llm' | 'none';
    configured: boolean;
    available?: boolean;
    engine?: string;
    model?: string;
    code?: string;
    localFilesOnly?: boolean;
    nonCommercial?: boolean;
    reason?: string;
  };
  consent: { required: boolean; retentionSec: number };
  caveats: string[];
}

export interface SiemEventConfig {
  enabled: boolean;
  url: string;
  format: 'json' | 'cef';
  /** Name of the server env var holding the secret; never the secret itself. */
  secretEnv: string;
  events: string[];
}

export interface SiemStatus {
  configured: boolean;
  enabled: boolean;
  format?: 'json' | 'cef';
  url?: string;
  secretEnv?: string;
  lastDelivery?: { at: number; ok: boolean; statusCode?: number; error?: string } | null;
  lastError?: string | null;
  detail?: string;
}

export interface SiemTestResult {
  ok: boolean;
  latencyMs?: number;
  statusCode?: number;
  error?: string;
  detail?: string;
}

export type EgressKind = 'recording' | 'rtmp' | 'hls';
export type EgressRestriction = 'feature_disabled' | 'e2ee_incompatible';

export interface EgressSession {
  id: string;
  kind: EgressKind;
  status: string;
  url?: string;
  startedAt?: number;
}

export interface EgressStatus {
  configured?: boolean;
  workerConfigured?: boolean;
  enabled?: boolean;
  sessions: EgressSession[];
  startRestrictions?: Record<EgressKind, EgressRestriction | null>;
  detail?: string;
}

export interface EgressPlaybackLink {
  egressId: string;
  kind: EgressKind;
  url: string;
  expiresAt: number;
  ttlSec: number;
}

export interface SipStatus {
  configured: boolean;
  enabled: boolean;
  trunkConfigured: boolean;
  nodeAvailable?: boolean;
  active: number;
}

export interface EgressWorkerStatus {
  configured: boolean;
  enabled?: boolean;
  startNodeAvailable?: boolean;
  urlConfigured?: boolean;
  activeCount?: number;
  lastError?: string | null;
  detail?: string;
  worker?: {
    urlConfigured: boolean;
    reachable: boolean | null;
    status: string | null;
    cpuLoad: number | null;
    detail?: string;
  };
  playback?: { enabled: boolean; backend: 'none' | 'local' | 's3' };
  checkedAt?: number;
}

const EGRESS_STATUS_BY_NUMBER: Record<number, string> = {
  0: 'EGRESS_STARTING',
  1: 'EGRESS_ACTIVE',
  2: 'EGRESS_ENDING',
  3: 'EGRESS_COMPLETE',
  4: 'EGRESS_FAILED',
  5: 'EGRESS_ABORTED',
  6: 'EGRESS_LIMIT_REACHED',
};

function firstRecord(value: unknown): Record<string, any> {
  return Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === 'object'
    ? (value[0] as Record<string, any>)
    : {};
}

function egressStatusName(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 'unknown';
    return /^\d+$/.test(trimmed) ? EGRESS_STATUS_BY_NUMBER[Number(trimmed)] ?? trimmed : trimmed;
  }
  if (typeof value === 'number') return EGRESS_STATUS_BY_NUMBER[value] ?? 'unknown';
  return 'unknown';
}

function egressKindOf(item: Record<string, any>): EgressKind {
  const request = item.request && typeof item.request === 'object' ? item.request : {};
  if (Array.isArray(request.stream_outputs) && request.stream_outputs.length > 0) return 'rtmp';
  if (Array.isArray(request.segment_outputs) && request.segment_outputs.length > 0) return 'hls';
  if (Array.isArray(request.file_outputs) && request.file_outputs.length > 0) return 'recording';
  if (Array.isArray(item.stream_results) && item.stream_results.length > 0) return 'rtmp';
  if (Array.isArray(item.segment_results) && item.segment_results.length > 0) return 'hls';
  if (item.kind === 'rtmp' || item.kind === 'hls') return item.kind;
  return 'recording';
}

/** LiveKit `started_at` is int64 nanoseconds (protojson emits a string). */
function egressStartedAtMs(value: unknown): number | undefined {
  const numeric = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const ms = Math.floor(numeric / 1e6);
  return ms > 0 ? ms : undefined;
}

/**
 * Normalizes `GET /v1/rooms/:id/egress`.
 *
 * The server returns `{ roomId, egress: EgressInfo[] }` with raw LiveKit
 * proto-JSON (`egress_id`, `status: "EGRESS_ACTIVE"`, `started_at` in ns,
 * `stream_results`/`file_results`/`segment_results`). Older/alternate shapes
 * (`sessions`/`active`) are accepted defensively, but the raw shape is the
 * contract. Keeping this pure makes the mapping unit-testable.
 */
export function normalizeEgressStatus(data: unknown): EgressStatus {
  const raw = (data ?? {}) as Record<string, any>;
  const items: unknown[] = Array.isArray(raw.egress)
    ? raw.egress
    : Array.isArray(raw.sessions)
      ? raw.sessions
      : Array.isArray(raw.active)
        ? raw.active
        : [];
  const sessions: EgressSession[] = [];
  for (const value of items) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, any>;
    const id = String(item.egress_id ?? item.egressId ?? item.id ?? '').trim();
    if (!id) continue;
    const stream = firstRecord(item.stream_results).url;
    const segment = firstRecord(item.segment_results);
    const file = firstRecord(item.file_results).location;
    const candidates = [stream, segment.playlist_location, segment.live_playlist_location, file];
    const url = candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
    sessions.push({
      id,
      kind: egressKindOf(item),
      status: egressStatusName(item.status),
      ...(url ? { url } : {}),
      ...(egressStartedAtMs(item.started_at) !== undefined ? { startedAt: egressStartedAtMs(item.started_at) } : {}),
    });
  }
  const restrictions = raw.startRestrictions;
  const isRestriction = (value: unknown): value is EgressRestriction | null =>
    value === null || value === 'feature_disabled' || value === 'e2ee_incompatible';
  const startRestrictions = restrictions && isRestriction(restrictions.recording) &&
    isRestriction(restrictions.rtmp) && isRestriction(restrictions.hls)
    ? { recording: restrictions.recording, rtmp: restrictions.rtmp, hls: restrictions.hls }
    : undefined;
  return {
    configured: typeof raw.configured === 'boolean' ? raw.configured : undefined,
    workerConfigured: typeof raw.workerConfigured === 'boolean' ? raw.workerConfigured : undefined,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    sessions,
    ...(startRestrictions ? { startRestrictions } : {}),
    detail: typeof raw.detail === 'string' ? raw.detail : undefined,
  };
}

/**
 * TURN probe result (`POST /v1/admin/scale/turn/test`). The server contract
 * does not pin the shape beyond availability, so the client normalizes it.
 */
export interface TurnTestResponse {
  id: string;
  ok: boolean;
  detail?: string;
  latencyMs?: number;
}

/** API error with the server-provided code/message and an offline marker. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, code = 'internal_error', status = 0, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** True when the server could not be reached at all (or timed out). */
  get offline(): boolean {
    return this.code === 'offline' || this.code === 'timeout' || (this.status === 0 && this.code !== 'unauthorized');
  }

  get unauthorized(): boolean {
    return this.code === 'unauthorized' || this.status === 401;
  }
}

/** Adds a scheme when missing and strips trailing slashes (path prefixes survive). */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return currentOrigin();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
  } catch {
    return withScheme.replace(/\/+$/, '');
  }
}

export class AdminApi {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly sessionToken: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AdminApiOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? currentOrigin());
    this.apiKey = options.apiKey ?? DEFAULT_API_KEY;
    this.sessionToken = options.sessionToken?.trim() ?? '';
    this.timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** True when requests are authenticated with an SSO admin session. */
  get usesSession(): boolean {
    return this.sessionToken.length > 0;
  }

  withCredentials(baseUrl: string, apiKey: string): AdminApi {
    return new AdminApi({ baseUrl, apiKey, timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl });
  }

  withSession(baseUrl: string, sessionToken: string): AdminApi {
    return new AdminApi({ baseUrl, sessionToken, timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl });
  }

  /** Resolves a (possibly relative) URL returned by the API against the server base. */
  resolveUrl(url: string): string {
    if (!url) return this.baseUrl;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
    return `${this.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    let url = `${this.baseUrl}${path}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue;
      params.set(key, String(value));
    }
    const serialized = params.toString();
    if (!serialized) return url;
    url += (url.includes('?') ? '&' : '?') + serialized;
    return url;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    if (options.auth !== false) {
      // The SSO session wins: it is short-lived and scoped to one tenant.
      if (this.sessionToken) headers.authorization = `Bearer ${this.sessionToken}`;
      else headers['x-api-key'] = this.apiKey;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiError(`Сервер не ответил за ${Math.round(timeoutMs / 1000)} с.`, 'timeout', 0);
      }
      throw new ApiError('Не удалось подключиться к серверу AgilFrame.', 'offline', 0, error);
    } finally {
      window.clearTimeout(timer);
    }

    if (response.status === 204) return undefined as T;

    const raw = await response.text();
    let parsed: unknown;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const body = parsed as ApiErrorBody | undefined;
      const code = body?.error?.code ?? `http_${response.status}`;
      const message = body?.error?.message ?? `Ошибка HTTP ${response.status}`;
      // The mascot panel listens for safe operational warnings (no payloads/secrets).
      if (response.status === 429 || response.status === 401) {
        window.dispatchEvent(
          new CustomEvent('agil-api-warning', {
            detail: { status: response.status, code },
          }),
        );
      }
      throw new ApiError(message, code, response.status, body?.error?.details);
    }

    if (parsed === undefined) {
      throw new ApiError('Сервер вернул некорректный JSON.', 'invalid_response', response.status);
    }
    return parsed as T;
  }

  /* ------------------------------------------------------------------ */
  /* Overview / rooms                                                    */
  /* ------------------------------------------------------------------ */

  async overview(): Promise<AdminOverview> {
    return this.request<AdminOverview>(adminPaths.overview);
  }

  async rooms(): Promise<AdminRoomSummary[]> {
    const data = await this.request<{ rooms: AdminRoomSummary[] }>(adminPaths.rooms);
    return data.rooms;
  }

  async createRoom(request: CreateRoomRequest): Promise<CreateRoomResponse> {
    return this.request<CreateRoomResponse>(adminPaths.rooms, { method: 'POST', body: request });
  }

  async room(roomId: string): Promise<RoomDetail> {
    return this.request<RoomDetail>(adminPaths.room(encodeURIComponent(roomId)));
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.request<{ closed: boolean }>(adminPaths.room(encodeURIComponent(roomId)), { method: 'DELETE' });
  }

  async createInvite(
    roomId: string,
    request: { ttlSec?: number; role?: 'host' | 'moderator' | 'guest' } = {},
  ): Promise<InviteLink> {
    return this.request<InviteLink>(adminPaths.roomInvites(encodeURIComponent(roomId)), {
      method: 'POST',
      body: request,
    });
  }

  async setRoomLocked(roomId: string, locked: boolean): Promise<boolean> {
    const data = await this.request<{ locked: boolean }>(adminPaths.roomLock(encodeURIComponent(roomId)), {
      method: 'POST',
      body: { locked },
    });
    return data.locked;
  }

  /** Sets/replaces a room password (server stores only a scrypt hash). */
  async setRoomPassword(roomId: string, password: string): Promise<{ passwordProtected: boolean }> {
    return this.request<{ passwordProtected: boolean }>(`/v1/admin/rooms/${encodeURIComponent(roomId)}/password`, {
      method: 'POST',
      body: { password },
    });
  }

  async kickParticipant(roomId: string, participantId: string): Promise<void> {
    await this.request<{ kicked: boolean }>(adminPaths.roomKick(encodeURIComponent(roomId)), {
      method: 'POST',
      body: { participantId },
    });
  }

  /**
   * Posts a chat message as the company system/bot (§22.1) — works without a
   * WebSocket and with an external chat UI. `id` makes the call idempotent.
   */
  async postRoomChat(roomId: string, request: ChatPostRequest): Promise<ChatPostResponse> {
    return this.request<ChatPostResponse>(adminPaths.roomChat(encodeURIComponent(roomId)), {
      method: 'POST',
      body: request,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Transcript / analysis / recordings                                  */
  /* ------------------------------------------------------------------ */

  async transcript(roomId: string): Promise<TranscriptResponse> {
    return this.request<TranscriptResponse>(adminPaths.roomTranscript(encodeURIComponent(roomId)));
  }

  async analysis(roomId: string): Promise<AnalysisResponse> {
    return this.request<AnalysisResponse>(adminPaths.roomAnalysis(encodeURIComponent(roomId)));
  }

  async conversationReview(roomId: string, policy?: ConversationReviewPolicy): Promise<ConversationReviewReport> {
    const path = adminPaths.roomConversationReview(encodeURIComponent(roomId));
    return this.request<ConversationReviewReport>(path, policy ? { method: 'PUT', body: policy } : {});
  }

  async runAnalysis(roomId: string): Promise<AnalysisResponse> {
    return this.request<AnalysisResponse>(adminPaths.roomAnalysisRun(encodeURIComponent(roomId)), {
      method: 'POST',
      body: {},
      timeoutMs: 30_000,
    });
  }

  async recordings(roomId?: string): Promise<RecordingRecord[]> {
    const data = await this.request<{ recordings: RecordingRecord[] }>(adminPaths.recordings, {
      query: { roomId },
    });
    return data.recordings;
  }

  async deleteRecording(id: string): Promise<void> {
    await this.request<{ deleted: boolean }>(`${adminPaths.recordings}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  /* ------------------------------------------------------------------ */
  /* Security / audit / AI agent                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Paginated audit log (`AuditListResponse`): entries + total + offset/limit.
   * Normalized defensively so an older server that returns `{entries}` only
   * still yields stable pagination.
   */
  async audit(query: AuditQuery = {}): Promise<AuditListResponse> {
    const data = await this.request<Partial<AuditListResponse> & { entries?: AuditEntry[] }>(adminPaths.audit, {
      query: {
        limit: query.limit,
        offset: query.offset,
        anchorId: query.anchorId,
        type: query.type,
        types: query.types,
        severity: query.severity,
        roomId: query.roomId,
        q: query.q,
      },
    });
    const entries = Array.isArray(data.entries) ? data.entries : [];
    return {
      entries,
      total: typeof data.total === 'number' ? data.total : entries.length,
      offset: typeof data.offset === 'number' ? data.offset : (query.offset ?? 0),
      limit: typeof data.limit === 'number' ? data.limit : (query.limit ?? entries.length),
      ...(typeof data.anchorId === 'string' && data.anchorId ? { anchorId: data.anchorId } : {}),
    };
  }

  async security(): Promise<SecurityOverview> {
    return this.request<SecurityOverview>(adminPaths.security);
  }

  async aiAgentSettings(): Promise<AiAgentSettingsResponse> {
    return this.request<AiAgentSettingsResponse>(adminPaths.aiAgent);
  }

  async updateAiAgent(config: Partial<AiAgentConfig>): Promise<AiAgentSettingsResponse> {
    return this.request<AiAgentSettingsResponse>(adminPaths.aiAgent, { method: 'PUT', body: { config } });
  }

  /* ------------------------------------------------------------------ */
  /* Access policy / knowledge agent / webhooks (contract §18-§19)       */
  /* ------------------------------------------------------------------ */

  async accessPolicy(): Promise<AccessPolicyResponse> {
    return this.request<AccessPolicyResponse>(adminPaths.accessPolicy);
  }

  async updateAccessPolicy(
    policy: AccessPolicyPatch,
    clearUserOverrides: string[] = [],
    expectedPolicy?: AccessPolicyExpected,
  ): Promise<AccessPolicyResponse> {
    return this.request<AccessPolicyResponse>(adminPaths.accessPolicy, {
      method: 'PUT',
      body: { policy, clearUserOverrides, expectedPolicy },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Dashboard mascot assistant + critical-change guard                  */
  /* ------------------------------------------------------------------ */

  async assistant(request: DashboardAssistantRequest): Promise<DashboardAssistantResponse> {
    return this.request<DashboardAssistantResponse>(adminPaths.assistant, {
      method: 'POST',
      body: request,
      timeoutMs: 25_000,
    });
  }

  async assistantPrompts(): Promise<AssistantPromptInfo[]> {
    const data = await this.request<{ prompts?: AssistantPromptInfo[] } | AssistantPromptInfo[]>(adminPaths.assistantPrompts);
    return Array.isArray(data) ? data : (data.prompts ?? []);
  }

  async guardAssess(request: GuardAssessRequest): Promise<GuardAssessResponse> {
    return this.request<GuardAssessResponse>(adminPaths.guardAssess, {
      method: 'POST',
      body: request,
      timeoutMs: 15_000,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Documentation: list / read / write / versions / default             */
  /* ------------------------------------------------------------------ */

  async docs(): Promise<DocsListResponse> {
    return this.request<DocsListResponse>(adminPaths.docs);
  }

  async doc(name: string): Promise<DocContentResponse> {
    return this.request<DocContentResponse>(adminPaths.doc(name));
  }

  async saveDoc(name: string, request: DocWriteRequest): Promise<DocContentResponse> {
    return this.request<DocContentResponse>(adminPaths.doc(name), { method: 'PUT', body: request });
  }

  async uploadDoc(name: string, request: DocWriteRequest): Promise<DocContentResponse> {
    return this.request<DocContentResponse>(adminPaths.docUpload, { method: 'POST', body: { ...request, name } });
  }

  async deleteDoc(name: string, request: DocRevisionRequest): Promise<{ name: string; reset: boolean; bundled: boolean; custom: false }> {
    return this.request(adminPaths.doc(name), { method: 'DELETE', body: request });
  }

  async docVersions(name: string): Promise<DocHistoryResponse> {
    return this.request<DocHistoryResponse>(adminPaths.docVersions(name));
  }

  async docVersion(name: string, versionId: string): Promise<{ content: string; title?: string; version?: DocVersion }> {
    return this.request<{ content: string; title?: string; version?: DocVersion }>(adminPaths.docVersion(name, versionId));
  }

  async restoreDoc(name: string, versionId: string, request: DocRevisionRequest): Promise<DocContentResponse> {
    return this.request<DocContentResponse>(adminPaths.docRestore(name, versionId), { method: 'POST', body: request });
  }

  async setDefaultDoc(name: string): Promise<{ defaultName: string }> {
    const body: DocDefaultRequest = { name };
    return this.request<{ defaultName: string }>(adminPaths.docDefault, { method: 'PUT', body });
  }

  /* ------------------------------------------------------------------ */
  /* SaaS organizations (platform key only)                              */
  /* ------------------------------------------------------------------ */

  async tenants(): Promise<TenantsResponse> {
    return this.request<TenantsResponse>(adminPaths.tenants);
  }

  async createTenant(
    request: TenantCreateRequest & { features?: Record<string, boolean> },
  ): Promise<TenantCreatedResponse> {
    return this.request<TenantCreatedResponse>(adminPaths.tenants, {
      method: 'POST',
      body: request,
      timeoutMs: 30_000,
    });
  }

  async rotateTenantKey(tenantId: string): Promise<TenantKeyResponse> {
    return this.request<TenantKeyResponse>(adminPaths.tenantKeys(tenantId), {
      method: 'POST',
      body: {},
    });
  }

  async deleteTenant(tenantId: string): Promise<{ deleted: boolean; tenantId: string }> {
    return this.request<{ deleted: boolean; tenantId: string }>(adminPaths.tenant(tenantId), {
      method: 'DELETE',
    });
  }

  /** Platform-side config patch; backend may not expose it yet. */
  async patchTenantConfig(tenantId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(adminPaths.tenant(tenantId), {
      method: 'PATCH',
      body: patch,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Roles: built-in + company-defined (§18)                            */
  /* ------------------------------------------------------------------ */

  async roles(): Promise<RoleDefinition[]> {
    const data = await this.request<RolesResponse | RoleDefinition[]>(adminPaths.roles);
    return Array.isArray(data) ? data : data.roles;
  }

  async createRole(role: RoleWriteRequest): Promise<void> {
    await this.request<RoleDefinition | RolesResponse>(adminPaths.roles, {
      method: 'POST',
      body: role,
    });
  }

  async updateRole(roleId: string, role: RoleWriteRequest): Promise<void> {
    await this.request<RoleDefinition | RolesResponse>(adminPaths.role(encodeURIComponent(roleId)), {
      method: 'PUT',
      body: role,
    });
  }

  async deleteRole(roleId: string): Promise<{ deleted: boolean; affectedParticipants?: number }> {
    const data = await this.request<{ deleted?: boolean; affectedParticipants?: number }>(
      adminPaths.role(encodeURIComponent(roleId)),
      { method: 'DELETE' },
    );
    return { deleted: data.deleted ?? true, affectedParticipants: data.affectedParticipants };
  }

  async knowledgeAgentSettings(): Promise<KnowledgeAgentSettingsResponse> {
    return this.request<KnowledgeAgentSettingsResponse>(adminPaths.knowledgeAgent);
  }  async updateKnowledgeAgent(
    config: Partial<TenantConfig['session']['knowledgeAgent']>,
  ): Promise<KnowledgeAgentSettingsResponse> {
    return this.request<KnowledgeAgentSettingsResponse>(adminPaths.knowledgeAgent, {
      method: 'PUT',
      body: { config },
    });
  }

  async askKnowledge(request: KnowledgeAskRequest): Promise<KnowledgeAskResponse> {
    return this.request<KnowledgeAskResponse>(adminPaths.knowledgeAsk, {
      method: 'POST',
      body: request,
      timeoutMs: 30_000,
    });
  }

  async webhooks(): Promise<WebhooksResponse> {
    return this.request<WebhooksResponse>(adminPaths.webhooks);
  }

  /* ------------------------------------------------------------------ */
  /* Capability providers (§23)                                          */
  /* ------------------------------------------------------------------ */

  async providers(): Promise<ProvidersResponse> {
    return this.request<ProvidersResponse>(adminPaths.providers);
  }

  async updateProviders(
    providers: Partial<TenantConfig['providers']>,
  ): Promise<ProvidersResponse> {
    return this.request<ProvidersResponse>(adminPaths.providers, {
      method: 'PUT',
      body: { providers },
    });
  }

  async testProvider(slot: ProviderSlotName, payload?: Record<string, unknown>): Promise<ProviderTestResponse> {
    const request: ProviderTestRequest = { slot };
    if (payload) request.payload = payload;
    return this.request<ProviderTestResponse>(adminPaths.providersTest, {
      method: 'POST',
      body: request,
      timeoutMs: 30_000,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Scale-out: media mode, cluster, TURN pool, SFU, webinar (§24)       */
  /* ------------------------------------------------------------------ */

  async scale(): Promise<ScaleStatusResponse> {
    return this.request<ScaleStatusResponse>(adminPaths.scale);
  }

  async updateScale(scale: Partial<ScaleConfig>): Promise<ScaleStatusResponse> {
    return this.request<ScaleStatusResponse>(adminPaths.scale, {
      method: 'PUT',
      body: { scale },
    });
  }

  async clusterStatus(): Promise<ClusterStatusResponse> {
    return this.request<ClusterStatusResponse>(adminPaths.clusterStatus);
  }

  /* ------------------------------------------------------------------ */
  /* Cluster enrollment tokens + node registry (docs/api/cluster.md)      */
  /* ------------------------------------------------------------------ */

  async clusterTokens(): Promise<EnrollmentTokenSummary[]> {
    const data = await this.request<{ tokens?: EnrollmentTokenSummary[] }>(adminPaths.clusterTokens);
    return Array.isArray(data.tokens) ? data.tokens : [];
  }

  /** Issues a one-time enrollment token; the plaintext is returned exactly once. */
  async createClusterToken(request: EnrollmentTokenCreateRequest): Promise<EnrollmentTokenCreatedResponse> {
    return this.request<EnrollmentTokenCreatedResponse>(adminPaths.clusterTokens, {
      method: 'POST',
      body: request,
    });
  }

  async revokeClusterToken(tokenId: string): Promise<EnrollmentTokenRevokeResponse> {
    return this.request<EnrollmentTokenRevokeResponse>(adminPaths.clusterToken(tokenId), {
      method: 'DELETE',
    });
  }

  async nodes(query: { role?: string; status?: string } = {}): Promise<NodeSummary[]> {
    const data = await this.request<{ nodes?: NodeSummary[] }>(adminPaths.nodes, { query });
    return Array.isArray(data.nodes) ? data.nodes : [];
  }

  async updateNode(nodeId: string, patch: NodeUpdateRequest): Promise<NodeSummary> {
    const data = await this.request<{ node: NodeSummary }>(adminPaths.node(nodeId), {
      method: 'PATCH',
      body: patch,
    });
    return data.node;
  }

  async disableNode(nodeId: string, disabled = true): Promise<NodeSummary> {
    const data = await this.request<{ node: NodeSummary }>(adminPaths.nodeDisable(nodeId), {
      method: 'POST',
      body: { disabled },
    });
    return data.node;
  }

  async drainNode(nodeId: string, drain = true): Promise<NodeSummary> {
    const data = await this.request<{ node: NodeSummary }>(adminPaths.nodeDrain(nodeId), {
      method: 'POST',
      body: { drain },
    });
    return data.node;
  }

  async deleteNode(nodeId: string): Promise<void> {
    await this.request<{ deleted: boolean }>(adminPaths.node(nodeId), { method: 'DELETE' });
  }

  /* ------------------------------------------------------------------ */
  /* Per-node modules (Docker add-on packages, docs/api/cluster.md §10)   */
  /* ------------------------------------------------------------------ */

  /** Core allowlist: labels, catalog images, ports and env **hints** only. */
  async nodeModuleCatalog(): Promise<NodeModuleCatalogResponse> {
    const data = await this.request<Partial<NodeModuleCatalogResponse>>(nodeModulesPaths.catalog);
    return {
      catalog: Array.isArray(data.catalog) ? data.catalog : [],
      actions: Array.isArray(data.actions) ? data.actions : [],
    };
  }

  /** Last reported inventory of one node plus its active commands. */
  async nodeModules(nodeId: string): Promise<NodeModulesResponse> {
    const data = await this.request<Partial<NodeModulesResponse>>(nodeModulesPaths.nodeModules(nodeId));
    return {
      nodeId: typeof data.nodeId === 'string' ? data.nodeId : nodeId,
      modules: Array.isArray(data.modules) ? data.modules : [],
      moduleTemplates: nodeCustomModuleTemplatesSchema.safeParse(data.moduleTemplates).data,
      logWindows: nodeModuleLogWindowsSchema.safeParse(data.logWindows).data,
      moduleAvailability: nodeModuleAvailabilitySchema.safeParse(data.moduleAvailability).data,
      inventoryStale: typeof data.inventoryStale === 'boolean' ? data.inventoryStale : undefined,
      pendingCommands: Array.isArray(data.pendingCommands) ? data.pendingCommands : [],
      inFlightCommands: Array.isArray(data.inFlightCommands) ? data.inFlightCommands : [],
      failures: Array.isArray(data.failures) ? data.failures : [],
    };
  }

  /**
   * Queues one approved node action. A custom install confirms the current
   * digest; a custom lifecycle action confirms the current container ID.
   */
  async queueNodeModuleAction(
    nodeId: string,
    moduleId: string,
    action: NodeModuleAction,
    targetContainerId?: string,
    expectedImage?: string,
  ): Promise<NodeModuleCommand> {
    const data = await this.request<{ command?: NodeModuleCommand }>(
      nodeModulesPaths.moduleActions(nodeId, moduleId),
      { method: 'POST', body: { action, targetContainerId, expectedImage } },
    );
    if (!data || !data.command || typeof data.command !== 'object') {
      throw new ApiError('Сервер не вернул команду модуля.', 'invalid_response', 201);
    }
    return data.command;
  }

  async testTurnServer(id: string): Promise<TurnTestResponse> {
    const data = await this.request<Partial<TurnTestResponse> & { ok?: boolean; id?: string }>(
      adminPaths.turnTest,
      {
        method: 'POST',
        body: { id },
        timeoutMs: 30_000,
      },
    );
    return {
      id: data.id ?? id,
      ok: data.ok === true,
      detail: data.detail,
      latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : undefined,
    };
  }

  async updateWebhooks(webhooks: WebhookEndpointConfig[]): Promise<WebhooksResponse> {
    return this.request<WebhooksResponse>(adminPaths.webhooks, {
      method: 'PUT',
      body: { webhooks },
    });
  }

  async testWebhook(endpointId: string): Promise<WebhookTestResponse> {
    return this.request<WebhookTestResponse>(adminPaths.webhooksTest, {
      method: 'POST',
      body: { endpointId },
      timeoutMs: 30_000,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Tenant config (PATCH requires the tenant's own key)                 */
  /* ------------------------------------------------------------------ */

  async getConfig(tenantId: string): Promise<TenantConfig> {
    const path = publicPaths.roomConfig(encodeURIComponent(tenantId));
    const data = await this.request<ConfigEnvelope>(path, { auth: false });
    return data.config;
  }

  async patchConfig(tenantId: string, patch: TenantConfigPatch): Promise<TenantConfig> {
    const path = publicPaths.roomConfig(encodeURIComponent(tenantId));
    const data = await this.request<ConfigEnvelope>(path, { method: 'PATCH', body: patch });
    return data.config;
  }

  async restoreConfig(config: TenantConfig): Promise<TenantConfig> {
    const path = publicPaths.roomConfig(encodeURIComponent(config.tenantId));
    const { customDomain: _customDomain, ...branding } = config.branding;
    const data = await this.request<ConfigEnvelope>(path, { method: 'PATCH', body: { editorDraft: { ...config, branding } } });
    return data.config;
  }

  async mediaProcessing(): Promise<MediaProcessingStatus> {
    return this.request<MediaProcessingStatus>('/v1/admin/media/processing');
  }

  /** GET /v1/admin/stt — local STT/translation readiness (docs/stt-translation-local.md). */
  async sttStatus(): Promise<SttStatus> {
    return this.request<SttStatus>('/v1/admin/stt');
  }

  /** GET /scim/v2/ServiceProviderConfig — token is used once, never stored. */
  async checkScim(token: string, tenantId: string): Promise<{ ok: boolean; status: number; body: unknown }> {
    const response = await this.fetchImpl(`${this.baseUrl}/scim/v2/ServiceProviderConfig`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-tenant-id': tenantId,
      },
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  }

  async siemStatus(): Promise<SiemStatus> {
    return this.request<SiemStatus>('/v1/admin/siem/status');
  }

  async siemTest(): Promise<SiemTestResult> {
    return this.request<SiemTestResult>('/v1/admin/siem/test', { method: 'POST', body: {} });
  }

  async egress(roomId: string): Promise<EgressStatus> {
    const data = await this.request<unknown>(`/v1/rooms/${encodeURIComponent(roomId)}/egress`);
    return normalizeEgressStatus(data);
  }

  async startEgress(roomId: string, body: { kind: EgressKind; rtmpUrl?: string }, idempotencyKey?: string): Promise<unknown> {
    return this.request<unknown>(`/v1/rooms/${encodeURIComponent(roomId)}/egress/start`, { method: 'POST', body, idempotencyKey });
  }

  /**
   * `POST /v1/rooms/:roomId/egress/:egressId/stop` (no body: the server reads
   * the path parameter). Refuses an empty id instead of calling a route that
   * would 404 or stop an unrelated job.
   */
  async stopEgress(roomId: string, sessionId: string): Promise<unknown> {
    const id = sessionId.trim();
    if (!id) throw new ApiError('Не указан идентификатор egress-сессии.', 'validation_failed', 400);
    return this.request<unknown>(
      `/v1/rooms/${encodeURIComponent(roomId)}/egress/${encodeURIComponent(id)}/stop`,
      { method: 'POST' },
    );
  }

  /** Signs a short-lived, same-origin HLS/MP4 playback link for one session. */
  async egressPlayback(roomId: string, sessionId: string, ttlSec?: number): Promise<EgressPlaybackLink> {
    const id = sessionId.trim();
    if (!id) throw new ApiError('Не указан идентификатор egress-сессии.', 'validation_failed', 400);
    return this.request<EgressPlaybackLink>(
      `/v1/rooms/${encodeURIComponent(roomId)}/egress/${encodeURIComponent(id)}/playback`,
      { method: 'POST', body: ttlSec ? { ttlSec } : {} },
    );
  }

  async egressWorkerStatus(): Promise<EgressWorkerStatus> {
    return this.request<EgressWorkerStatus>('/v1/admin/egress/status');
  }

  async sipStatus(): Promise<SipStatus> {
    return this.request<SipStatus>('/v1/admin/sip/status');
  }

  async egressWorkersHealth(): Promise<EgressWorkerStatus> {
    return this.request<EgressWorkerStatus>('/v1/admin/egress/workers');
  }

  /* ------------------------------------------------------------------ */
  /* Room polls / Q&A                                                   */
  /* ------------------------------------------------------------------ */

  async polls(roomId: string): Promise<PollListResponse> {
    return this.request<PollListResponse>(publicPaths.roomPolls(encodeURIComponent(roomId)));
  }

  async createPoll(
    roomId: string,
    body: { question: string; options: Array<{ text: string }>; multiple: boolean; anonymous: boolean; kind: 'poll' | 'qna' },
  ): Promise<RoomPoll> {
    const data = await this.request<RoomPoll | { poll: RoomPoll }>(publicPaths.roomPolls(encodeURIComponent(roomId)), {
      method: 'POST',
      body,
    });
    return 'poll' in data ? data.poll : data;
  }

  async closePoll(roomId: string, pollId: string): Promise<RoomPoll> {
    const data = await this.request<RoomPoll | { poll: RoomPoll }>(publicPaths.roomPollClose(encodeURIComponent(roomId), encodeURIComponent(pollId)), {
      method: 'POST',
      body: {},
    });
    return 'poll' in data ? data.poll : data;
  }

  /* ------------------------------------------------------------------ */
  /* Lobby (waiting room)                                               */
  /* ------------------------------------------------------------------ */

  async lobby(roomId: string): Promise<LobbyRequestsResponse> {
    return this.request<LobbyRequestsResponse>(publicPaths.roomLobby(encodeURIComponent(roomId)));
  }

  async admitLobby(roomId: string, requestId: string): Promise<LobbyDecisionResponse> {
    return this.request<LobbyDecisionResponse>(publicPaths.roomLobbyAdmit(encodeURIComponent(roomId), encodeURIComponent(requestId)), {
      method: 'POST',
      body: {},
    });
  }

  async rejectLobby(roomId: string, requestId: string): Promise<LobbyDecisionResponse> {
    return this.request<LobbyDecisionResponse>(publicPaths.roomLobbyReject(encodeURIComponent(roomId), encodeURIComponent(requestId)), {
      method: 'POST',
      body: {},
    });
  }

  async putConfig(tenantId: string, config: TenantConfig): Promise<TenantConfig> {
    const path = publicPaths.roomConfig(encodeURIComponent(tenantId));
    const data = await this.request<ConfigEnvelope>(path, { method: 'PUT', body: config });
    return data.config;
  }

  /* ------------------------------------------------------------------ */
  /* Public endpoints + tokens                                           */
  /* ------------------------------------------------------------------ */

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>(publicPaths.health, { auth: false, timeoutMs: 4000 });
  }

  /**
   * `GET /v1/auth/oidc/start` — creates state+nonce+PKCE server-side and returns
   * the IdP authorization URL. Public endpoint (no API key, no session token).
   */
  async oidcStart(tenantId: string, returnTo: string): Promise<OidcStartResponse> {
    return this.request<OidcStartResponse>('/v1/auth/oidc/start', {
      auth: false,
      query: { tenantId, returnTo },
      timeoutMs: 15_000,
    });
  }

  /**
   * `POST /v1/auth/oidc/logout` — revokes the current SSO admin session's jti
   * server-side (204). Bearer-only, so it is not CSRF-able; failures are
   * ignored by callers because local logout still clears the token.
   */
  async oidcLogout(): Promise<void> {
    return this.request<void>('/v1/auth/oidc/logout', { method: 'POST', timeoutMs: 5000 });
  }

  /**
   * `GET /v1/auth/oidc/logout` — builds the IdP RP-initiated logout URL
   * (`end_session_endpoint` + `post_logout_redirect_uri` + `state`) when the
   * tenant configured it. Public endpoint (no API key/session needed); 501
   * `identity_not_configured` means RP logout is not configured, and the
   * dashboard falls back to local-only logout.
   */
  async oidcLogoutStart(tenantId: string, returnTo: string): Promise<OidcLogoutResponse> {
    return this.request<OidcLogoutResponse>('/v1/auth/oidc/logout', {
      auth: false,
      query: { tenantId, returnTo },
      timeoutMs: 5000,
    });
  }

  async ice(): Promise<IceResponse> {
    return this.request<IceResponse>(publicPaths.ice, { auth: false });
  }

  /**
   * Creates a join token via POST /v1/tokens (§4/§18). The response includes
   * the effective `permissions` pinned by the issuer.
   */
  async createToken(request: CreateTokenRequest): Promise<TokenResponse> {
    return this.request<TokenResponse>(publicPaths.tokens, { method: 'POST', body: request });
  }
}
import type { ConversationReviewPolicy, ConversationReviewReport } from '@agil/protocol';
