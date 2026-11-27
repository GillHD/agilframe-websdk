/**
 * Media badge presentation for the call header.
 *
 * Product rule (docs/p2p.md): a direct 1:1 room on the mesh plane is shown as
 * **P2P** — never the technical word "mesh". A grouped mesh call is not a
 * negotiated 1:1 transport, so its badge is hidden instead of claiming P2P.
 * `data-mode` always keeps the technical media mode for tests/debugging;
 * `data-transport` exposes the user-facing transport.
 */
import type { MediaMode } from '../types.js';

export type MediaBadgeKind = 'p2p' | 'sfu' | 'broadcast' | 'mesh';

export interface MediaBadgeInput {
  mediaMode: MediaMode;
  /** `RoomInfo.mode`; undefined before the room info arrives. */
  roomMode?: 'direct' | 'group';
  /** `RoomInfo.maxParticipants` (direct rooms are capped at 2). */
  maxParticipants?: number;
}

export interface MediaBadgeView {
  /** User-facing text (`''` when hidden). */
  text: string;
  /** Stable transport token mirrored to `data-transport`. */
  transport: MediaBadgeKind;
  /** Presentation kind used to pick the i18n title. */
  kind: MediaBadgeKind;
  /** i18n key for the badge title (explains P2P vs server media). */
  titleKey: 'mediaModeP2p' | 'mediaModeSfu' | 'mediaModeBroadcast' | 'mediaModeMesh';
  /** Grouped mesh calls hide the technical badge (QA P3-13). */
  hidden: boolean;
}

const MESH_LIMIT = 2;

/** True for a direct room that is really a 1:1 conversation (not a capped group). */
export function isDirectOneToOne(input: Pick<MediaBadgeInput, 'roomMode' | 'maxParticipants'>): boolean {
  if (input.roomMode !== 'direct') return false;
  return input.maxParticipants === undefined || input.maxParticipants <= MESH_LIMIT;
}

/** Resolves the badge text/transport for the current media plane. */
export function resolveMediaBadge(input: MediaBadgeInput): MediaBadgeView {
  if (input.mediaMode === 'mesh') {
    if (isDirectOneToOne(input)) {
      return { text: 'P2P', transport: 'p2p', kind: 'p2p', titleKey: 'mediaModeP2p', hidden: false };
    }
    return { text: '', transport: 'mesh', kind: 'mesh', titleKey: 'mediaModeMesh', hidden: true };
  }
  if (input.mediaMode === 'sfu') {
    return { text: 'SFU', transport: 'sfu', kind: 'sfu', titleKey: 'mediaModeSfu', hidden: false };
  }
  return { text: 'Broadcast', transport: 'broadcast', kind: 'broadcast', titleKey: 'mediaModeBroadcast', hidden: false };
}
