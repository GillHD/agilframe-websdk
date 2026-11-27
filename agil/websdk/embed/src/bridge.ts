/**
 * postMessage bridge between the host page and the `/embed.html` iframe.
 *
 * Host → iframe (commands, queued until the handshake completes):
 *   `agil:ping`, `agil:action`, `agil:theme`, `agil:scheme`, `agil:chat-send`.
 * iframe → host (accepted only from the iframe's window and an allowlisted
 * origin):
 *   `agil:ready`, `agil:event`, `agil:chat`, `agil:state`, `agil:minimized`,
 *   `agil:fullscreen`, `agil:resize`, `agil:pong`.
 *
 * Security properties:
 *  - outbound `targetOrigin` is a single canonical origin, never `"*"`;
 *  - inbound messages must match `event.source === iframe.contentWindow`
 *    **and** an exact allowlisted origin;
 *  - payloads are structurally sanitized (depth/size limits, prototype keys
 *    dropped) before they reach the element/DOM;
 *  - the bridge never logs and error messages never contain the token.
 */
import { EmbedBridgeError, EmbedConfigError } from './errors.js';
import { LARGE_ROOM_MAX_PARTICIPANTS, extractParticipantIds } from './large-room.js';
import { isAllowedOrigin, parseOrigin } from './origin.js';
import type {
  AgilCallState,
  AgilCapabilities,
  AgilChatMessage,
  AgilThemeScheme,
} from './types.js';

/** Actions understood by the hosted widget; `join` is a forward-compatible extension. */
export const AGIL_ACTIONS = [
  'join',
  'leave',
  'toggle-mic',
  'toggle-camera',
  'request-video-upgrade',
  'toggle-chat',
  'share-screen',
  'blur-on',
  'blur-off',
  'minimize',
  'restore',
  'pip',
  'fullscreen',
  'newtab',
] as const;

export type AgilAction = (typeof AGIL_ACTIONS)[number];

/** Commands the host is allowed to send to the iframe. */
export type HostCommand =
  | { type: 'agil:ping' }
  | { type: 'agil:action'; action: AgilAction }
  | { type: 'agil:video-upgrade-response'; requestId: string; accept: boolean }
  | { type: 'agil:theme'; theme: Record<string, unknown> }
  | { type: 'agil:scheme'; scheme: AgilThemeScheme }
  | { type: 'agil:chat-send'; text: string };

/** Messages the iframe is allowed to send to the host. */
export type WidgetMessage =
  | {
      type: 'agil:ready';
      capabilities: AgilCapabilities;
      room?: string;
      server?: string;
    }
  | { type: 'agil:event'; event: string; payload?: unknown }
  | { type: 'agil:chat'; message: AgilChatMessage }
  | { type: 'agil:state'; state: AgilCallState; participantIds?: string[] }
  | { type: 'agil:minimized'; minimized: boolean }
  | { type: 'agil:fullscreen'; fullscreen: boolean }
  | { type: 'agil:resize'; height: number }
  | { type: 'agil:pong' };

/** Minimal structural types so the bridge is testable without a DOM. */
export interface BridgeContentWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface BridgeIframe {
  contentWindow: BridgeContentWindow | null;
}

