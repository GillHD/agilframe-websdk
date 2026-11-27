/**
 * WebSocket signaling client (contract §5).
 *
 * Responsibilities:
 *  - connect to `/ws` (or the anonymous query form for dev); an authenticated
 *    join carries its token in the `Sec-WebSocket-Protocol` handshake header so
 *    the JWT never appears in a browser-logged URL;
 *  - parse `ServerMessage` frames resiliently (`JSON.parse` in try/catch — an
 *    unexpected frame must never kill the call);
 *  - heartbeat (`ping`/`pong`) to detect half-open sockets;
 *  - outbound queue while the socket is down (chat keeps working across a
 *    short blip);
 *  - reconnect with exponential backoff from
 *    `config.fallback.lowBandwidth.autoReconnect`.
 */
import type { ClientMessage, ServerMessage, SfuMediaSession, WelcomeMessage } from '@agil/protocol';
import { Emitter } from '../emitter.js';
import type { I18nKey } from '../i18n.js';

/** Internal signaling failures (technical messages; the UI renders `messageKey`). */
export type SignalingErrorCode = 'connection_closed' | 'reconnect_exhausted' | 'server_timeout' | 'socket_failed' | 'origin_not_allowed';
type ProtocolSignalingErrorCode = Extract<ServerMessage, { type: 'error' }>['code'];

export const SIGNALING_ERROR_KEYS: Record<SignalingErrorCode, I18nKey> = {
  connection_closed: 'connectionClosed',
  reconnect_exhausted: 'reconnectExhausted',
  server_timeout: 'serverTimeout',
  socket_failed: 'networkError',
  origin_not_allowed: 'originNotAllowed',
};

export class SignalingError extends Error {
  readonly code: SignalingErrorCode | ProtocolSignalingErrorCode;
  /** i18n key the UI must render instead of `message`. */
  readonly messageKey: I18nKey;

  constructor(code: SignalingErrorCode | ProtocolSignalingErrorCode, message: string, messageKey?: I18nKey) {
    super(message);
    this.name = 'SignalingError';
    this.code = code;
    this.messageKey = messageKey ?? SIGNALING_ERROR_KEYS[code as SignalingErrorCode] ?? 'genericJoinError';
  }
}

export interface ReconnectConfig {
  enabled: boolean;
  attempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface SignalingOptions {
  url: string;
  /** WebSocket subprotocols offered at the upgrade (token travels here, not in the URL). */
  protocols?: string[];
  reconnect: ReconnectConfig;
  /** Heartbeat interval, ms (default 20s). */
  heartbeatMs?: number;
  /** Time without `pong` after which the socket is considered dead (default 45s). */
  pongTimeoutMs?: number;
  /** Queue limit for messages written while offline (default 200). */
  maxQueue?: number;
  /**
   * Resume capability to offer on the very first socket. `recoverSession()`
   * creates a replacement client after a token refresh and must keep the
   * continuity capability of the old one (docs/call-continuity.md §6.3).
   */
  resumeToken?: string | null;
}

export interface SignalingEvents {
  open: void;
  welcome: WelcomeMessage;
  message: ServerMessage;
  close: { code: number; reason: string; wasClean: boolean };
  reconnecting: { attempt: number; delayMs: number };
  reconnected: void;
  error: { code: string; message: string; fatal: boolean };
  /** Socket is permanently closed (manual close or retries exhausted). */
  exhausted: void;
}

const CLOSE_BYE = 1000;

/**
 * Prefix of the resume-capability subprotocol. The token is short-lived and
 * bound to tenant + room + participant; like the join token it is offered in
 * the handshake header, never in the browser-visible URL.
 */
export const WS_RESUME_PROTOCOL_PREFIX = 'agil-resume.';

/**
 * Builds the offered subprotocol list for a (re)connect: the stable API
 * protocol + join token come from the caller, the resume token is added only
 * while the client still has one. Exported for the reconnect unit test.
 */
export function buildSocketProtocols(
  base: readonly string[] | undefined,
  resumeToken: string | null | undefined,
): string[] {
  const protocols = [...(base ?? [])].filter((protocol) => !protocol.startsWith(WS_RESUME_PROTOCOL_PREFIX));
  if (!resumeToken) return protocols;
  const encoded = `${WS_RESUME_PROTOCOL_PREFIX}${encodeURIComponent(resumeToken)}`;
  if (!protocols.includes(encoded)) protocols.push(encoded);
  return protocols;
}

export class SignalingClient {
  chatAcknowledgements = false;
  private ws: WebSocket | null = null;
  private sfuRefresh: { ts: number; finish: (media: SfuMediaSession | null) => void } | null = null;
  private readonly options: SignalingOptions;
  private readonly reconnect: ReconnectConfig;
  private readonly heartbeatMs: number;
  private readonly pongTimeoutMs: number;
  private readonly maxQueue: number;
  readonly emitter = new Emitter<SignalingEvents>();

