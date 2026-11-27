// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * `@agil/calls-sdk` — integrator SDK.
 *
 * Browser globals `AgilFrame` and `AGILCalls` (IIFE) and ESM
 * (`dist/agil-calls-sdk.js`). The IIFE build embeds the whole widget and injects
 * its CSS, so a single `<script>` tag is enough.
 *
 * ```html
 * <script src="http://localhost:8787/sdk/agilframe.js"></script>
 * <script>
 *   const call = await AgilFrame.mount('#call', {
 *     serverUrl: 'http://localhost:8787',
 *     room: 'team-sync',
 *     token: '<jwt>',
 *   });
 * </script>
 * ```
 */
import {
  auditTheme,
  generatePalette,
  resolveTheme,
  themePresetNames,
  themePresets,
  type ThemePatch,
  type ThemePresetName,
  type ThemeTokens,
} from '@agil/protocol';
import {
  ensureReadableTheme,
  mountWidget,
  readPersistedSession,
  themeForScheme,
  type AgilCallOptions,
  type AgilPoll,
  type AgilUiMode,
  type AgilWidgetEvent,
  type AgilWidgetEventPayloads,
  type AgilWidgetInstance,
  type CallState,
  type PersistedSession,
} from '@agil/calls-widget';
import widgetCss from '../../widget/src/style.css?inline';
import { compileRoomProfile, createProfileRoom } from './room-profiles.js';
import { makeVoiceChannelSwitcher, type VoiceChannelSwitcher, type VoiceChannelSwitcherOptions } from './voice-channel-switcher.js';

export const version = '0.1.0';

const STYLE_ID = 'agil-calls-widget-styles';

/** Injects the widget CSS once (IIFE bundle is self-contained). */
export function injectStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = widgetCss;
  document.head.appendChild(style);
}

export interface EmbedOptions {
  /** AgilFrame server origin, e.g. `http://localhost:8787`. */
  serverUrl?: string;
  room: string;
  /** Start a direct P2P call with audio only. */
  audioOnly?: boolean;
  token?: string;
  tenantId?: string;
  participantName?: string;
  role?: 'host' | 'moderator' | 'guest';
  locale?: 'ru' | 'en';
  /** Only the scheme is passed through the URL; the full theme comes from the server. */
  theme?: { scheme?: 'light' | 'dark' | 'auto' } | ThemePatch;
  /** iframe sizing attributes. */
  width?: string | number;
  height?: string | number;
  allow?: string;
  title?: string;
  className?: string;
}

export interface EmbedResult {
  /** Ready-to-paste HTML snippet. */
  html: string;
  /** The iframe element (when a DOM is available). */
  iframe: HTMLIFrameElement | null;
  /** The computed embed URL. */
  url: string;
}