export interface BridgeWindow {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface BridgeReadyPayload {
  capabilities: AgilCapabilities;
  room?: string;
  server?: string;
}

export interface BridgeErrorInfo {
  code: 'bridge-error' | 'bridge-timeout';
  message: string;
}

export interface BridgeOptions {
  iframe: BridgeIframe;
  /** Canonical iframe origin; the only allowed `targetOrigin`. */
  targetOrigin: string;
  /** Exact origins trusted for inbound messages; must include `targetOrigin`. */
  allowedOrigins: readonly string[];
  /** Defaults to the global `window`; injectable for tests/SSR. */
  window?: BridgeWindow | null;
  pingIntervalMs?: number;
  readyTimeoutMs?: number;
  maxQueue?: number;
  onHandshake?: () => void;
  onReady?: (payload: BridgeReadyPayload) => void;
  onMessage?: (message: WidgetMessage) => void;
  onTimeout?: () => void;
  onError?: (error: BridgeErrorInfo) => void;
}

const HOST_COMMANDS = new Set<string>([
  'agil:ping',
  'agil:action',
  'agil:video-upgrade-response',
  'agil:theme',
  'agil:scheme',
  'agil:chat-send',
]);
const WIDGET_MESSAGES = new Set<string>([
  'agil:ready',
  'agil:event',
  'agil:chat',
  'agil:state',
  'agil:minimized',
  'agil:fullscreen',
  'agil:resize',
  'agil:pong',
]);

const MAX_TEXT = 4000;
const DEFAULT_MAX_QUEUE = 50;
const MIN_PING_INTERVAL = 10;
const MIN_READY_TIMEOUT = 50;

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ARRAY = 100;
const DEFAULT_MAX_KEYS = 100;
const DEFAULT_MAX_STRING = 32_768;

export interface SanitizeLimits {
  maxDepth?: number;
  maxArray?: number;
  maxKeys?: number;
  maxString?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

/**
 * Recursively converts an untrusted postMessage payload into a JSON-safe tree.
 * Drops functions/symbols, caps depth/collection sizes, drops prototype keys and
 * breaks cycles. Numbers that are not finite become `null`.
 */
export function sanitizeBridgePayload(
  value: unknown,
  limits: SanitizeLimits = {},
): unknown {
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArray = limits.maxArray ?? DEFAULT_MAX_ARRAY;
  const maxKeys = limits.maxKeys ?? DEFAULT_MAX_KEYS;
  const maxString = limits.maxString ?? DEFAULT_MAX_STRING;
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (input === null) return null;
    const kind = typeof input;
    if (kind === 'string') return truncate(input as string, maxString);
    if (kind === 'number') return Number.isFinite(input as number) ? input : null;
    if (kind === 'boolean') return input;
    if (kind === 'undefined' || kind === 'function' || kind === 'symbol' || kind === 'bigint') {
      return undefined;
    }
    if (kind !== 'object') return null;
    if (depth >= maxDepth) return null;
    const object = input as object;
    if (seen.has(object)) return null;
    seen.add(object);
    if (Array.isArray(object)) {
      const result: unknown[] = [];
      const length = Math.min(object.length, maxArray);
      for (let index = 0; index < length; index += 1) {
        let item: unknown;
        try {
          item = walk(object[index], depth + 1);
        } catch {
          item = undefined;
        }
        result.push(item === undefined ? null : item);
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(object)) {
      if (count >= maxKeys) break;
      if (FORBIDDEN_KEYS.has(key)) continue;
      let item: unknown;
      try {
        item = walk((object as Record<string, unknown>)[key], depth + 1);
      } catch {
        item = undefined;
      }
      if (item !== undefined) {
        result[key] = item;
        count += 1;
      }
    }
    return result;
  };

  return walk(value, 0);
}

function readCapabilities(value: unknown): AgilCapabilities {
  const source = isRecord(value) ? value : {};
  return {
    media: source.media === true,
    blur: source.blur === true,
    screenShare: source.screenShare === true,
    captions: source.captions === true,
    recording: source.recording === true,
    ...(typeof source.videoUpgrade === 'boolean' ? { videoUpgrade: source.videoUpgrade } : {}),
  };
}

function safeText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

/**
 * Structural parser for iframe → host messages.
 * Returns `null` for malformed/oversized/unknown messages; never throws.
 */
export function parseWidgetMessage(data: unknown): WidgetMessage | null {
  if (!isRecord(data)) return null;
  const type = data.type;
  if (typeof type !== 'string' || type.length > 64 || !WIDGET_MESSAGES.has(type)) return null;

  switch (type) {
    case 'agil:pong':
      return { type };
    case 'agil:ready': {
      const room = safeText(data.room, 200);
      const server = safeText(data.server, 2048);
      return {
        type,
        capabilities: readCapabilities(data.capabilities),
        ...(room ? { room } : {}),
        ...(server ? { server } : {}),
      };
    }
    case 'agil:event': {
      const event = safeText(data.event, 128);
      if (!event) return null;
      return { type, event, payload: sanitizeBridgePayload(data.payload) };
    }
    case 'agil:chat': {
      if (typeof data.message === 'string') {
        return { type, message: { text: truncate(data.message, MAX_TEXT) } };
      }
      const message = sanitizeBridgePayload(data.message);
      if (!isRecord(message)) return null;
      if (typeof message.text !== 'string') return null;
      return { type, message: message as unknown as AgilChatMessage };
    }
    case 'agil:state': {
      // Parse the participant array before the generic 100-item cap truncates
      // it; the element's digest then emits one bounded snapshot + deltas.
      // One extra id is kept so an oversized widget array is flagged as
      // `truncated` by the digest instead of being silently capped.
      const state = sanitizeBridgePayload(data.state, {
        maxArray: LARGE_ROOM_MAX_PARTICIPANTS + 1,
      });
      if (!isRecord(state)) return null;
      // Preserve "ids absent" (count-only summary) vs "ids present but empty"
      // (empty-room snapshot): only the field's absence requests a summary.
      const hasParticipantIds = Array.isArray(state['participantIds']);
      const participantIds = extractParticipantIds(state);
      delete state['participantIds'];
      return {
        type,
        state: state as AgilCallState,
        ...(hasParticipantIds ? { participantIds } : {}),
      };
    }
    case 'agil:minimized':
      return { type, minimized: data.minimized === true };
    case 'agil:fullscreen':
      return { type, fullscreen: data.fullscreen === true };
    case 'agil:resize': {
      const height = data.height;
      if (typeof height !== 'number' || !Number.isFinite(height)) return null;
      if (height < 120 || height > 5000) return null;
      return { type, height };
    }
    default:
      return null;
  }
}

interface PendingCommand {
  command: HostCommand;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

function isHostCommand(value: unknown): value is HostCommand {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (!HOST_COMMANDS.has(value.type)) return false;
  switch (value.type) {
    case 'agil:ping':
      return true;
    case 'agil:action':
      return typeof value.action === 'string' && (AGIL_ACTIONS as readonly string[]).includes(value.action);
    case 'agil:video-upgrade-response':
      return typeof value.requestId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.requestId) &&
        typeof value.accept === 'boolean';
    case 'agil:theme':
      return isRecord(value.theme);
    case 'agil:scheme':
      return value.scheme === 'light' || value.scheme === 'dark' || value.scheme === 'auto';
    case 'agil:chat-send':
      return typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= MAX_TEXT;
    default:
      return false;
  }
}

/** Timeout/error messages are static and never include config values. */
export class Bridge {
  readonly targetOrigin: string;
  readonly allowedOrigins: readonly string[];