  private queue: ClientMessage[] = [];
  private attempts = 0;
  private manuallyClosed = false;
  /** Last `welcome.resume.token`; offered on every reconnect socket. */
  private resumeToken: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private firstWelcomeDone = false;
  private connectResolve: ((welcome: WelcomeMessage) => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SignalingOptions) {
    this.options = options;
    this.reconnect = options.reconnect;
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 45_000;
    this.maxQueue = options.maxQueue ?? 200;
    this.resumeToken = options.resumeToken && options.resumeToken.length > 0 ? options.resumeToken : null;
  }

  get state(): 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' {
    if (this.reconnectTimer) return 'reconnecting';
    if (!this.ws) return this.manuallyClosed ? 'closed' : 'idle';
    switch (this.ws.readyState) {
      case WebSocket.OPEN:
        return 'open';
      case WebSocket.CONNECTING:
        return 'connecting';
      default:
        return this.manuallyClosed ? 'closed' : 'reconnecting';
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Remembers the resume capability from `welcome`. Pass `null` to stop
   * offering it (fresh join after a rejected resume or a host-forced rejoin).
   */
  setResumeToken(token: string | null): void {
    this.resumeToken = token && token.length > 0 ? token : null;
  }

  get hasResumeToken(): boolean {
    return this.resumeToken !== null;
  }

  /**
   * Current resume capability, for transferring it to a replacement client
   * (`recoverSession`) or for diagnostics. Never logged by the widget.
   */
  get resumeTokenValue(): string | null {
    return this.resumeToken;
  }

  /** Connects and resolves with the first `welcome` message. */
  connect(): Promise<WelcomeMessage> {
    this.manuallyClosed = false;
    this.attempts = 0;
    return new Promise<WelcomeMessage>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.openSocket(true);
    });
  }

