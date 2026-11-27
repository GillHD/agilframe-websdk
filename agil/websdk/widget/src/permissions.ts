/**
 * Permission helpers (contract §18).
 *
 * `welcome.self.permissions` / `JoinRoomResponse.permissions` are the single
 * source of truth for what the UI may show. Until the join response arrives
 * (join screen / offline mode) we fall back to the local `resolveAccess`
 * resolution over the tenant config, so demo mode behaves the same way.
 */
import { resolveAccess, type FeatureKey, type Role, type TenantConfig } from '@agil/protocol';
import type { CallState, ChatMode } from './types.js';

export function resolveLocalPermissions(config: CallState['config'], role: Role): FeatureKey[] {
  try {
    return resolveAccess({ config, role }).allowed;
  } catch {
    return (Object.keys(config.features) as FeatureKey[]).filter((key) => config.features[key]);
  }
}

/** True when the current participant may use a feature. */
export function canFeature(state: CallState, feature: FeatureKey): boolean {
  if (feature === 'screenShare' && (!state.config.features.screenShare || !state.config.session.screenShare.enabled)) return false;
  if ((feature === 'participantList' || feature === 'chat') && !state.config.features[feature]) return false;
  if (state.permissions) return state.permissions.includes(feature);
  return state.config.features[feature] === true;
}

export function canSendChat(state: CallState): boolean {
  return canFeature(state, 'chat') && (state.self?.role !== 'guest' || state.config.security.guestCanChat);
}

/** True for at least one of the given features. */
export function canAny(state: CallState, features: FeatureKey[]): boolean {
  return features.some((feature) => canFeature(state, feature));
}

export function isPresenter(role: Role | undefined): boolean {
  return role === 'host' || role === 'moderator';
}

export function canInviteFromCall(state: CallState): boolean {
  return state.phase === 'joined' && isPresenter(state.self?.role)
    && canFeature(state, 'inviteLink') && state.room?.locked !== true;
}

/**
 * Resolves what the widget should render for chat (contract §22.1 + providers §23).
 *
 * - `providers.chat.mode='disabled'` → chat is hidden entirely;
 * - an explicit `session.chat.ui` (from the server config or a local
 *   `options.config` override) always wins;
 * - `providers.chat.mode='external'` (company messenger) defaults the widget to
 *   the external UI: no built-in panel, messages are handed to the host;
 * - otherwise the built-in chat panel is rendered.
 */
export function resolveChatUi(config: TenantConfig, explicitUi?: ChatMode | null): ChatMode {
  const providerMode = config.providers?.chat?.mode ?? 'builtin';
  if (providerMode === 'disabled') return 'hidden';
  if (explicitUi) return explicitUi;
  const ui = (config.session.chat?.ui ?? 'builtin') as ChatMode;
  if (ui === 'external' || ui === 'hidden') return ui;
  if (providerMode === 'external') return 'external';
  return 'builtin';
}