  #iframe: BridgeIframe;
  #window: BridgeWindow | null;
  #pingIntervalMs: number;
  #readyTimeoutMs: number;
  #maxQueue: number;
  #started = false;
  #stopped = false;
  #ready = false;
  #timedOut = false;
  #readyDelivered = false;
  #queue: PendingCommand[] = [];
  #readyWaiters: ReadyWaiter[] = [];
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  #postErrorReported = false;
  #onHandshake?: () => void;
  #onReady?: (payload: BridgeReadyPayload) => void;
  #onMessage?: (message: WidgetMessage) => void;
  #onTimeout?: () => void;
  #onError?: (error: BridgeErrorInfo) => void;

  constructor(options: BridgeOptions) {
    if (!options || typeof options !== 'object') {
      throw new EmbedConfigError('bridge options are required');
    }
    this.targetOrigin = parseOrigin(options.targetOrigin);
    if (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length === 0) {
      throw new EmbedConfigError('allowedOrigins must contain at least the iframe origin');
    }
    const allowed = new Set<string>();
    for (const origin of options.allowedOrigins) allowed.add(parseOrigin(origin));
    if (!allowed.has(this.targetOrigin)) {
      throw new EmbedConfigError('allowedOrigins must include the iframe origin');
    }
    if (allowed.size > 32) throw new EmbedConfigError('allowedOrigins supports at most 32 entries');
    this.allowedOrigins = Object.freeze([...allowed]);
    this.#iframe = options.iframe;
    this.#window =
      options.window !== undefined
        ? options.window
        : typeof window !== 'undefined'
          ? window
          : null;
    this.#pingIntervalMs = Math.max(MIN_PING_INTERVAL, options.pingIntervalMs ?? 1000);
    this.#readyTimeoutMs = Math.max(MIN_READY_TIMEOUT, options.readyTimeoutMs ?? 12_000);
    this.#maxQueue = Math.max(1, options.maxQueue ?? DEFAULT_MAX_QUEUE);
    this.#onHandshake = options.onHandshake;
    this.#onReady = options.onReady;
    this.#onMessage = options.onMessage;
    this.#onTimeout = options.onTimeout;
    this.#onError = options.onError;
  }

  /** True once the iframe answered `agil:pong` or sent `agil:ready`. */
  get isReady(): boolean {
    return this.#ready;
  }

  get isStopped(): boolean {
    return this.#stopped;
  }

