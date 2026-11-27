/**
 * Full-screen widget for the iframe embed mode (`/embed.html`, contract §7).
 *
 * URL: `?server=&room=&token=&tenant=&lang=&theme=light|dark|auto&name=&role=`
 *
 * Two-way postMessage contract:
 *  - in:  `agil:config`, `agil:theme`, `agil:scheme`, `agil:action`, `agil:ping`;
 *  - out: `agil:ready`, `agil:event`, `agil:chat`, `agil:state`, `agil:pong`.
 *
 * Security: the listener accepts messages only from `window.parent` and only
 * from origins listed in `integrations.allowedOrigins` (empty list = same-origin
 * only). Unknown/forbidden actions are answered with
 * `agil:event {event:'action-denied'}`. The page never navigates the top frame
 * and does not use eval/Function, so it works in a sandboxed iframe with
 * `allow-scripts` + `allow-same-origin`.
 */
import type { AgilWidgetInstance, AgilWidgetEvent, CallState } from '@agil/calls-widget';
import { attachWebMcp } from './webmcp.js';

type ParentMessage =
  | { type: 'agil:config'; config: unknown; replace?: boolean }
  | { type: 'agil:theme'; theme: unknown }
  | { type: 'agil:scheme'; scheme: 'light' | 'dark' | 'auto' }
  | { type: 'agil:action'; action: string }
  | { type: 'agil:video-upgrade-response'; requestId: string; accept: boolean }
  | { type: 'agil:chat-send'; text: string }
  | { type: 'agil:simulate-participants'; count?: number; layout?: 'grid' | 'spotlight' | 'sidebar'; controls?: 'bar' | 'island' | 'minimal'; requestId?: string }
  | { type: 'agil:clear-simulated'; requestId?: string }
  | { type: 'agil:ping' }
  | { type: 'agil:pong' };

const params = new URLSearchParams(window.location.search);
const root = document.getElementById('embed-root');
const loading = document.getElementById('embed-loading');
const loadingText = document.getElementById('embed-loading-text');

function param(name: string): string | undefined {
  const value = params.get(name);
  return value && value.trim() ? value.trim() : undefined;
}

function showError(message: string): void {
  if (loadingText) loadingText.textContent = message;
}

function hideLoading(): void {
  loading?.classList.add('is-hidden');
  document.documentElement.style.background = 'transparent';
}

function postToParent(type: string, payload: Record<string, unknown>): void {
  try {
    window.parent.postMessage({ type, ...payload }, '*');
  } catch {
    /* the parent may be cross-origin without postMessage access; ignore */
  }
}

function postEvent(event: string, payload?: unknown): void {
  postToParent('agil:event', { event, payload });
}

function postState(state: CallState): void {
  const participantIds = state.phase === 'left'
    ? []
    : [state.self?.id ?? '', ...state.participants.map((participant) => participant.id)].filter(Boolean);
  const snapshot = {
    phase: state.phase,
    audioOnly: Boolean(state.audioOnly),
    videoUpgrade: state.videoUpgrade ?? null,
    participants: participantIds.length,
    participantIds,
    quality: { tier: state.quality.tier, score: state.quality.score },
    connectionState: state.connection,
    recording: state.recording.active,
    remoteRecording: state.recording.remoteActive,
    minimized: state.settings.minimized,
    chatMode: state.settings.chatMode,
    chrome: state.settings.chrome,
    fullscreen: state.settings.fullscreen,
    layoutMode: state.settings.layoutMode,
    settings: {
      mic: state.settings.micEnabled,
      camera: state.settings.camEnabled,
      screen: state.settings.screenSharing,
      blur: state.settings.blurMode,
      panel: state.settings.panel,
    },
  };
  const signature = JSON.stringify(snapshot);
  if (signature === lastStateSignature) return;
  lastStateSignature = signature;
  postToParent('agil:state', { state: snapshot });
}

