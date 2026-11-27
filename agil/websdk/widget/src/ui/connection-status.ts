/**
 * Connection status: one source of truth for the label *and* the colour.
 *
 * Before this module the header pill was assembled from two independent fields:
 * `connectionLabel()` read `state.serverOnline` first (so it could print
 * “Нет соединения”), while `connectionEl.dataset.connection` was written from
 * `state.connection` (so the CSS could colour it success green). The result was
 * a green “offline” pill in every QA screenshot (C-02), and no connection
 * indicator at all on phones.
 *
 * The fix is a single pure projection: `resolveConnectionStatus()` collapses
 * the raw transport fields into exactly one enum value plus the i18n key that
 * describes it. The renderer writes both the text and `data-connection` from
 * the same object, so text and colour cannot disagree again.
 *
 * Enum semantics:
 *   offline      — the API server is unreachable (`serverOnline === false`).
 *                  Always red, never green, even if a stale peer state says
 *                  `connected`.
 *   reconnecting — the socket/peer is trying to come back (continuity lease).
 *                  Amber.
 *   connecting   — initial handshake or a join in flight. Amber.
 *   connected    — the call is usable. Green.
 *   weak         — the call is connected but media quality is poor. Amber.
 */
import type { CallState } from '../types.js';

export type ConnectionStatus = 'offline' | 'connecting' | 'reconnecting' | 'connected' | 'weak';

/** i18n keys that can label the pill. `restored` is the “just resumed” case. */
export type ConnectionLabelKey = ConnectionStatus | 'restored';

export interface ConnectionView {
  /** Written to `data-connection`; the CSS colours the pill/dot from it. */
  readonly status: ConnectionStatus;
  /** Written as the visible text (and `aria-label` on compact mobile dots). */
  readonly labelKey: ConnectionLabelKey;
  /** Human-readable explanation for the `title` attribute. */
  readonly titleKey: ConnectionLabelKey;
}

/** The transport fields the pill actually depends on. */
export interface ConnectionInput {
  serverOnline: boolean;
  connection: CallState['connection'];
  wsState: CallState['wsState'];
  resumeStatus: CallState['resumeStatus'];
  phase: CallState['phase'];
  degraded: boolean;
  /** Remote participant count (self is not counted). */
  remoteCount: number;
}

/** Project a `CallState` onto the fields `resolveConnectionStatus` needs. */
export function connectionInput(state: CallState): ConnectionInput {
  return {
    serverOnline: state.serverOnline,
    connection: state.connection,
    wsState: state.wsState,
    resumeStatus: state.resumeStatus,
    phase: state.phase,
    degraded: state.settings.degraded,
    remoteCount: state.participants.length,
  };
}

const VIEWS: Record<ConnectionLabelKey, ConnectionView> = {
  offline: { status: 'offline', labelKey: 'offline', titleKey: 'offline' },
  connecting: { status: 'connecting', labelKey: 'connecting', titleKey: 'connecting' },
  reconnecting: { status: 'reconnecting', labelKey: 'reconnecting', titleKey: 'reconnecting' },
  connected: { status: 'connected', labelKey: 'connected', titleKey: 'connected' },
  restored: { status: 'connected', labelKey: 'restored', titleKey: 'restored' },
  weak: { status: 'weak', labelKey: 'weak', titleKey: 'weak' },
};

/**
 * Resolve the single connection enum for the header pill.
 *
 * Precedence (highest first):
 *  1. `serverOnline === false` → offline. A call cannot be healthy while the
 *     API server is unreachable; this must win over any peer/socket state.
 *  2. Reconnection or initial handshake.
 *  3. Closed transport → offline.
 *  4. Restored, connected or solo call → weak if media is degraded, otherwise healthy.
 *  5. Anything else is transiently connecting.
 */
export function resolveConnectionStatus(input: ConnectionInput): ConnectionView {
  if (!input.serverOnline) return VIEWS.offline;
  if (input.resumeStatus === 'reconnecting' || input.resumeStatus === 'restoring') return VIEWS.reconnecting;
  if (input.wsState === 'reconnecting' || input.connection === 'reconnecting') return VIEWS.reconnecting;
  if (input.wsState === 'connecting') return VIEWS.connecting;
  if (input.connection === 'offline' || input.connection === 'closed' || input.wsState === 'closed') {
    return VIEWS.offline;
  }
  if (input.resumeStatus === 'restored') return input.degraded ? VIEWS.weak : VIEWS.restored;
  if (input.connection === 'connected') return input.degraded ? VIEWS.weak : VIEWS.connected;
  if (
    input.phase === 'joined' &&
    input.wsState === 'open' &&
    input.remoteCount === 0 &&
    input.connection === 'connecting'
  ) {
    return input.degraded ? VIEWS.weak : VIEWS.connected;
  }
  return VIEWS.connecting;
}

/** CSS token suffix; exposed so tests can assert text/colour always agree. */
export function connectionTone(view: ConnectionView): 'success' | 'warning' | 'danger' {
  switch (view.status) {
    case 'connected':
      return 'success';
    case 'connecting':
    case 'reconnecting':
    case 'weak':
      return 'warning';
    default:
      return 'danger';
  }
}