function resolveServerUrl(serverUrl?: string): string {
  if (serverUrl && serverUrl.trim()) return serverUrl.trim().replace(/\/+$/, '');
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return 'http://localhost:8787';
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Builds an iframe embed (`/embed.html` + postMessage contract §7). */
export function createEmbed(options: EmbedOptions): EmbedResult {
  const serverUrl = resolveServerUrl(options.serverUrl);
  const url = new URL('/embed.html', `${serverUrl}/`);
  url.searchParams.set('server', serverUrl);
  url.searchParams.set('room', options.room);
  if (options.audioOnly) url.searchParams.set('audioOnly', '1');
  if (options.token) url.searchParams.set('token', options.token);
  if (options.tenantId) url.searchParams.set('tenant', options.tenantId);
  if (options.locale) url.searchParams.set('lang', options.locale);
  if (options.participantName) url.searchParams.set('name', options.participantName);
  if (options.role) url.searchParams.set('role', options.role);
  const scheme = options.theme?.scheme;
  if (scheme) url.searchParams.set('theme', scheme);
  const width = typeof options.width === 'number' ? `${options.width}px` : options.width ?? '100%';
  const height = typeof options.height === 'number' ? `${options.height}px` : options.height ?? '640';
  const title = options.title ?? 'AgilFrame';
  const allow = options.allow ?? 'camera; microphone; display-capture; fullscreen; picture-in-picture; autoplay; clipboard-write; speaker-selection';
  const className = options.className ? ` class="${escapeAttribute(options.className)}"` : '';
  const html = `<iframe${className} src="${escapeAttribute(url.toString())}" title="${escapeAttribute(title)}" width="${escapeAttribute(width)}" height="${escapeAttribute(height)}" style="border:0;width:${escapeAttribute(width)};height:${escapeAttribute(height)};" allow="${escapeAttribute(allow)}" allowfullscreen></iframe>`;

  let iframe: HTMLIFrameElement | null = null;
  if (typeof document !== 'undefined') {
    iframe = document.createElement('iframe');
    iframe.src = url.toString();
    iframe.title = title;
    iframe.width = width;
    iframe.height = height;
    iframe.style.border = '0';
    iframe.style.width = width;
    iframe.style.height = height;
    iframe.allow = allow;
    iframe.allowFullscreen = true;
    if (className) iframe.className = className.slice(7, -1);
  }
  return { html, iframe, url: url.toString() };
}

/**
 * Mounts the widget into an element or CSS selector. Resolves after the join
 * screen is ready; it does not request camera access (that happens on join).
 */
export async function mount(
  container: HTMLElement | string,
  options: AgilCallOptions,
): Promise<AgilWidgetInstance> {
  if (typeof window === 'undefined') {
    throw new Error('AgilFrame.mount() requires a browser environment');
  }
  if (!options || (!options.room && !options.resume)) throw new Error('AgilFrame.mount(): options.room is required');
  let element: HTMLElement | null;
  if (typeof container === 'string') {
    element = document.querySelector<HTMLElement>(container);
    if (!element) throw new Error(`AgilFrame.mount(): container "${container}" was not found`);
  } else {
    element = container;
  }
  if (!element) throw new Error('AgilFrame.mount(): container element is required');
  injectStyles();
  return mountWidget(element, { ...options, room: options.room ?? '' });
}

export function createVoiceChannelSwitcher(container: HTMLElement | string, options: VoiceChannelSwitcherOptions): VoiceChannelSwitcher {
  return makeVoiceChannelSwitcher(mount, container, options);
}

/**
 * Restores a call persisted by `layout.persistAcrossPages` / `persistSession()`
 * on the next page (`AgilFrame.resume('#call')`). Resolves `null` when there is
 * no saved session.
 */
export async function resume(
  container: HTMLElement | string = '#call',
  overrides: Partial<AgilCallOptions> = {},
): Promise<AgilWidgetInstance | null> {
  const saved: PersistedSession | null = readPersistedSession();
  if (!saved) return null;
  return mount(container, { ...overrides, room: overrides.room ?? saved.room, resume: true });
}

/**
 * Builds the deep link to a call (`/embed.html?...`). The join token is
 * short-lived and ends up in the URL: keep TTLs short and avoid logging it.
 */
export function createCallUrl(options: Partial<AgilCallOptions> & { room: string }): string {
  const serverUrl = resolveServerUrl(options.serverUrl);
  const url = new URL('/embed.html', `${serverUrl}/`);
  url.searchParams.set('server', serverUrl);
  url.searchParams.set('room', options.room);
  if (options.audioOnly) url.searchParams.set('audioOnly', '1');
  if (options.token) url.searchParams.set('token', options.token);
  url.searchParams.set('tenant', options.tenantId ?? 'demo');
  if (options.participantName) url.searchParams.set('name', options.participantName);
  if (options.locale) url.searchParams.set('lang', options.locale);
  const scheme = options.theme?.scheme;
  if (scheme) url.searchParams.set('theme', scheme);
  return url.toString();
}

/** Opens a call in a new browser tab; `null` when the popup was blocked. */
export function openCall(options: Partial<AgilCallOptions> & { room: string }): Window | null {
  if (typeof window === 'undefined') return null;
  return window.open(createCallUrl(options), '_blank', 'noopener');
}

export interface PreviewSimulateOptions {
  layout?: 'grid' | 'spotlight';
  controls?: 'bar' | 'island' | 'minimal';
}

/**
 * Design-test helper: sends the simulation command to a same-origin preview
 * iframe (`/embed.html?...&preview=1`). Returns the request id so callers can
 * match `agil:simulate-participants-ack`.
 */
export function previewSimulate(
  target: HTMLIFrameElement | Window,
  count: number,
  options: PreviewSimulateOptions = {},
): string {
  const win = target instanceof HTMLIFrameElement ? target.contentWindow : target;
  if (!win) throw new Error('AgilFrame.previewSimulate(): iframe has no contentWindow');
  const requestId = `sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  win.postMessage(
    { type: 'agil:simulate-participants', count, layout: options.layout ?? 'grid', controls: options.controls ?? 'bar', requestId },
    window.location.origin,
  );
  return requestId;
}

/** Removes simulated participants from a preview iframe. */
export function previewClear(target: HTMLIFrameElement | Window): void {
  const win = target instanceof HTMLIFrameElement ? target.contentWindow : target;
  win?.postMessage({ type: 'agil:clear-simulated' }, window.location.origin);
}

export interface AgilCallsSdk {
  version: string;
  mount: typeof mount;
  previewSimulate: typeof previewSimulate;
  previewClear: typeof previewClear;
  resume: typeof resume;
  createCallUrl: typeof createCallUrl;
  openCall: typeof openCall;
  createEmbed: typeof createEmbed;
  compileRoomProfile: typeof compileRoomProfile;
  createProfileRoom: typeof createProfileRoom;
  createVoiceChannelSwitcher: typeof createVoiceChannelSwitcher;
  injectStyles: typeof injectStyles;
  themePresets: Record<ThemePresetName, ThemeTokens>;
  resolveTheme: typeof resolveTheme;
  themeForScheme: typeof themeForScheme;
  ensureReadableTheme: typeof ensureReadableTheme;
  generatePalette: typeof generatePalette;
  auditTheme: typeof auditTheme;
  presets: readonly ThemePresetName[];
}

export const AGILCalls: AgilCallsSdk = {
  version,
  mount,
  previewSimulate,
  previewClear,
  resume,
  createCallUrl,
  openCall,
  createEmbed,
  compileRoomProfile,
  createProfileRoom,
  createVoiceChannelSwitcher,
  injectStyles,
  themePresets,
  resolveTheme,
  themeForScheme,
  ensureReadableTheme,
  generatePalette,
  auditTheme,
  presets: themePresetNames,
};

export { AGILCalls as AgilFrame };
export { themePresets, resolveTheme, generatePalette, auditTheme, themePresetNames };
export { compileRoomProfile, createProfileRoom };
export type { CreateProfileRoomOptions, ProfileRoomResult, RoomProfileCreateOptions, RoomProfileRef, RoomProfileV1 } from './room-profiles.js';
export type { VoiceChannelGrant, VoiceChannelSession, VoiceChannelSwitcher, VoiceChannelSwitcherOptions } from './voice-channel-switcher.js';
export type {
  AgilCallOptions,
  AgilPoll,
  AgilUiMode,
  AgilWidgetEvent,
  AgilWidgetEventPayloads,
  AgilWidgetInstance,
  CallState,
  PersistedSession,
  ThemePatch,
  ThemePresetName,
  ThemeTokens,
};

declare global {
  interface Window {
    AgilFrame?: AgilCallsSdk;
    AGILCalls?: AgilCallsSdk;
  }
}

if (typeof window !== 'undefined') {
  window.AgilFrame = AGILCalls;
  window.AGILCalls = AGILCalls;
}

export default AGILCalls;