const room = param('room');
const serverUrl = param('server') ?? window.location.origin;
const explicitTenantId = param('tenant');
const token = param('token');
const identityToken = param('identity_token') ?? param('id_token');
const participantName = param('name');
const roleParam = param('role');
const role = roleParam === 'host' || roleParam === 'moderator' || roleParam === 'guest' ? roleParam : undefined;
const langParam = param('lang');
const locale = langParam === 'ru' || langParam === 'en' ? langParam : undefined;
const themeParam = param('theme');
const scheme = themeParam === 'light' || themeParam === 'dark' || themeParam === 'auto' ? themeParam : undefined;
const chatParam = param('chat');
const chat = chatParam === 'builtin' || chatParam === 'external' || chatParam === 'hidden' ? chatParam : undefined;
const layoutParam = param('layout');
const chrome = layoutParam === 'full' || layoutParam === 'compact' || layoutParam === 'none' ? layoutParam : undefined;
const resume = param('resume') === '1';

let instance: AgilWidgetInstance | null = null;
let refreshWebMcp: (() => void) | undefined;
let parentPolicy: { enabled: boolean; origins: readonly string[] } | null = null;
let lastStateSignature = '';

/**
 * Paints the iframe page (html + body) with the widget's effective scheme.
 *
 * The widget root fills the iframe, but the page underneath it is still visible
 * while the widget boots and around rounded join/login cards. A light call must
 * therefore get a light page (#f3f6fb) instead of the historical hard-coded
 * #080d16 — and the loading screen needs readable text on that background.
 */
function paintPageBackground(schemeOverride?: 'light' | 'dark' | 'auto'): void {
  const scheme = schemeOverride ?? instance?.getState().settings.scheme ?? 'auto';
  const prefersDark =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const light = scheme === 'light' || (scheme === 'auto' && !prefersDark);
  const color = light ? '#f3f6fb' : '#080d16';
  const resolved = light ? 'light' : 'dark';
  document.documentElement.dataset.embedScheme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.documentElement.style.background = color;
  document.body.style.background = color;
  document.body.style.color = light ? '#0f172a' : '#e2e8f0';
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = color;
}

// Paint before mountWidget so a `?theme=light` iframe never flashes the dark
// page on a dark OS, and the loading screen is readable in both schemes.
paintPageBackground(scheme);

function isAllowedOrigin(origin: string): boolean {
  if (origin === window.location.origin) return true;
  return parentPolicy?.origins.includes(origin) ?? false;
}

function allowedFeature(feature: string): boolean {
  const state = instance?.getState();
  if (!state) return false;
  const permissions = state.permissions;
  if (permissions) return permissions.includes(feature as never);
  const features = state.config.features as unknown as Record<string, boolean>;
  return features[feature] === true;
}

function clickControl(action: string): boolean {
  const button = document.querySelector<HTMLButtonElement>(`[data-agil-action="${action}"]`);
  if (!button || button.disabled || button.style.display === 'none') return false;
  button.click();
  return true;
}

function deny(action: string, reason: string): void {
  postEvent('action-denied', { action, reason });
}

async function handleAction(action: string): Promise<void> {
  if (!instance) {
    deny(action, 'not-ready');
    return;
  }
  switch (action) {
    case 'toggle-mic':
      await instance.toggleMic();
      break;
    case 'toggle-camera':
      await instance.toggleCamera();
      break;
    case 'request-video-upgrade':
      if (!instance.requestVideoUpgrade()) deny(action, 'unavailable');
      break;
    case 'toggle-chat':
      if (!allowedFeature('chat')) deny(action, 'forbidden');
      else if (!clickControl('chat')) deny(action, 'unavailable');
      break;
    case 'share-screen':
      if (!allowedFeature('screenShare')) deny(action, 'forbidden');
      else if (!instance.getState().capabilities.screenShare) deny(action, 'screen-share-unavailable');
      else await instance.toggleScreenShare();
      break;
    case 'blur-on':
      if (!allowedFeature('backgroundBlur') && !allowedFeature('backgroundReplace')) deny(action, 'forbidden');
      else await instance.setBlurMode('blur');
      break;
    case 'blur-off':
      await instance.setBlurMode('off');
      break;
    case 'minimize':
      instance.minimize();
      postToParent('agil:minimized', { minimized: instance.isMinimized() });
      break;
    case 'restore':
      instance.restore();
      postToParent('agil:minimized', { minimized: instance.isMinimized() });
      break;
    case 'pip': {
      const pip = await instance.requestPictureInPicture();
      if (!pip) deny(action, 'picture-in-picture-unavailable');
      break;
    }
    case 'fullscreen':
      if (instance.isFullscreen()) await instance.exitFullscreen();
      else await instance.requestFullscreen();
      postToParent('agil:fullscreen', { fullscreen: instance.isFullscreen() });
      break;
    case 'newtab': {
      const win = instance.openInNewTab();
      if (!win) deny(action, 'popup-blocked');
      break;
    }
    case 'leave':
      instance.leave();
      break;
    default:
      deny(action, 'unknown-action');
      break;
  }
}

