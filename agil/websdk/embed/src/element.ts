/**
 * `<agil-call>` — a framework-agnostic Web Component around `/embed.html`.
 *
 * Two layouts:
 *  - inline (default): the iframe fills the host element (`height` attribute);
 *  - launcher: a floating button opens the call in a modal `<dialog>`.
 *
 * The element owns the iframe, the origin-checked bridge, the loading/error UI
 * and the public methods/events. It never logs and never writes the token into
 * DOM text (the token only appears in the iframe `src` query, per the embed
 * contract).
 */
import {
  Bridge,
  sanitizeBridgePayload,
  type BridgeReadyPayload,
  type WidgetMessage,
} from './bridge.js';
import {
  EmbedBridgeError,
  EmbedConfigError,
  publicMessage,
  redactSecrets,
} from './errors.js';
import { stringsFor, type EmbedStrings } from './i18n.js';
import {
  ConnectionDigest,
  ParticipantDigest,
  compactCallState,
  normalizeLargeRoomLimits,
  readConnectionFields,
} from './large-room.js';
import { parseAllowedOrigins } from './origin.js';
import { EMBED_CSS } from './styles.js';
import type {
  AgilCallErrorCode,
  AgilCallErrorDetail,
  AgilCallEventDetailMap,
  AgilCallState,
  AgilCallStatus,
  AgilFullscreenDetail,
  AgilMinimizedDetail,
  AgilReadyDetail,
  AgilRole,
  AgilThemeScheme,
  AgilThemeSetting,
} from './types.js';
import {
  buildEmbedUrl,
  DEFAULT_HEIGHT,
  type EmbedTarget,
} from './url.js';

export const AGIL_CALL_TAG = 'agil-call';

export const AGIL_CALL_ATTRIBUTES = [
  'server-url',
  'tenant',
  'room',
  'audio-only',
  'token',
  'identity-token',
  'role',
  'name',
  'theme',
  'language',
  'widget-path',
  'height',
  'relay-only',
  'allowed-origins',
  'launcher',
  'allow-insecure',
  'max-participants',
] as const;

export type AgilCallAttribute = (typeof AGIL_CALL_ATTRIBUTES)[number];

/**
 * Canonical `agil-minimized` detail. The web component uses the same
 * `{ minimized }` shape as React Native/Flutter/Capacitor instead of the old
 * shared `{ value }`; this helper keeps the mapping testable without a DOM.
 */
export function minimizedDetail(minimized: boolean): AgilMinimizedDetail {
  return { minimized };
}

/** Canonical `agil-fullscreen` detail (`{ fullscreen }`, matching the mobile SDKs). */
export function fullscreenDetail(fullscreen: boolean): AgilFullscreenDetail {
  return { fullscreen };
}

const LOAD_TIMEOUT_MS = 15_000;
const BRIDGE_READY_TIMEOUT_MS = 20_000;
const MIN_AUTO_HEIGHT = 320;
const MAX_AUTO_HEIGHT = 2400;

const ALLOW_ATTRIBUTE =
  'camera; microphone; display-capture; fullscreen; picture-in-picture; autoplay; clipboard-write; speaker-selection';

const HEIGHT_RE = /^(?:\d{1,4}(?:\.\d{1,2})?)(px|rem|em|vh|dvh|svh|lvh|%)?$/;
const THEME_SCHEMES: readonly AgilThemeScheme[] = ['light', 'dark', 'auto'];

const PHONE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.6 3.5h2.2l1.5 4-2 1.3a12 12 0 0 0 6.9 6.9l1.3-2 4 1.5v2.2a2 2 0 0 1-2.2 2A16.2 16.2 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z"/></svg>`;

const CLOSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>`;

const ALERT_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.5h.01"/></svg>`;

