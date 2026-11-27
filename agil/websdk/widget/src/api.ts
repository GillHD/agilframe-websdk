/**
 * REST client for the public participant API (contract §4, §14).
 *
 * All failures are normalized to `ApiError` with the server error code so the
 * UI can show a human-readable message (password_invalid, geo_blocked, ...).
 */
import type {
  BackgroundsResponse,
  BreakoutListResponse,
  BreakoutPlan,
  BreakoutPlanResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  FileRecord,
  HealthResponse,
  JoinRoomResponse,
  LobbyDecisionResponse,
  LobbyJoinResponse,
  LobbyRequestsResponse,
  LobbyStatusResponse,
  RecordingRecord,
  SttResponse,
  TenantConfig,
  TranscriptResponse,
  LivenessChallengeResponse,
  LivenessSignals,
  LivenessVerifyResponse,
} from '@agil/protocol';
import { publicPaths } from '@agil/protocol';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 0, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function defaultServerUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return 'http://localhost:8787';
}

export function normalizeBaseUrl(url: string | undefined): string {
  const base = (url && url.trim()) || defaultServerUrl();
  return base.replace(/\/+$/, '');
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Bearer token from join; attached to file/recording/stt calls. */
  token?: string;
  timeoutMs?: number;
}

/** Body of `POST /v1/rooms/:id/breakouts/start` (protocol `createBreakoutSchema`). */
export interface StartBreakoutInput {
  mode?: 'random' | 'manual';
  count?: number;
  rooms?: Array<{ name?: string; participantIds?: string[] }>;
  durationMin?: number;
  allowReturn?: boolean;
}

/** The deployed server answers with the plan itself; older/other builds wrap it. */
function unwrapBreakoutPlan(payload: BreakoutPlanResponse | BreakoutPlan): BreakoutPlan {
  if (payload && typeof payload === 'object' && 'plan' in payload) return payload.plan;
  return payload;
}

/**
 * 404/405/501 on the breakout endpoints means the feature is not deployed
 * (old server) or the room is gone — the UI must show a friendly fallback
 * instead of a generic error.
 */
export function isBreakoutFeatureUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 404 || error.status === 405 || error.status === 501;
}

/** `POST /join` either mints a token or parks the guest in the waiting room. */
export type JoinRoomResult = JoinRoomResponse | LobbyJoinResponse;

export function isLobbyJoinResponse(result: JoinRoomResult): result is LobbyJoinResponse {
  return 'pending' in result && result.pending === true;
}