function handleParentMessage(event: MessageEvent): void {
  if (event.source !== window.parent) return;
  if (!isAllowedOrigin(event.origin)) {
    postEvent('action-denied', { reason: 'origin', origin: event.origin });
    return;
  }
  const data = event.data as ParentMessage | null;
  if (!data || typeof data !== 'object' || typeof data.type !== 'string' || !data.type.startsWith('agil:')) return;
  if (!instance || !parentPolicy) return;
  const designPreview = params.get('preview') === '1' && window.parent !== window && event.origin === window.location.origin;
  if (!parentPolicy.enabled && !designPreview && data.type !== 'agil:ping' && data.type !== 'agil:pong') {
    deny(data.type === 'agil:action' ? data.action : data.type.slice('agil:'.length), 'bridge-disabled');
    return;
  }
  switch (data.type) {
    case 'agil:config': {
      instance.updateConfig(data.config as never, { replace: data.replace === true && designPreview });
      break;
    }
    case 'agil:theme':
      instance.updateTheme(data.theme as never);
      paintPageBackground();
      break;
    case 'agil:scheme':
      instance.setThemeScheme(data.scheme);
      paintPageBackground();
      break;
    case 'agil:pong':
      break;
    case 'agil:simulate-participants': {
      const layout = data.layout === 'spotlight' || data.layout === 'sidebar' ? data.layout : 'grid';
      const controls = data.controls === 'island' || data.controls === 'minimal' ? data.controls : 'bar';
      if (!designPreview) {
        postToParent('agil:simulate-participants-ack', { ok: false, reason: 'preview-required', requestId: data.requestId });
        break;
      }
      const desired = Math.max(1, Math.min(50, Math.floor(Number(data.count) || 1)));
      instance.simulateParticipants(desired, { layout, controls });
      postToParent('agil:simulate-participants-ack', { ok: true, requestId: data.requestId, count: desired, layout, controls });
      break;
    }
    case 'agil:clear-simulated':
      if (designPreview) {
        instance.clearSimulatedParticipants();
        postToParent('agil:simulate-participants-ack', { ok: true, cleared: true, requestId: data.requestId });
      }
      break;
    case 'agil:action':
      void handleAction(data.action);
      break;
    case 'agil:video-upgrade-response':
      if (typeof data.requestId !== 'string' || typeof data.accept !== 'boolean') {
        deny('video-upgrade-response', 'invalid-payload');
        break;
      }
      void instance.respondToVideoUpgrade(data.requestId, data.accept).then((sent) => {
        if (!sent) deny('video-upgrade-response', 'unavailable');
      });
      break;
    case 'agil:chat-send': {
      const state = instance.getState();
      if (state.settings.chatMode === 'hidden' || !allowedFeature('chat')) {
        deny('chat-send', 'forbidden');
        break;
      }
      void instance.sendChat(typeof data.text === 'string' ? data.text.slice(0, 4000) : '').catch(() => deny('chat-send', 'failed'));
      break;
    }
    case 'agil:ping':
      postToParent('agil:pong', {});
      break;
    default:
      break;
  }
}

function handleWidgetEvent(event: AgilWidgetEvent): void {
  postEvent(event.type, event.payload);
  if (!instance) return;
  if (event.type === 'state' || event.type === 'joined' || event.type === 'left') refreshWebMcp?.();
  const state = instance.getState();
  if (event.type === 'state') postState(state);
  if (event.type === 'theme-changed') paintPageBackground();
  if (event.type === 'minimized-changed') {
    const payload = event.payload as { minimized?: boolean } | undefined;
    postToParent('agil:minimized', { minimized: payload?.minimized ?? state.settings.minimized });
  }
  if (event.type === 'media-state') {
    const payload = event.payload as { fullscreen?: boolean } | undefined;
    if (typeof payload?.fullscreen === 'boolean') postToParent('agil:fullscreen', { fullscreen: payload.fullscreen });
  }
  if (event.type === 'joined') {
    hideLoading();
    document.title = state.room?.name ? `${state.room.name} — AgilFrame` : 'AgilFrame';
  }
  if (event.type === 'left') {
    hideLoading();
  }
}