type RuntimeDeferred = {
  promise: Promise<Bridge>;
  resolve: (bridge: Bridge) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

function createRuntimeDeferred(): RuntimeDeferred {
  let resolve!: (bridge: Bridge) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Bridge>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The rejection is surfaced to join()/setTheme() callers. Attach a no-op
  // handler so an unused element (launcher never opened) cannot cause an
  // unhandled rejection at the page level.
  promise.catch(() => undefined);
  return { promise, resolve, reject, settled: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  part?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (part) node.setAttribute('part', part);
  return node;
}

function normalizeHeight(value: string | null): string {
  if (value === null || !value.trim()) return DEFAULT_HEIGHT;
  const raw = value.trim().toLowerCase();
  if (raw === 'auto') return 'auto';
  if (!HEIGHT_RE.test(raw)) {
    throw new EmbedConfigError(
      'height must be "auto" or a CSS length such as 640px, 70vh or 100%',
    );
  }
  const numeric = Number.parseFloat(raw);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 5000) {
    throw new EmbedConfigError('height must be between 1 and 5000');
  }
  return /px|rem|em|vh|dvh|svh|lvh|%$/.test(raw) ? raw : `${raw}px`;
}

function normalizeTheme(value: string | null): AgilThemeScheme | undefined {
  if (!value) return undefined;
  const raw = value.trim().toLowerCase();
  return (THEME_SCHEMES as readonly string[]).includes(raw)
    ? (raw as AgilThemeScheme)
    : undefined;
}

function isScheme(value: unknown): value is AgilThemeScheme {
  return typeof value === 'string' && (THEME_SCHEMES as readonly string[]).includes(value);
}

function errorCodeFromThrown(error: unknown): AgilCallErrorCode {
  if (error instanceof EmbedConfigError) {
    return error.code === 'missing-room' ? 'missing-room' : 'invalid-config';
  }
  if (error instanceof EmbedBridgeError) {
    if (error.code === 'load-timeout') return 'load-timeout';
    if (error.code === 'bridge-timeout') return 'bridge-timeout';
    if (error.code === 'destroyed') return 'destroyed';
    return 'bridge-error';
  }
  return 'invalid-config';
}

const HTMLElementBase: typeof HTMLElement =
  typeof HTMLElement !== 'undefined'
    ? HTMLElement
    : (class {} as unknown as typeof HTMLElement);

/**
 * Framework-agnostic custom element. Extend/customize only by composition:
 * all internals live in a closed-by-convention shadow root (mode `open` for
 * debugging and `part` styling).
 */
export class AgilCallElement extends HTMLElementBase {
  static readonly tagName = AGIL_CALL_TAG;

  static get observedAttributes(): string[] {
    return [...AGIL_CALL_ATTRIBUTES];
  }

  #shadow: ShadowRoot | null = null;
  #root: HTMLElement | null = null;
  #stage: HTMLElement | null = null;
  #iframe: HTMLIFrameElement | null = null;
  #bridge: Bridge | null = null;
  #runtime: RuntimeDeferred | null = null;
  #dialog: HTMLDialogElement | null = null;
  #launcherButton: HTMLButtonElement | null = null;
  #statusElement: HTMLElement | null = null;
  #statusText: HTMLElement | null = null;
  #errorElement: HTMLElement | null = null;
  #errorTitle: HTMLElement | null = null;
  #errorMessage: HTMLElement | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #loadTimer: ReturnType<typeof setTimeout> | null = null;

  #connected = false;
  #destroyed = false;
  #rebuildQueued = false;
  #suppressDialogSync = false;
  #launcherOpen = false;
  #ready = false;
  #joined = false;
  #readyEmitted = false;
  #status: AgilCallStatus = 'idle';
  #strings: EmbedStrings = stringsFor(undefined);
  #themeOverride: AgilThemeScheme | null = null;
  #heightValue: string = DEFAULT_HEIGHT;
  #autoHeight = 640;
  #latestState: AgilCallState | null = null;
  #participants = new ParticipantDigest();
  #connection = new ConnectionDigest();
  #lastError: AgilCallErrorDetail | null = null;
  #pendingTheme:
    | { kind: 'scheme'; scheme: AgilThemeScheme }
    | { kind: 'theme'; theme: Record<string, unknown> }
    | null = null;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: 'open' });
  }

  // ---------------------------------------------------------------------------
  // Reflected attributes
  // ---------------------------------------------------------------------------

  get serverUrl(): string {
    return this.getAttribute('server-url') ?? '';
  }

  set serverUrl(value: string | null | undefined) {
    this.#reflect('server-url', value);
  }

  get tenant(): string {
    return this.getAttribute('tenant') ?? '';
  }

  set tenant(value: string | null | undefined) {
    this.#reflect('tenant', value);
  }

  get room(): string {
    return this.getAttribute('room') ?? '';
  }

  set room(value: string | null | undefined) {
    this.#reflect('room', value);
  }

  get token(): string {
    return this.getAttribute('token') ?? '';
  }

  set token(value: string | null | undefined) {
    this.#reflect('token', value);
  }

  get identityToken(): string {
    return this.getAttribute('identity-token') ?? '';
  }

  set identityToken(value: string | null | undefined) {
    this.#reflect('identity-token', value);
  }

  /**
   * Role for anonymous joins (`role` attribute). The property is called
   * `callRole` because `HTMLElement.role` already exists (ARIA reflection).
   */
  get callRole(): string {
    return this.getAttribute('role') ?? '';
  }

  set callRole(value: string | null | undefined) {
    this.#reflect('role', value);
  }

  get name(): string {
    return this.getAttribute('name') ?? '';
  }

  set name(value: string | null | undefined) {
    this.#reflect('name', value);
  }

  get theme(): string {
    return this.getAttribute('theme') ?? '';
  }

  set theme(value: string | null | undefined) {
    this.#reflect('theme', value);
  }

  get language(): string {
    return this.getAttribute('language') ?? '';
  }

  set language(value: string | null | undefined) {
    this.#reflect('language', value);
  }

  get widgetPath(): string {
    return this.getAttribute('widget-path') ?? '';
  }

  set widgetPath(value: string | null | undefined) {
    this.#reflect('widget-path', value);
  }

  get height(): string {
    return this.getAttribute('height') ?? DEFAULT_HEIGHT;
  }

  set height(value: string | null | undefined) {
    this.#reflect('height', value);
  }

  get relayOnly(): boolean {
    return this.#booleanAttribute('relay-only');
  }

  set relayOnly(value: boolean) {
    this.#reflectBoolean('relay-only', value);
  }

  get allowedOrigins(): string {
    return this.getAttribute('allowed-origins') ?? '';
  }

  set allowedOrigins(value: string | null | undefined) {
    this.#reflect('allowed-origins', value);
  }

  get launcher(): boolean {
    return this.#booleanAttribute('launcher');
  }

  set launcher(value: boolean) {
    this.#reflectBoolean('launcher', value);
  }

  /** Allows plain `http://` for non-loopback servers. Development only. */
  get allowInsecure(): boolean {
    return this.#booleanAttribute('allow-insecure');
  }

  set allowInsecure(value: boolean) {
    this.#reflectBoolean('allow-insecure', value);
  }

  /**
   * Large-room participant cap for the bridge digest (`max-participants`,
   * 2..200, default 200). The element keeps the canonical participant set and
   * emits `agil-participants` snapshots/deltas instead of a 200-id array on
   * every `agil-state` tick.
   */
  get maxParticipants(): number {
    return normalizeLargeRoomLimits({
      maxParticipants: Number(this.getAttribute('max-participants') ?? undefined),
    }).maxParticipants;
  }

  set maxParticipants(value: number | null | undefined) {
    this.#reflect('max-participants', value === null || value === undefined ? null : String(value));
  }

  /** Authoritative participant count from the latest compact snapshot. */
  get participantCount(): number {
    return this.#participants.count;
  }

  // ---------------------------------------------------------------------------
  // Read-only state
  // ---------------------------------------------------------------------------

  /** Current lifecycle status of the element. */
  get status(): AgilCallStatus {
    return this.#status;
  }

  /** True after the iframe answered the postMessage handshake. */
  get isReady(): boolean {
    return this.#ready;
  }

  /** True after the widget reported `joined`. */
  get isJoined(): boolean {
    return this.#joined;
  }

  /** True while the launcher modal is open. */
  get isLauncherOpen(): boolean {
    return this.#launcherOpen;
  }

  /** Latest sanitized `agil:state` snapshot, if any. */
  get callState(): AgilCallState | null {
    return this.#latestState;
  }

  /** Last fatal error shown in the fallback UI (redacted). */
  get lastError(): AgilCallErrorDetail | null {
    return this.#lastError;
  }

  // ---------------------------------------------------------------------------
  // Custom-element lifecycle
  // ---------------------------------------------------------------------------

  connectedCallback(): void {
    if (this.#destroyed) return;
    this.#connected = true;
    this.#rebuild();
  }

  disconnectedCallback(): void {
    this.#connected = false;
    this.#launcherOpen = false;
    this.#teardownRuntime();
    this.#closeDialogSilently();
  }

  attributeChangedCallback(
    name: string,
    oldValue: string | null,
    newValue: string | null,
  ): void {
    if (oldValue === newValue || this.#destroyed) return;
    if (!this.#connected) return;
    if (name === 'height') {
      try {
        const height = normalizeHeight(newValue);
        this.#applyHeight(height);
        if (height === 'auto') this.#observeAutoHeight();
        else {
          this.#resizeObserver?.disconnect();
          this.#resizeObserver = null;
        }
      } catch (error) {
        this.#failConfig(error);
      }
      return;
    }
    if (name === 'theme') {
      this.#themeOverride = null;
      this.#applyChromeTheme();
    }
    if (name === 'max-participants') {
      this.#participants = new ParticipantDigest({ maxParticipants: this.maxParticipants });
      this.#connection.reset();
      return;
    }
    this.#scheduleRebuild();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Opens the launcher (if applicable), waits for the bridge handshake and
   * sends a join request. With a token the hosted widget auto-joins on mount; in
   * the token-less flow the iframe join screen is focused so the participant
   * can confirm (the current hosted page does not implement a server-side
   * `join` action).
   */
  async join(): Promise<void> {
    this.#assertAlive();
    if (this.launcher) this.open();
    const bridge = await this.#ensureRuntime();
    if (this.#joined) return;
    await bridge.send({ type: 'agil:action', action: 'join' });
    this.#focusIframe();
  }

  /** Sends `agil:action leave`. No-op when the iframe is not mounted. */
  async leave(): Promise<void> {
    this.#assertAlive();
    const bridge = this.#bridge;
    if (!bridge) return;
    await bridge.send({ type: 'agil:action', action: 'leave' });
  }

  /** Sends a video request to the direct peer in an active audio call. */
  async requestVideoUpgrade(): Promise<void> {
    this.#assertAlive();
    const bridge = await this.#ensureRuntime();
    await bridge.send({ type: 'agil:action', action: 'request-video-upgrade' });
  }

  /** Answers the request identified in the latest agil-state event. */
  async respondToVideoUpgrade(requestId: string, accept: boolean): Promise<void> {
    this.#assertAlive();
    const bridge = await this.#ensureRuntime();
    await bridge.send({ type: 'agil:video-upgrade-response', requestId, accept });
  }

  /**
   * Switches light/dark/auto (or applies a theme patch) without reloading the
   * iframe. When the call is not mounted yet (closed launcher) the change is
   * queued until handshake.
   */
  async setTheme(theme: AgilThemeSetting): Promise<void> {
    this.#assertAlive();
    if (typeof theme === 'string') {
      if (!isScheme(theme)) {
        throw new EmbedConfigError('theme must be "light", "dark" or "auto"');
      }
      this.#themeOverride = theme;
      this.#applyChromeTheme();
      const bridge = this.#bridge;
      if (bridge) {
        await bridge.send({ type: 'agil:scheme', scheme: theme });
      } else {
        this.#pendingTheme = { kind: 'scheme', scheme: theme };
      }
      return;
    }
    if (!isRecord(theme)) throw new EmbedConfigError('theme must be a scheme or a plain object');
    const sanitized = sanitizeBridgePayload(theme);
    if (!isRecord(sanitized)) throw new EmbedConfigError('theme must be a plain object');
    const scheme = sanitized.scheme;
    if (isScheme(scheme)) {
      this.#themeOverride = scheme;
      this.#applyChromeTheme();
    }
    const bridge = this.#bridge;
    if (bridge) {
      await bridge.send({ type: 'agil:theme', theme: sanitized });
    } else {
      this.#pendingTheme = { kind: 'theme', theme: sanitized };
    }
  }

  /** Sends a chat message through `agil:chat-send`. */
  async sendChat(text: string): Promise<void> {
    this.#assertAlive();
    if (typeof text !== 'string') throw new EmbedConfigError('chat text must be a string');
    if (!text.trim()) throw new EmbedConfigError('chat text must not be empty');
    if (text.length > 4000) {
      throw new EmbedConfigError('chat text is too long (max 4000 characters)');
    }
    const bridge = this.#bridge;
    if (!bridge) throw new EmbedConfigError('the call is not mounted');
    await bridge.send({ type: 'agil:chat-send', text });
  }

  /** Opens the launcher modal (no-op in inline mode). */
  open(): void {
    this.#assertAlive();
    if (!this.launcher) return;
    if (!this.#connected) {
      this.#launcherOpen = true;
      return;
    }
    if (!this.#dialog) {
      this.#launcherOpen = true;
      this.#rebuild();
      return;
    }
    if (this.#launcherOpen && this.#dialog.open) return;
    this.#launcherOpen = true;
    try {
      if (typeof this.#dialog.showModal === 'function') this.#dialog.showModal();
      else this.#dialog.setAttribute('open', '');
    } catch {
      this.#dialog.setAttribute('open', '');
    }
    this.#syncLauncherState();
    if (!this.#iframe) this.#mountFrame();
  }

  /** Closes the launcher modal but keeps the call (and iframe) alive. */
  close(): void {
    if (!this.#launcherOpen) return;
    this.#launcherOpen = false;
    this.#closeDialogSilently();
    this.#syncLauncherState();
  }

  /**
   * Rebuilds the iframe from the same attributes (server, room, token and
   * identity token are preserved) with a fresh bridge handshake and participant
   * digest. Use it after a dropped connection; `agil:ready`/`agil-state` follow.
   */
  reconnect(): void {
    this.#assertAlive();
    if (!this.#connected) return;
    this.#rebuild();
  }

  /** Permanently tears the element down. Idempotent. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#setStatus('destroyed');
    this.#destroyed = true;
    this.#launcherOpen = false;
    this.#teardownRuntime();
    this.#closeDialogSilently();
    this.#shadow?.replaceChildren();
    this.#shadow = null;
    this.#root = null;
    this.#stage = null;
    this.#dialog = null;
    this.#launcherButton = null;
    this.#statusElement = null;
    this.#errorElement = null;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  #reflect(name: string, value: string | null | undefined): void {
    if (value === null || value === undefined || value === '') this.removeAttribute(name);
    else this.setAttribute(name, String(value));
  }

  #reflectBoolean(name: string, value: boolean): void {
    if (value) this.setAttribute(name, '');
    else this.removeAttribute(name);
  }

  #booleanAttribute(name: string): boolean {
    if (!this.hasAttribute(name)) return false;
    const value = (this.getAttribute(name) ?? '').trim().toLowerCase();
    return value !== 'false' && value !== '0';
  }

  #launcherLabel(): string {
    const raw = (this.getAttribute('launcher') ?? '').trim();
    if (raw && !['true', 'false', '0', '1'].includes(raw.toLowerCase())) {
      return redactSecrets(raw.slice(0, 60), this.#secrets());
    }
    return this.#strings.launcher;
  }

  #scheduleRebuild(): void {
    if (this.#rebuildQueued) return;
    this.#rebuildQueued = true;
    queueMicrotask(() => {
      this.#rebuildQueued = false;
      if (this.#connected && !this.#destroyed) this.#rebuild();
    });
  }

  #rebuild(): void {
    if (this.#destroyed || !this.#connected) return;
    const wasOpen = this.#launcherOpen;
    this.#teardownRuntime();
    this.#lastError = null;
    this.#readyEmitted = false;
    this.#strings = stringsFor(this.getAttribute('language'));
    this.#renderShell();
    this.#applyChromeTheme();

    const launcherMode = this.launcher;
    this.#launcherOpen = launcherMode ? wasOpen : false;
    if (launcherMode && this.#launcherOpen) {
      try {
        if (this.#dialog) {
          if (typeof this.#dialog.showModal === 'function') this.#dialog.showModal();
          else this.#dialog.setAttribute('open', '');
        }
      } catch {
        this.#dialog?.setAttribute('open', '');
      }
    }
    this.#syncLauncherState();

    try {
      this.#applyHeight(normalizeHeight(this.getAttribute('height')));
    } catch (error) {
      this.#failConfig(error);
      return;
    }

    if (!launcherMode || this.#launcherOpen) this.#mountFrame();
    else this.#setStatus('idle');
  }

  #renderShell(): void {
    const shadow = this.#shadow;
    if (!shadow) return;
    const style = document.createElement('style');
    style.textContent = EMBED_CSS;

    const root = element('div', 'root', 'container');
    this.#root = root;
    const launcherMode = this.launcher;

    if (launcherMode) {
      const button = element('button', 'launcher', 'launcher');
      button.type = 'button';
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-expanded', 'false');
      button.innerHTML = PHONE_ICON;
      const label = element('span', 'sr-only');
      label.textContent = this.#launcherLabel();
      button.append(label);
      button.addEventListener('click', () => this.open());
      this.#launcherButton = button;

      const dialog = element('dialog', 'dialog', 'dialog');
      const titleId = 'agil-embed-dialog-title';
      dialog.setAttribute('aria-labelledby', titleId);
      const header = element('header', 'dialog-header', 'dialog-header');
      const title = element('span', 'dialog-title', 'dialog-title');
      title.id = titleId;
      title.textContent = this.#strings.dialogTitle;
      const closeButton = element('button', 'close', 'close');
      closeButton.type = 'button';
      closeButton.setAttribute('aria-label', this.#strings.close);
      closeButton.innerHTML = CLOSE_ICON;
      closeButton.addEventListener('click', () => this.close());
      header.append(title, closeButton);

      const stage = element('div', 'stage dialog-stage', 'stage');
      dialog.append(header, stage);
      dialog.addEventListener('close', () => {
        if (this.#suppressDialogSync || this.#dialog !== dialog) return;
        this.#launcherOpen = false;
        this.#syncLauncherState();
      });
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) this.close();
      });
      this.#dialog = dialog;
      this.#stage = stage;
      root.append(button, dialog);
    } else {
      this.#dialog = null;
      this.#launcherButton = null;
      const stage = element('div', 'stage inline-stage', 'stage');
      this.#stage = stage;
      root.append(stage);
    }

    this.#appendOverlays(this.#stage);
    shadow.replaceChildren(style, root);
  }

  #appendOverlays(stage: HTMLElement | null): void {
    if (!stage) return;

    const status = element('div', 'status', 'status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    const spinner = element('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    const statusText = element('span', 'status-text');
    status.append(spinner, statusText);

    const error = element('div', 'error', 'error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    const card = element('div', 'error-card');
    const icon = element('span', 'error-icon');
    icon.innerHTML = ALERT_ICON;
    const title = element('h2', 'error-title');
    const message = element('p', 'error-message');
    const retry = element('button', 'retry');
    retry.type = 'button';
    retry.textContent = this.#strings.retry;
    retry.addEventListener('click', () => this.#retry());
    card.append(icon, title, message, retry);
    error.append(card);

    stage.append(status, error);
    this.#statusElement = status;
    this.#statusText = statusText;
    this.#errorElement = error;
    this.#errorTitle = title;
    this.#errorMessage = message;
  }

  #syncLauncherState(): void {
    this.#launcherButton?.setAttribute(
      'aria-expanded',
      this.#launcherOpen ? 'true' : 'false',
    );
  }

  #applyChromeTheme(): void {
    const root = this.#root;
    if (!root) return;
    const effective = this.#themeOverride ?? normalizeTheme(this.getAttribute('theme'));
    root.dataset['theme'] = effective === 'dark' ? 'dark' : effective === 'light' ? 'light' : '';
  }

  #applyHeight(value: string): void {
    this.#heightValue = value;
    if (!this.#stage) return;
    this.#stage.classList.toggle('is-auto', value === 'auto');
    const height = value === 'auto' ? `${this.#autoHeight}px` : value;
    this.#stage.style.setProperty('--agil-embed-height', height);
  }

  // ---------------------------------------------------------------------------
  // iframe + bridge
  // ---------------------------------------------------------------------------

  #buildTarget(): EmbedTarget {
    const room = this.getAttribute('room');
    if (!room || !room.trim()) {
      throw new EmbedConfigError(this.#strings.missingRoom, 'missing-room');
    }
    const theme = normalizeTheme(this.getAttribute('theme'));
    return buildEmbedUrl({
      serverUrl: this.getAttribute('server-url') ?? undefined,
      widgetPath: this.getAttribute('widget-path') ?? undefined,
      room,
      audioOnly: this.hasAttribute('audio-only'),
      token: this.getAttribute('token') ?? undefined,
      identityToken: this.getAttribute('identity-token') ?? undefined,
      role: (this.callRole as AgilRole | null) || undefined,
      tenant: this.getAttribute('tenant') ?? undefined,
      name: this.getAttribute('name') ?? undefined,
      language: this.getAttribute('language') ?? undefined,
      theme,
      relayOnly: this.relayOnly,
      allowInsecure: this.allowInsecure,
    });
  }

  #mountFrame(): void {
    const stage = this.#stage;
    if (!stage || !this.#connected || this.#destroyed) return;
    let target: EmbedTarget;
    let allowedOrigins: readonly string[];
    try {
      target = this.#buildTarget();
      allowedOrigins = parseAllowedOrigins(
        this.getAttribute('allowed-origins'),
        target.origin,
      );
    } catch (error) {
      this.#failConfig(error);
      return;
    }

    this.#ready = false;
    this.#joined = false;
    this.#latestState = null;
    this.#participants = new ParticipantDigest({ maxParticipants: this.maxParticipants });
    this.#connection = new ConnectionDigest();
    this.#runtime = createRuntimeDeferred();

    const iframe = document.createElement('iframe');
    iframe.className = 'frame';
    iframe.title = this.#strings.iframeTitle;
    iframe.setAttribute('allow', ALLOW_ATTRIBUTE);
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('loading', 'eager');
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    this.#iframe = iframe;

    iframe.addEventListener(
      'load',
      () => {
        if (this.#iframe !== iframe) return;
        this.#clearLoadTimer();
        this.#hideLoading();
        this.#observeAutoHeight();
      },
      { once: true },
    );
    iframe.addEventListener('error', () => {
      if (this.#iframe !== iframe) return;
      this.#failFatal('iframe-error', this.#strings.loadTimeout);
    });

    try {
      this.#bridge = new Bridge({
        iframe,
        targetOrigin: target.origin,
        allowedOrigins,
        readyTimeoutMs: BRIDGE_READY_TIMEOUT_MS,
        onHandshake: () => {
          this.#resolveRuntime(this.#bridge ?? undefined);
          this.#hideLoading();
          if (this.#status !== 'joined') this.#setStatus('connected');
          this.#flushPendingTheme();
        },
        onReady: (payload) => this.#handleReady(payload),
        onMessage: (message) => this.#handleWidgetMessage(message),
        onTimeout: () => {
          const error = new EmbedBridgeError(this.#strings.bridgeTimeout, 'bridge-timeout');
          this.#rejectRuntime(error);
          this.#failFatal('bridge-timeout', this.#strings.bridgeTimeout);
        },
        onError: (info) => {
          this.#emitError({
            code: 'bridge-error',
            message: publicMessage(info.message, this.#secrets()),
            fatal: false,
          });
        },
      });
    } catch (error) {
      this.#failConfig(error);
      return;
    }

    this.#showLoading();
    this.#setStatus('loading');
    stage.append(iframe);
    // Attach the listener before navigation so an early `agil:ready` is never
    // lost; repeated pings cover the window before the embed page installs its
    // own listener.
    try {
      this.#bridge.start();
    } catch (error) {
      this.#failConfig(error);
      return;
    }
    iframe.src = target.url;
    this.#loadTimer = setTimeout(() => {
      if (this.#iframe !== iframe || this.#bridge?.isReady) return;
      this.#failFatal('load-timeout', this.#strings.loadTimeout);
    }, LOAD_TIMEOUT_MS);
  }

  #teardownRuntime(): void {
    this.#clearLoadTimer();
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#bridge?.stop();
    this.#bridge = null;
    if (this.#iframe) {
      const iframe = this.#iframe;
      this.#iframe = null;
      try {
        iframe.src = 'about:blank';
      } catch {
        /* ignore */
      }
      iframe.remove();
    }
    this.#rejectRuntime(new EmbedBridgeError('Embed was reloaded'));
    this.#runtime = null;
    this.#ready = false;
    this.#joined = false;
    this.#latestState = null;
    this.#participants.reset();
    this.#connection.reset();
    this.#pendingTheme = null;
  }

  #ensureRuntime(): Promise<Bridge> {
    if (this.#destroyed) {
      return Promise.reject(new EmbedConfigError(this.#strings.destroyed, 'destroyed'));
    }
    // A late handshake after the watchdog fired still makes the bridge usable.
    if (this.#bridge?.isReady) return Promise.resolve(this.#bridge);
    if (this.#runtime) return this.#runtime.promise;
    this.#rebuild();
    const runtime = this.#runtime as RuntimeDeferred | null;
    if (runtime) return runtime.promise;
    const message = this.#lastError?.message ?? this.#strings.invalidConfig;
    return Promise.reject(new EmbedBridgeError(message, 'bridge-error'));
  }

  #resolveRuntime(bridge: Bridge | undefined): void {
    const runtime = this.#runtime;
    if (!runtime || runtime.settled || !bridge) return;
    runtime.settled = true;
    runtime.resolve(bridge);
  }

  #rejectRuntime(error: Error): void {
    const runtime = this.#runtime;
    if (!runtime || runtime.settled) return;
    runtime.settled = true;
    runtime.reject(error);
  }

  #focusIframe(): void {
    try {
      this.#iframe?.focus();
    } catch {
      /* focus can be denied; the iframe join screen remains clickable */
    }
  }

  #flushPendingTheme(): void {
    const pending = this.#pendingTheme;
    const bridge = this.#bridge;
    if (!pending || !bridge) return;
    this.#pendingTheme = null;
    const command =
      pending.kind === 'scheme'
        ? ({ type: 'agil:scheme', scheme: pending.scheme } as const)
        : ({ type: 'agil:theme', theme: pending.theme } as const);
    void bridge.send(command).catch(() => undefined);
  }

  #secrets(): readonly string[] {
    const token = this.getAttribute('token');
    const identityToken = this.getAttribute('identity-token');
    return [token, identityToken].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
  }

  // ---------------------------------------------------------------------------
  // Inbound widget messages
  // ---------------------------------------------------------------------------

  #handleReady(payload: BridgeReadyPayload): void {
    if (this.#readyEmitted || this.#destroyed) return;
    this.#ready = true;
    this.#readyEmitted = true;
    this.#resolveRuntime(this.#bridge ?? undefined);
    this.#hideLoading();
    this.#hideError();
    this.#lastError = null;
    if (!this.#joined) this.#setStatus('connected');
    const detail: AgilReadyDetail = {
      capabilities: payload.capabilities,
      ...(payload.room ? { room: redactSecrets(payload.room, this.#secrets()) } : {}),
    };
    this.#emit('agil-ready', detail);
  }

  #handleWidgetMessage(message: WidgetMessage): void {
    if (this.#destroyed) return;
    switch (message.type) {
      case 'agil:event': {
        if (message.event === 'joined') {
          this.#joined = true;
          this.#hideLoading();
          this.#setStatus('joined');
          this.#emit('agil-joined', { payload: message.payload });
        } else if (message.event === 'left') {
          this.#joined = false;
          this.#setStatus('left');
          this.#emit('agil-left', { payload: message.payload });
        } else if (message.event === 'error') {
          this.#handleWidgetError(message.payload);
        } else if (message.event === 'action-denied') {
          this.#handleActionDenied(message.payload);
        } else {
          // Participant/quality/connection/… events: forward the full stream
          // like the mobile SDKs instead of dropping it on the web.
          if (message.event === 'connection-state' || message.event === 'connection-changed') {
            const connection = this.#connection.apply(
              readConnectionFields(isRecord(message.payload) ? message.payload : {}),
            );
            if (connection) this.#emit('agil-connection', { connection });
          }
          this.#emit('agil-event', { name: message.event, payload: message.payload });
        }
        break;
      }
      case 'agil:chat':
        this.#emit('agil-chat', { message: message.message });
        break;
      case 'agil:state': {
        const update = this.#participants.apply({
          participantIds: message.participantIds,
          count: message.state.participants,
        });
        const state = compactCallState(
          message.state as Record<string, unknown>,
          update,
        ) as AgilCallState;
        const connection = this.#connection.apply(
          readConnectionFields(message.state as Record<string, unknown>),
        );
        if (connection) {
          this.#emit('agil-connection', { connection });
          if (connection.reconnecting) {
            state.reconnect = {
              ...(connection.attempt !== undefined ? { attempt: connection.attempt } : {}),
              ...(connection.delayMs !== undefined ? { delayMs: connection.delayMs } : {}),
            };
          }
        }
        this.#latestState = state;
        if (state.phase === 'joined') {
          this.#joined = true;
          if (this.#status !== 'joined') this.#setStatus('joined');
        } else if (state.phase === 'left' || state.phase === 'idle') {
          this.#joined = false;
          if (this.#status === 'joined') this.#setStatus('left');
        }
        this.#emit('agil-state', { state });
        if (update) this.#emit('agil-participants', { participants: update });
        break;
      }
      case 'agil:minimized':
        this.#emit('agil-minimized', minimizedDetail(message.minimized));
        break;
      case 'agil:fullscreen':
        this.#emit('agil-fullscreen', fullscreenDetail(message.fullscreen));
        break;
      case 'agil:resize':
        if (this.#heightValue === 'auto') this.#setAutoHeight(message.height);
        break;
      default:
        break;
    }
  }

  #handleWidgetError(payload: unknown): void {
    const record = isRecord(payload) ? payload : {};
    const rawCode =
      typeof record['code'] === 'string' && record['code'].length <= 64
        ? record['code']
        : 'widget-error';
    const widgetCode = redactSecrets(rawCode, this.#secrets()) || 'widget-error';
    const rawMessage =
      typeof record['message'] === 'string' ? record['message'] : undefined;
    const fatal = !this.#ready;
    const detail: AgilCallErrorDetail = {
      code: 'widget-error',
      widgetCode,
      message: publicMessage(rawMessage, this.#secrets(), this.#strings.invalidConfig),
      fatal,
    };
    this.#emitError(detail);
    if (fatal) {
      this.#rejectRuntime(new EmbedBridgeError(detail.message));
      this.#failUI(detail);
    }
  }

  #handleActionDenied(payload: unknown): void {
    const record = isRecord(payload) ? payload : {};
    const action = typeof record['action'] === 'string' ? record['action'].slice(0, 64) : '';
    const reason = typeof record['reason'] === 'string' ? record['reason'].slice(0, 64) : '';
    // The hosted `embed.html` does not implement a programmatic `join` action.
    // `join()` falls back to focusing the iframe join screen, so this specific
    // denial is expected and not surfaced as a failure.
    if (action === 'join' && (reason === 'unknown-action' || reason === 'not-ready')) return;
    this.#emitError({
      code: 'action-denied',
      message: publicMessage(
        `The call denied the "${action || 'unknown'}" action${reason ? ` (${reason})` : ''}`,
        this.#secrets(),
      ),
      fatal: false,
      ...(reason ? { widgetCode: redactSecrets(reason, this.#secrets()) } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Loading / error / auto-height
  // ---------------------------------------------------------------------------

  #setStatus(status: AgilCallStatus): void {
    if (this.#destroyed) return;
    this.#status = status;
  }

  #showLoading(): void {
    if (this.#statusText) this.#statusText.textContent = this.#strings.connecting;
    if (this.#statusElement) this.#statusElement.hidden = false;
  }

  #hideLoading(): void {
    if (this.#statusElement) this.#statusElement.hidden = true;
  }

  #showError(detail: AgilCallErrorDetail): void {
    this.#lastError = detail;
    if (this.#errorTitle) this.#errorTitle.textContent = this.#strings.errorTitle;
    if (this.#errorMessage) this.#errorMessage.textContent = detail.message;
    if (this.#errorElement) this.#errorElement.hidden = false;
    this.#hideLoading();
  }

  #hideError(): void {
    if (this.#errorElement) this.#errorElement.hidden = true;
  }

  #failUI(detail: AgilCallErrorDetail): void {
    if (this.#destroyed) return;
    this.#setStatus('error');
    this.#showError(detail);
  }

  #failConfig(error: unknown): void {
    const message = publicMessage(error, this.#secrets(), this.#strings.invalidConfig);
    const detail: AgilCallErrorDetail = {
      code: errorCodeFromThrown(error),
      message,
      fatal: true,
    };
    this.#rejectRuntime(new EmbedBridgeError(message));
    this.#failUI(detail);
    this.#emitError(detail);
  }

  #failFatal(code: 'load-timeout' | 'bridge-timeout' | 'iframe-error', message: string): void {
    if (this.#status === 'error' && this.#lastError?.fatal) return;
    this.#clearLoadTimer();
    const detail: AgilCallErrorDetail = {
      code,
      message: publicMessage(message, this.#secrets(), this.#strings.invalidConfig),
      fatal: true,
    };
    this.#rejectRuntime(
      new EmbedBridgeError(detail.message, code === 'load-timeout' ? 'load-timeout' : 'bridge-timeout'),
    );
    this.#setStatus('error');
    this.#showError(detail);
    this.#emitError(detail);
  }

  #retry(): void {
    if (this.#destroyed) return;
    this.#rebuild();
  }

  #clearLoadTimer(): void {
    if (this.#loadTimer !== null) {
      clearTimeout(this.#loadTimer);
      this.#loadTimer = null;
    }
  }

  #setAutoHeight(height: number): void {
    if (!Number.isFinite(height)) return;
    const clamped = Math.max(MIN_AUTO_HEIGHT, Math.min(MAX_AUTO_HEIGHT, Math.round(height)));
    this.#autoHeight = clamped;
    if (this.#heightValue === 'auto' && this.#stage) {
      this.#stage.style.setProperty('--agil-embed-height', `${clamped}px`);
    }
  }

  /**
   * Same-origin measurement helps `height="auto"`; cross-origin iframes cannot
   * be measured, so they can opt into `agil:resize` messages instead. The
   * fallback is 640px (the element still resizes with `agil:resize`).
   */
  #observeAutoHeight(): void {
    if (this.#heightValue !== 'auto' || !this.#iframe) return;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    let doc: Document | null = null;
    try {
      doc = this.#iframe.contentDocument;
    } catch {
      doc = null;
    }
    if (!doc?.documentElement) return;
    const measure = (): void => {
      const root = doc?.documentElement;
      if (!root) return;
      const height = root.scrollHeight;
      if (height > 0) this.#setAutoHeight(height);
    };
    if (typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(measure);
      this.#resizeObserver.observe(doc.documentElement);
    }
    measure();
  }

  #closeDialogSilently(): void {
    const dialog = this.#dialog;
    if (!dialog) return;
    const isOpen = dialog.open || dialog.hasAttribute('open');
    if (!isOpen) return;
    this.#suppressDialogSync = true;
    try {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    } catch {
      dialog.removeAttribute('open');
    } finally {
      this.#suppressDialogSync = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Events + guard
  // ---------------------------------------------------------------------------

  #emit<K extends keyof AgilCallEventDetailMap>(
    type: K,
    detail: AgilCallEventDetailMap[K],
  ): void {
    this.dispatchEvent(
      new CustomEvent<AgilCallEventDetailMap[K]>(type, {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  #emitError(detail: AgilCallErrorDetail): void {
    // Defense in depth: even if a caller built a detail by hand, strip secrets.
    const safe: AgilCallErrorDetail = {
      ...detail,
      message: redactSecrets(detail.message, this.#secrets()),
    };
    this.#emit('agil-error', safe);
  }

  #assertAlive(): void {
    if (this.#destroyed) {
      throw new EmbedConfigError(this.#strings.destroyed, 'destroyed');
    }
  }
}