async function parseError(response: Response): Promise<ApiError> {
  let code = `http_${response.status}`;
  let message = response.statusText || `HTTP ${response.status}`;
  let details: unknown;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    }
  } catch {
    // non-JSON error body (proxy / network layer)
  }
  return new ApiError(code, message, response.status, details);
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  token: string | undefined;

  constructor(options: ApiClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  get base(): string {
    return this.baseUrl;
  }

  resolve(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private async withAbort<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await work(controller.signal);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError('timeout', `Request timed out after ${this.timeoutMs} ms`, 0);
      }
      throw new ApiError('network_error', error instanceof Error ? error.message : 'network error', 0);
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await fetch(this.resolve(path), { ...init, headers });
    if (!response.ok) throw await parseError(response);
    return (await response.json()) as T;
  }

  async listPolls(roomId: string): Promise<unknown> {
    return this.requestJson('/v1/rooms/' + encodeURIComponent(roomId) + '/polls', { method: 'GET', headers: this.authHeaders() });
  }

  async createPoll(roomId: string, body: unknown): Promise<unknown> {
    return this.requestJson('/v1/rooms/' + encodeURIComponent(roomId) + '/polls', {
      method: 'POST',
      headers: this.authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
  }

  async votePoll(roomId: string, pollId: string, optionIds: string[]): Promise<unknown> {
    return this.requestJson('/v1/rooms/' + encodeURIComponent(roomId) + '/polls/' + encodeURIComponent(pollId) + '/vote', {
      method: 'POST',
      headers: this.authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ optionIds }),
    });
  }

  async closePoll(roomId: string, pollId: string): Promise<unknown> {
    return this.requestJson('/v1/rooms/' + encodeURIComponent(roomId) + '/polls/' + encodeURIComponent(pollId) + '/close', {
      method: 'POST',
      headers: this.authHeaders({ 'content-type': 'application/json' }),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Breakout rooms (host/moderator room Bearer)                        */
  /* ------------------------------------------------------------------ */

  /**
   * `GET /v1/rooms/:id/breakouts` — current plan for the room (host only).
   * A `token` override is used by the host while they are inside their own
   * sub-room: plan management always targets the *main* room with the main token.
   */
  async listBreakouts(roomId: string, token?: string): Promise<BreakoutListResponse> {
    return this.requestJson<BreakoutListResponse>(publicPaths.roomBreakouts(encodeURIComponent(roomId)), {
      method: 'GET',
      headers: this.authHeaders({}, token),
    });
  }

  /** `POST /v1/rooms/:id/breakouts/start` → the created plan. */
  async startBreakout(roomId: string, body: StartBreakoutInput, token?: string): Promise<BreakoutPlan> {
    const payload = await this.requestJson<BreakoutPlanResponse | BreakoutPlan>(
      publicPaths.roomBreakoutStart(encodeURIComponent(roomId)),
      {
        method: 'POST',
        headers: this.authHeaders({ 'content-type': 'application/json' }, token),
        body: JSON.stringify(body),
      },
    );
    return unwrapBreakoutPlan(payload);
  }

  /** `POST /v1/rooms/:id/breakouts/close` → the closed plan. */
  async closeBreakout(roomId: string, token?: string): Promise<BreakoutPlan> {
    const payload = await this.requestJson<BreakoutPlanResponse | BreakoutPlan>(
      publicPaths.roomBreakoutClose(encodeURIComponent(roomId)),
      {
        method: 'POST',
        headers: this.authHeaders({ 'content-type': 'application/json' }, token),
      },
    );
    return unwrapBreakoutPlan(payload);
  }

  /**
   * `POST /v1/rooms/:id/breakouts/return` — participant returns from their
   * sub-room. The call must carry the **main** room token, not the child token.
   * (`publicPaths` has no helper for this path yet, so it is derived from it.)
   */
  async returnFromBreakout(roomId: string, token?: string): Promise<{ returnToRoomId: string }> {
    return this.requestJson<{ returnToRoomId: string }>(
      `${publicPaths.roomBreakouts(encodeURIComponent(roomId))}/return`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'content-type': 'application/json' }, token),
        body: JSON.stringify({}),
      },
    );
  }

  /* ------------------------------------------------------------------ */
  /* Liveness (server-issued challenge; advisory only)                   */
  /* ------------------------------------------------------------------ */

  /**
   * `POST /v1/rooms/:id/liveness/challenge` — tenant policy must enable
   * `security.liveness`; 501 `liveness_not_configured` when the server has no
   * engine. The caller falls back to the local-only challenge on any failure.
   */
  async createLivenessChallenge(roomId: string): Promise<LivenessChallengeResponse> {
    return this.withAbort(async (signal) => {
      const response = await fetch(
        this.resolve(`/v1/rooms/${encodeURIComponent(roomId)}/liveness/challenge`),
        {
          method: 'POST',
          headers: this.authHeaders({ 'content-type': 'application/json' }),
          body: '{}',
          signal,
        },
      );
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as LivenessChallengeResponse;
    });
  }

  /**
   * `POST /v1/rooms/:id/liveness/:sessionId/verify` — sends only signals (never
   * frames). The server verdict is advisory; it is not certified deepfake
   * detection and must not be presented as such.
   */
  async verifyLiveness(
    roomId: string,
    sessionId: string,
    signals: LivenessSignals,
  ): Promise<LivenessVerifyResponse> {
    return this.withAbort(async (signal) => {
      const response = await fetch(
        this.resolve(
          `/v1/rooms/${encodeURIComponent(roomId)}/liveness/${encodeURIComponent(sessionId)}/verify`,
        ),
        {
          method: 'POST',
          headers: this.authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ signals }),
          signal,
        },
      );
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as LivenessVerifyResponse;
    });
  }

  async health(): Promise<HealthResponse> {
    return this.requestJson<HealthResponse>('/v1/health', { method: 'GET' });
  }

  async getConfig(tenantId: string): Promise<TenantConfig> {
    const body = await this.requestJson<{ config: TenantConfig; etag?: string }>(
      `/v1/tenants/${encodeURIComponent(tenantId)}/config`,
      { method: 'GET' },
    );
    return body.config;
  }

  /**
   * Virtual backgrounds library (`GET /v1/tenants/:id/backgrounds`, contract §23).
   * Returns the built-in list or the external provider list; no auth required.
   */
  async getBackgrounds(tenantId: string): Promise<BackgroundsResponse> {
    return this.requestJson<BackgroundsResponse>(`/v1/tenants/${encodeURIComponent(tenantId)}/backgrounds`, {
      method: 'GET',
    });
  }

  /**
   * `POST /v1/rooms/:id/join`.
   *
   * With `security.waitingRoom` the server answers **202** with
   * `LobbyJoinResponse` instead of minting a token. That is a normal outcome,
   * not an error: the caller shows the waiting screen and polls the lobby.
   */
  async joinRoom(
    roomId: string,
    body: { name?: string; password?: string; locale?: 'ru' | 'en'; participantId?: string; identityToken?: string },
  ): Promise<JoinRoomResult> {
    return this.withAbort(async (signal) => {
      const response = await fetch(this.resolve(publicPaths.join(roomId)), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (response.status === 202) {
        return (await response.json()) as LobbyJoinResponse;
      }
      if (!response.ok) throw await parseError(response);
      const parsed = (await response.json()) as JoinRoomResponse | { token?: unknown; participant?: unknown };
      if (typeof parsed?.token !== 'string' || !parsed.participant) {
        // Defensive: an unexpected 200 body must not crash the join screen.
        throw new ApiError('invalid_response', 'Join response is missing a token', response.status);
      }
      return parsed as JoinRoomResponse;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Waiting room (lobby)                                               */
  /* ------------------------------------------------------------------ */

  /** Public capability poll (`GET /v1/rooms/:id/lobby/:requestId`). */
  async getLobbyStatus(roomId: string, requestId: string): Promise<LobbyStatusResponse> {
    return this.requestJson<LobbyStatusResponse>(publicPaths.roomLobbyRequest(roomId, requestId), {
      method: 'GET',
    });
  }

  async withdrawLobbyRequest(roomId: string, requestId: string, cancelToken: string): Promise<void> {
    await this.requestJson(publicPaths.roomLobbyRequest(roomId, requestId) + '/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cancelToken }),
    });
  }

  /** Host/moderator queue (`GET /v1/rooms/:id/lobby`, room Bearer). */
  async listLobbyRequests(roomId: string): Promise<LobbyRequestsResponse> {
    return this.requestJson<LobbyRequestsResponse>(publicPaths.roomLobby(roomId), {
      method: 'GET',
      headers: this.authHeaders(),
    });
  }

  /**
   * Admit a waiting guest (`POST .../admit`).
   *
   * The deployed server answers with the admitted participant's
   * `JoinRoomResponse` (the token is for that guest — never render it).
   */
  async admitLobbyRequest(roomId: string, requestId: string): Promise<JoinRoomResponse> {
    return this.requestJson<JoinRoomResponse>(publicPaths.roomLobbyAdmit(roomId, requestId), {
      method: 'POST',
      headers: this.authHeaders({ 'content-type': 'application/json' }),
    });
  }

  /** Reject a waiting guest (`POST .../reject`). */
  async rejectLobbyRequest(roomId: string, requestId: string, reason?: string): Promise<LobbyDecisionResponse> {
    return this.requestJson<LobbyDecisionResponse>(publicPaths.roomLobbyReject(roomId, requestId), {
      method: 'POST',
      headers: this.authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(reason ? { reason } : {}),
    });
  }

  /**
   * Host-side removal from the queue (the server exposes `DELETE`).
   *
   * Guests use the separate withdrawal token issued when joining the lobby.
   */
  async cancelLobbyRequest(roomId: string, requestId: string): Promise<LobbyDecisionResponse> {
    return this.requestJson<LobbyDecisionResponse>(publicPaths.roomLobbyRequest(roomId, requestId), {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
  }

  async createRoom(body: CreateRoomRequest, apiKey?: string): Promise<CreateRoomResponse> {
    return this.withAbort((signal) => this.requestJson(apiKey ? '/v1/admin/rooms' : '/v1/rooms', {
      method: 'POST',
      headers: apiKey ? { 'x-api-key': apiKey } : undefined,
      body: JSON.stringify(body),
      redirect: apiKey ? 'error' : undefined,
      signal,
    }));
  }

  private authHeaders(extra: Record<string, string> = {}, token: string | undefined = this.token): Record<string, string> {
    return token ? { authorization: `Bearer ${token}`, ...extra } : extra;
  }

  /** Uploads a chat attachment as a raw body (`POST /v1/files`, §14). */
  async uploadFile(file: File): Promise<FileRecord> {
    return this.withAbort(async (signal) => {
      const response = await fetch(this.resolve('/v1/files'), {
        method: 'POST',
        headers: this.authHeaders({ 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }),
        body: file,
        signal,
      });
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as FileRecord;
    });
  }

  /** Uploads a finished recording as a raw body (`POST /v1/recordings`, §14). */
  async uploadRecording(
    blob: Blob,
    meta: { roomId: string; durationSec: number; mimeType: string },
  ): Promise<RecordingRecord> {
    return this.withAbort(async (signal) => {
      const response = await fetch(this.resolve('/v1/recordings'), {
        method: 'POST',
        headers: this.authHeaders({
          'content-type': blob.type || meta.mimeType,
          'x-recording-meta': JSON.stringify(meta),
        }),
        body: blob,
        signal,
      });
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as RecordingRecord;
    });
  }

  /**
   * Server-side STT (`POST /v1/stt/transcribe`, 501 when not configured).
   * `translateTo` asks the server for machine translation of every segment
   * (`x-translate-to` header; `none` = original language only).
   */
  async transcribe(blob: Blob, language: 'ru' | 'en', translateTo?: 'none' | 'ru' | 'en'): Promise<SttResponse> {
    return this.withAbort(async (signal) => {
      const response = await fetch(this.resolve('/v1/stt/transcribe'), {
        method: 'POST',
        headers: this.authHeaders({
          'content-type': blob.type || 'audio/webm',
          'x-language': language,
          ...(translateTo && translateTo !== 'none' ? { 'x-translate-to': translateTo } : {}),
        }),
        body: blob,
        signal,
      });
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as SttResponse;
    });
  }

  /** Stored transcript with timestamps + translations (`GET /v1/rooms/:roomId/transcript`). */
  async fetchTranscript(roomId: string, limit = 1000): Promise<TranscriptResponse> {
    return this.withAbort(async (signal) => {
      const response = await fetch(
        this.resolve(`/v1/rooms/${encodeURIComponent(roomId)}/transcript?limit=${Math.max(1, Math.min(5000, limit))}`),
        { headers: this.authHeaders(), signal },
      );
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as TranscriptResponse;
    });
  }

  /** Reads consent before the microphone is connected to speech recognition. */
  async getTranscriptConsent(roomId: string): Promise<{ consentRequired: boolean; consented: boolean }> {
    return this.withAbort(async (signal) => {
      const response = await fetch(this.resolve(`/v1/rooms/${encodeURIComponent(roomId)}/transcript/consent`), {
        headers: this.authHeaders(), cache: 'no-store', signal,
      });
      if (!response.ok) throw await parseError(response);
      const result = await response.json();
      if (typeof result?.consentRequired !== 'boolean' || typeof result?.consented !== 'boolean') {
        throw new Error('Invalid transcription consent status');
      }
      return { consentRequired: result.consentRequired, consented: result.consented };
    });
  }

  /** Records or withdraws transcription consent for the current participant. */
  async setTranscriptConsent(
    roomId: string,
    granted: boolean,
  ): Promise<{ roomId: string; participantId: string; consent: { granted: boolean; grantedAt: number | null }; removedSegments: number }> {
    return this.withAbort(async (signal) => {
      const response = await fetch(this.resolve(`/v1/rooms/${encodeURIComponent(roomId)}/transcript/consent`), {
        method: 'POST',
        headers: this.authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ granted }),
        signal,
      });
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as {
        roomId: string;
        participantId: string;
        consent: { granted: boolean; grantedAt: number | null };
        removedSegments: number;
      };
    });
  }

  /** Translates one line with the tenant's configured engine. */
  async translateText(
    roomId: string,
    text: string,
    options: { targetLang?: 'ru' | 'en'; sourceLang?: 'ru' | 'en' } = {},
  ): Promise<{ translation: { text: string; lang: 'ru' | 'en' }; notice: string }> {
    return this.withAbort(async (signal) => {
      const response = await fetch(this.resolve(`/v1/rooms/${encodeURIComponent(roomId)}/transcript/translate`), {
        method: 'POST',
        headers: this.authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          text,
          ...(options.targetLang ? { targetLang: options.targetLang } : {}),
          ...(options.sourceLang ? { sourceLang: options.sourceLang } : {}),
        }),
        signal,
      });
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as { translation: { text: string; lang: 'ru' | 'en' }; notice: string };
    });
  }

  /**
   * In-call AI assistant (`POST /v1/rooms/:roomId/assistant`, Bearer join token).
   * Returns the raw payload: the caller validates it with `assistantReplySchema`
   * because external LLM output is untrusted input.
   */
  async askAssistant(
    roomId: string,
    body: { text: string; locale?: 'ru' | 'en'; state?: Record<string, unknown> },
  ): Promise<unknown> {
    return this.withAbort(async (signal) => {
      const response = await fetch(this.resolve(`/v1/rooms/${encodeURIComponent(roomId)}/assistant`), {
        method: 'POST',
        headers: this.authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as unknown;
    });
  }

  /**
   * Signaling WebSocket URL (§5).
   *
   * The join token is deliberately **not** part of the URL: browsers print the
   * full WebSocket URL in their console on a failed/blocked upgrade, which
   * leaked the JWT to anyone reading the console (QA P2-5). It is sent in the
   * `Sec-WebSocket-Protocol` header via {@link websocketProtocols} instead.
   */
  websocketUrl(options: {
    token?: string;
    tenantId?: string;
    roomId: string;
    name: string;
    role: string;
    /**
     * Ask the server to hold this participant during a short socket drop
     * (continuity). No secret is added to the URL — only the boolean flag.
     */
    resume?: boolean;
  }): string {
    const url = new URL(this.baseUrl, typeof window !== 'undefined' ? window.location.href : 'http://localhost');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.search = '';
    const token = options.token ?? this.token;
    if (!token) {
      url.searchParams.set('tenant', options.tenantId ?? 'demo');
      url.searchParams.set('room', options.roomId);
      url.searchParams.set('name', options.name);
      url.searchParams.set('role', options.role);
    }
    if (options.resume) url.searchParams.set('resume', '1');
    return url.toString();
  }

  /**
   * WebSocket subprotocols for the upgrade. The first entry is the stable API
   * version; the join token (when present) is an encoded second subprotocol that
   * the server reads from the handshake headers instead of the URL.
   */
  websocketProtocols(token?: string): string[] {
    const value = token ?? this.token;
    const protocols = [WS_SUBPROTOCOL];
    if (value) protocols.push(`${WS_TOKEN_PROTOCOL_PREFIX}${encodeURIComponent(value)}`);
    return protocols;
  }
}

/** Stable signaling subprotocol selected by the server. */
export const WS_SUBPROTOCOL = 'agil-calls.v1';
/** Prefix of the subprotocol that carries the join token (never a URL query). */
export const WS_TOKEN_PROTOCOL_PREFIX = 'agil-token.';