/**
 * White-label host resolution: `/embed.html` is served by the same origin as
 * `/v1/*`, so the server can map its `Host` to a verified tenant. An explicit
 * `?tenant=` always wins (documented fallback for aliases/CDNs).
 */
async function resolveTenantId(): Promise<string> {
  if (explicitTenantId) return explicitTenantId;
  try {
    const response = await fetch('/v1/host', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) return 'demo';
    const body = (await response.json()) as { tenantId?: unknown; branding?: { productName?: unknown } };
    if (typeof body.branding?.productName === 'string' && body.branding.productName.trim()) {
      const heading = document.querySelector<HTMLElement>('#embed-loading h1');
      if (heading) heading.textContent = body.branding.productName.trim();
    }
    return typeof body.tenantId === 'string' && body.tenantId.trim() ? body.tenantId.trim() : 'demo';
  } catch {
    // Offline/stale proxy: the default tenant keeps the plain AGIL shell alive.
    return 'demo';
  }
}

async function start(): Promise<void> {
  if (!root) return;
  if (locale) document.documentElement.lang = locale;
  if (!room) {
    showError(locale === 'en'
      ? 'Open the full invitation link to join the call.'
      : 'Откройте полную ссылку-приглашение для входа в звонок.');
    postEvent('error', { code: 'bad_request', message: 'room is required' });
    return;
  }
  if (typeof globalThis.structuredClone !== 'function') {
    const message = locale === 'en'
      ? 'Update your browser or Android System WebView to join the call.'
      : 'Обновите браузер или Android System WebView, чтобы войти в звонок.';
    showError(message);
    postEvent('error', { code: 'call_browser_unsupported', message });
    return;
  }
  if (locale === 'en' && loadingText) loadingText.textContent = 'Connecting to the room…';
  window.addEventListener('message', handleParentMessage);
  try {
    const { mountWidget } = await import('@agil/calls-widget');
    const tenantId = await resolveTenantId();
    instance = await mountWidget(root, {
      // painted again after mount, once the effective scheme is known
      serverUrl,
      tenantId,
      room,
      token,
      audioOnly: params.get('audioOnly') === '1' ? true : undefined,
      identityToken,
      participantName,
      role,
      locale,
      theme: scheme ? { scheme } : undefined,
      config: {
        ...(chat ? { session: { chat: { ui: chat } } } : {}),
        ...(chrome || resume ? { layout: { ...(chrome ? { chrome } : {}), ...(resume ? { persistAcrossPages: true } : {}) } } : {}),
      },
      resume,
      iceTransportPolicy: params.get('relay') === '1' ? 'relay' : undefined,
      embedded: true,
      onEvent: (event) => handleWidgetEvent(event),
      onChat: (message) => postToParent('agil:chat', { message }),
    });
    if (params.get('webmcp') === '1') {
      refreshWebMcp = attachWebMcp({ serverUrl, room, readState: () => instance?.getState() });
    }
    paintPageBackground();
    // The widget renders its own join screen; the iframe loader must not stay
    // behind it (it used to show through the transparent join card).
    hideLoading();
    const state = instance.getState();
    // Keep the published bridge policy separate from presentation patches sent by the parent.
    parentPolicy = {
      enabled: state.config.integrations.embedPostMessage,
      origins: [...state.config.integrations.allowedOrigins],
    };
    postToParent('agil:ready', {
      capabilities: {
        media: state.capabilities.media,
        blur: state.capabilities.blur,
        screenShare: state.capabilities.screenShare,
        captions: state.capabilities.captions,
        recording: state.capabilities.recording,
        videoUpgrade: true,
      },
      room,
      server: serverUrl,
    });
    postState(state);
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Не удалось запустить виджет');
    postEvent('error', { code: 'mount_failed', message: error instanceof Error ? error.message : String(error) });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void start());
} else {
  void start();
}