  private openSocket(isInitial: boolean): void {
    this.clearConnectTimer();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    let socket: WebSocket;
    try {
      const protocols = buildSocketProtocols(this.options.protocols, this.resumeToken);
      socket = protocols.length > 0
        ? new WebSocket(this.options.url, protocols)
        : new WebSocket(this.options.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.handleOpenFailure(new SignalingError('socket_failed', message), isInitial);
      return;
    }
    this.ws = socket;
    this.lastPongAt = Date.now();

    socket.addEventListener('open', () => {
      if (this.ws !== socket) return;
      this.attempts = 0;
      this.startHeartbeat();
      this.emitter.emit('open', undefined);
      if (isInitial) {
        this.startConnectTimer();
      } else {
        this.emitter.emit('reconnected', undefined);
      }
      this.flushQueue();
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      if (this.ws !== socket) return;
      this.handleFrame(event.data);
    });

    socket.addEventListener('error', () => {
      // A `close` event always follows; avoid double handling here.
    });

    socket.addEventListener('close', (event: CloseEvent) => {
      if (this.ws !== socket) return;
      this.stopHeartbeat();
      this.sfuRefresh?.finish(null);
      this.emitter.emit('close', { code: event.code, reason: event.reason, wasClean: event.wasClean });
      if (!this.firstWelcomeDone && this.connectResolve) {
        // reject a pending initial connect
        const reason = event.reason ? `: ${event.reason}` : '';
        this.failConnect(new SignalingError('connection_closed', `connection closed before welcome${reason}`));
      }
      if (this.manuallyClosed) {
        this.emitter.emit('exhausted', undefined);
        return;
      }
      if (!this.reconnect.enabled) {
        this.emitter.emit('exhausted', undefined);
        return;
      }
      this.attempts += 1;
      if (this.attempts > this.reconnect.attempts) {
        this.emitter.emit('exhausted', undefined);
        this.failConnect(new SignalingError('reconnect_exhausted', 'reconnect attempts exhausted'));
        return;
      }
      const delayMs = Math.min(
        this.reconnect.maxBackoffMs,
        this.reconnect.backoffMs * 2 ** Math.min(this.attempts - 1, 6),
      );
      this.emitter.emit('reconnecting', { attempt: this.attempts, delayMs });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.openSocket(false);
      }, delayMs);
    });
  }

  private handleOpenFailure(error: Error, isInitial: boolean): void {
    if (isInitial) this.failConnect(error);
    else if (this.reconnect.enabled && this.attempts < this.reconnect.attempts) {
      this.attempts += 1;
      const delayMs = Math.min(
        this.reconnect.maxBackoffMs,
        this.reconnect.backoffMs * 2 ** Math.min(this.attempts - 1, 6),
      );
      this.emitter.emit('reconnecting', { attempt: this.attempts, delayMs });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.openSocket(false);
      }, delayMs);
    } else {
      this.emitter.emit('exhausted', undefined);
    }
  }

  private startConnectTimer(): void {
    this.connectTimer = setTimeout(() => {
      this.failConnect(new SignalingError('server_timeout', 'server did not answer within 15000 ms'));
    }, 15_000);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private failConnect(error: Error): void {
    this.clearConnectTimer();
    const reject = this.connectReject;
    this.connectResolve = null;
    this.connectReject = null;
    reject?.(error);
  }

  private handleFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      console.warn('[agil] signaling: non-JSON frame ignored');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
      console.warn('[agil] signaling: malformed frame ignored');
      return;
    }
    const message = parsed as ServerMessage;
    switch (message.type) {
      case 'welcome':
        this.chatAcknowledgements = message.chatAcknowledgements === true;
        this.firstWelcomeDone = true;
        this.clearConnectTimer();
        if (this.connectResolve) {
          const resolve = this.connectResolve;
          this.connectResolve = null;
          this.connectReject = null;
          resolve(message);
        }
        break;
      case 'pong':
        this.lastPongAt = Date.now();
        if (message.ts === this.sfuRefresh?.ts && message.sfuMedia !== undefined) {
          this.sfuRefresh.finish(message.sfuMedia);
        }
        break;
      case 'error':
        if (message.fatal) {
          this.emitter.emit('error', { code: message.code, message: message.message, fatal: true });
          this.failConnect(message.code === 'unauthorized' && message.message.includes('Origin')
            ? new SignalingError('origin_not_allowed', message.message, 'originNotAllowed')
            : new SignalingError(message.code, message.message));
        } else {
          this.emitter.emit('error', { code: message.code, message: message.message, fatal: false });
        }
        break;
      default:
        break;
    }
    this.emitter.emit('message', message);
  }

  /**
   * Sends a message. Returns `false` when the message was queued instead of sent.
   * Pings are never queued (a stale ping is useless).
   */
  send(message: ClientMessage): boolean {
    const payload = JSON.stringify(message);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return true;
    }
    if (message.type === 'ping' || (message.type === 'chat' && message.acknowledge)) return false;
    this.queue.push(message);
    if (this.queue.length > this.maxQueue) this.queue.shift();
    return false;
  }

  refreshSfu(): Promise<SfuMediaSession | null> {
    if (!this.isOpen || this.sfuRefresh) return Promise.resolve(null);
    return new Promise((resolve) => {
      const ts = Date.now();
      const finish = (media: SfuMediaSession | null): void => {
        clearTimeout(timer);
        this.sfuRefresh = null;
        resolve(media);
      };
      const timer = setTimeout(() => finish(null), 5000);
      this.sfuRefresh = { ts, finish };
      try {
        if (!this.send({ type: 'ping', ts, refreshSfu: true })) finish(null);
      } catch {
        finish(null);
      }
    });
  }

  private flushQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const pending = this.queue;
    this.queue = [];
    for (const message of pending) {
      try {
        this.ws.send(JSON.stringify(message));
      } catch {
        this.queue.push(message);
        break;
      }
    }
  }

  /** Sends `ping` every `heartbeatMs`; forces a reconnect when `pong` stops arriving. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > this.pongTimeoutMs) {
        console.warn('[agil] signaling: heartbeat timeout, reconnecting');
        try {
          this.ws.close(4000, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
        return;
      }
      this.send({ type: 'ping', ts: Date.now(), refreshIce: true });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Graceful close (`bye` then socket close). */
  close(reason = 'client leave'): void {
    this.manuallyClosed = true;
    this.sfuRefresh?.finish(null);
    this.clearConnectTimer();
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'bye' });
        this.ws.close(CLOSE_BYE, reason);
      } else {
        this.ws?.close();
      }
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.resumeToken = null;
    this.queue = [];
    this.emitter.emit('exhausted', undefined);
  }

  destroy(): void {
    this.close('destroy');
    this.emitter.clear();
  }
}