  /** Attaches the listener, starts pings and the ready watchdog. */
  start(): void {
    if (this.#stopped) throw new EmbedBridgeError('Bridge has been stopped');
    if (this.#started) return;
    if (!this.#window) throw new EmbedBridgeError('postMessage is not available in this environment');
    this.#started = true;
    this.#window.addEventListener('message', this.#handleMessage);
    this.#pingTimer = setInterval(() => this.#ping(), this.#pingIntervalMs);
    this.#timeoutTimer = setTimeout(() => this.#handleTimeout(), this.#readyTimeoutMs);
    this.#ping();
  }

  /** Detaches listeners, cancels timers and rejects queued work. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#started = false;
    this.#ready = false;
    this.#clearTimers();
    if (this.#window) {
      this.#window.removeEventListener('message', this.#handleMessage);
    }
    const error = new EmbedBridgeError('Bridge stopped');
    this.#rejectQueue(error);
    this.#rejectReadyWaiters(error);
  }

  /** Resolves after the iframe answers the handshake. */
  whenReady(): Promise<void> {
    if (this.#ready) return Promise.resolve();
    if (this.#stopped) return Promise.reject(new EmbedBridgeError('Bridge stopped'));
    if (this.#timedOut) {
      return Promise.reject(new EmbedBridgeError('Widget handshake timed out', 'bridge-timeout'));
    }
    return new Promise<void>((resolve, reject) => {
      this.#readyWaiters.push({ resolve, reject });
    });
  }

  /**
   * Sends a command. Before the handshake the command is queued (bounded) and
   * resolved when flushed. `targetOrigin` is always {@link targetOrigin}.
   */
  send(command: HostCommand): Promise<void> {
    if (!isHostCommand(command)) {
      return Promise.reject(new EmbedConfigError('Unsupported bridge command'));
    }
    if (this.#stopped) return Promise.reject(new EmbedBridgeError('Bridge stopped'));
    if (this.#ready) return this.#postCommand(command);
    if (this.#timedOut) {
      return Promise.reject(new EmbedBridgeError('Widget handshake timed out', 'bridge-timeout'));
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.reject(new EmbedBridgeError('Too many queued bridge commands'));
    }
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ command, resolve, reject });
    });
  }

  /** Sends a keepalive ping (queued until ready). */
  ping(): Promise<void> {
    return this.send({ type: 'agil:ping' });
  }

  #handleMessage = (event: MessageEvent): void => {
    if (this.#stopped) return;
    const content = this.#iframe.contentWindow;
    if (!content || event.source !== content) return;
    if (!isAllowedOrigin(event.origin, this.allowedOrigins)) return;
    const message = parseWidgetMessage(event.data);
    if (!message) return;

    if (message.type === 'agil:pong') {
      this.#markTransportReady();
      return;
    }
    if (message.type === 'agil:ready') {
      this.#markTransportReady();
      if (!this.#readyDelivered) {
        this.#readyDelivered = true;
        this.#onReady?.({
          capabilities: message.capabilities,
          ...(message.room ? { room: message.room } : {}),
          ...(message.server ? { server: message.server } : {}),
        });
      }
      return;
    }
    // Events/chat/state are forwarded even before the handshake: `embed.html`
    // reports configuration errors before it ever emits `agil:ready`.
    this.#onMessage?.(message);
  };

  #markTransportReady(): void {
    if (this.#stopped) return;
    this.#timedOut = false;
    if (this.#ready) return;
    this.#ready = true;
    this.#clearTimers();
    this.#onHandshake?.();
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const waiter of waiters) waiter.resolve();
    this.#flushQueue();
  }

  #flushQueue(): void {
    const queued = this.#queue;
    this.#queue = [];
    for (const item of queued) {
      this.#postCommand(item.command).then(item.resolve, item.reject);
    }
  }

  #ping(): void {
    if (!this.#started || this.#ready || this.#timedOut) return;
    try {
      const content = this.#iframe.contentWindow;
      if (!content) return;
      content.postMessage({ type: 'agil:ping' }, this.targetOrigin);
    } catch {
      this.#reportPostError();
    }
  }

  #postCommand(command: HostCommand): Promise<void> {
    try {
      const content = this.#iframe.contentWindow;
      if (!content) throw new EmbedBridgeError('The iframe is not available');
      content.postMessage(command, this.targetOrigin);
      return Promise.resolve();
    } catch {
      this.#reportPostError();
      // Never propagate a browser/DOM error object that could contain the URL.
      return Promise.reject(new EmbedBridgeError('Failed to send bridge command'));
    }
  }

  #reportPostError(): void {
    if (this.#postErrorReported) return;
    this.#postErrorReported = true;
    this.#onError?.({
      code: 'bridge-error',
      message: 'Failed to postMessage to the iframe',
    });
  }

  #handleTimeout(): void {
    if (this.#stopped || this.#ready) return;
    this.#timedOut = true;
    this.#clearTimers();
    const error = new EmbedBridgeError('Widget handshake timed out', 'bridge-timeout');
    this.#rejectQueue(error);
    this.#rejectReadyWaiters(error);
    this.#onTimeout?.();
  }

  #rejectQueue(error: Error): void {
    const queued = this.#queue;
    this.#queue = [];
    for (const item of queued) item.reject(error);
  }

  #rejectReadyWaiters(error: Error): void {
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  #clearTimers(): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    if (this.#timeoutTimer !== null) {
      clearTimeout(this.#timeoutTimer);
      this.#timeoutTimer = null;
    }
  }
}
