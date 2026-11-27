// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * `@agil/calls-embed` — framework-agnostic `<agil-call>` Web Component.
 *
 * ```html
 * <script src="https://cdn.example.com/agil-call-embed.iife.js"></script>
 * <agil-call
 *   server-url="https://calls.example.com"
 *   room="team-sync"
 *   token="<short-lived-jwt>"
 *   theme="auto"
 *   language="en"
 *   height="640px"
 * ></agil-call>
 * ```
 *
 * The ESM build auto-registers the element in browsers. Importing in Node/SSR
 * is safe: registration is skipped when `customElements` is unavailable.
 */
import { AgilCallElement, AGIL_CALL_ATTRIBUTES, AGIL_CALL_TAG } from './element.js';
import type {
  AgilCallErrorDetail,
  AgilChatDetail,
  AgilCallStateDetail,
  AgilConnectionDetail,
  AgilFullscreenDetail,
  AgilGenericEventDetail,
  AgilLifecycleDetail,
  AgilMinimizedDetail,
  AgilParticipantsDetail,
  AgilReadyDetail,
} from './types.js';

export { AgilCallElement, AGIL_CALL_ATTRIBUTES, AGIL_CALL_TAG };
export type { AgilCallAttribute } from './element.js';

export {
  Bridge,
  AGIL_ACTIONS,
  parseWidgetMessage,
  sanitizeBridgePayload,
} from './bridge.js';
export type {
  AgilAction,
  BridgeContentWindow,
  BridgeErrorInfo,
  BridgeIframe,
  BridgeOptions,
  BridgeReadyPayload,
  BridgeWindow,
  HostCommand,
  SanitizeLimits,
  WidgetMessage,
} from './bridge.js';

export {
  EmbedConfigError,
  EmbedBridgeError,
  publicMessage,
  redactSecrets,
  toPublicError,
} from './errors.js';
export type { EmbedErrorCode } from './errors.js';

export {
  buildEmbedUrl,
  isLoopbackHost,
  normalizeServerUrl,
  resolveWidgetUrl,
  DEFAULT_HEIGHT,
  DEFAULT_WIDGET_PATH,
} from './url.js';
export type { BuildEmbedUrlOptions, EmbedTarget } from './types.js';

export {
  isAllowedOrigin,
  parseAllowedOrigins,
  parseOrigin,
  tryParseOrigin,
} from './origin.js';
export {
  ConnectionDigest,
  DEFAULT_PARTICIPANT_RESYNC_MIN,
  DEFAULT_PARTICIPANT_RESYNC_RATIO,
  LARGE_ROOM_MAX_PARTICIPANTS,
  ParticipantDigest,
  compactCallState,
  extractParticipantIds,
  normalizeConnectionState,
  normalizeLargeRoomLimits,
  readConnectionFields,
} from './large-room.js';
export type {
  AgilConnectionState,
  AgilReconnectState,
  ConnectionUpdate,
  LargeRoomLimits,
  NormalizedLargeRoomLimits,
  ParticipantInput,
  ParticipantUpdate,
  ParticipantUpdateKind,
} from './large-room.js';
export { stringsFor } from './i18n.js';
export type { EmbedStrings } from './i18n.js';

export type {
  AgilCallErrorCode,
  AgilCallErrorDetail,
  AgilCallEventDetailMap,
  AgilCallState,
  AgilCallStatus,
  AgilCapabilities,
  AgilChatDetail,
  AgilChatMessage,
  AgilConnectionDetail,
  AgilFullscreenDetail,
  AgilGenericEventDetail,
  AgilLanguage,
  AgilLifecycleDetail,
  AgilLimits,
  AgilMinimizedDetail,
  AgilParticipantsDetail,
  AgilReadyDetail,
  AgilRole,
  AgilThemePatch,
  AgilThemeScheme,
  AgilThemeSetting,
  AgilToggleDetail,
} from './types.js';

export const version = '0.1.0';

/**
 * Registers `<agil-call>` (or a custom tag name) exactly once.
 * Safe to call repeatedly and safe during SSR (no-op without `customElements`).
 */
export function defineAgilCall(
  tagName: string = AGIL_CALL_TAG,
): typeof AgilCallElement | undefined {
  if (typeof customElements === 'undefined') return undefined;
  if (!tagName || !tagName.includes('-')) {
    throw new Error('agil-call: custom element names must contain a hyphen');
  }
  const existing = customElements.get(tagName);
  if (existing) return existing as typeof AgilCallElement;
  customElements.define(tagName, AgilCallElement);
  return AgilCallElement;
}

// Registering on import is what makes the IIFE/script-tag build a one-liner.
if (typeof window !== 'undefined' && typeof customElements !== 'undefined') {
  defineAgilCall();
}

declare global {
  interface HTMLElementTagNameMap {
    'agil-call': AgilCallElement;
  }
  interface HTMLElementEventMap {
    'agil-ready': CustomEvent<AgilReadyDetail>;
    'agil-joined': CustomEvent<AgilLifecycleDetail>;
    'agil-left': CustomEvent<AgilLifecycleDetail>;
    'agil-chat': CustomEvent<AgilChatDetail>;
    'agil-state': CustomEvent<AgilCallStateDetail>;
    'agil-participants': CustomEvent<AgilParticipantsDetail>;
    'agil-connection': CustomEvent<AgilConnectionDetail>;
    'agil-minimized': CustomEvent<AgilMinimizedDetail>;
    'agil-fullscreen': CustomEvent<AgilFullscreenDetail>;
    'agil-event': CustomEvent<AgilGenericEventDetail>;
    'agil-error': CustomEvent<AgilCallErrorDetail>;
  }
}
