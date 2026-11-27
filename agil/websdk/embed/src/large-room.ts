/**
 * Large-room support for the WebView bridge (Stage 3b).
 *
 * The hosted widget's periodic `agil:state` snapshot contains the full
 * `participantIds` array. In a 200-participant room that is ~2 KB of JSON on
 * every change, which is expensive across the React Native bridge and makes
 * hosts re-render the whole list for a single join/leave. This module keeps the
 * canonical participant set in the SDK and exposes it as:
 *
 *  - `snapshot` — the first full set (one message per load, bounded to 200);
 *  - `delta`    — only `added`/`removed` ids for subsequent changes;
 *  - `summary`  — a count-only change when the widget did not send ids.
 *
 *  - A large churn (more than half of the room, at least 32 ids) resolves to a
 *    new `snapshot` so a host can resynchronise without replaying deltas.
 *  - `participantIds` is stripped from the public `state` event; hosts that
 *    need the list consume the `participants` snapshot/delta events.
 *
 * The same algorithm exists in `agil/mobile/react-native/src/large-room.ts` and
 * the native SDKs; keep the constants and event shapes in sync
 * (`agil/core/docs/webview-large-rooms.md`).
 */

/** Stage-1/Stage-3b large-room profile: one room up to 200 participants. */
export const LARGE_ROOM_MAX_PARTICIPANTS = 200;

/** Minimum churn (ids added + removed) before a full snapshot is re-sent. */
export const DEFAULT_PARTICIPANT_RESYNC_MIN = 32;

/** Minimum fraction of the room that must change before a resync snapshot. */
export const DEFAULT_PARTICIPANT_RESYNC_RATIO = 0.5;

const MAX_ID_LENGTH = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface LargeRoomLimits {
  /** Maximum participants tracked for one room; clamped to 2..200 (default 200). */
  maxParticipants?: number;
  /** Minimum churn for a resync snapshot (default 32). */
  resyncMin?: number;
  /** Minimum churn fraction for a resync snapshot (default 0.5). */
  resyncRatio?: number;
}

export interface NormalizedLargeRoomLimits {
  maxParticipants: number;
  resyncMin: number;
  resyncRatio: number;
}

export type ParticipantUpdateKind = 'snapshot' | 'delta' | 'summary';

/** One compact participant update delivered to the host (never 200 ids per tick). */
export interface ParticipantUpdate {
  kind: ParticipantUpdateKind;
  /** Authoritative participant count, including the local participant. */
  count: number;
  /** Monotonic revision, incremented for every emitted update. */
  revision: number;
  /** Ids added in this update (`snapshot`: the full bounded set). */
  added: string[];
  /** Ids removed in this update (`snapshot`/`summary`: empty). */
  removed: string[];
  /** Present for `snapshot`: the full bounded participant id set. */
  ids?: string[];
  /** True when the widget sent more ids than `maxParticipants`. */
  truncated?: boolean;
}

export interface ParticipantInput {
  participantIds?: readonly unknown[] | null;
  count?: unknown;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

/** Normalizes the SDK's large-room limits; never throws (invalid values fall back). */
export function normalizeLargeRoomLimits(limits: LargeRoomLimits = {}): NormalizedLargeRoomLimits {
  return {
    maxParticipants: Math.trunc(
      clampNumber(limits.maxParticipants, LARGE_ROOM_MAX_PARTICIPANTS, 2, LARGE_ROOM_MAX_PARTICIPANTS),
    ),
    resyncMin: Math.trunc(clampNumber(limits.resyncMin, DEFAULT_PARTICIPANT_RESYNC_MIN, 1, 10_000)),
    resyncRatio: clampNumber(limits.resyncRatio, DEFAULT_PARTICIPANT_RESYNC_RATIO, 0, 1),
  };
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return null;
  if (CONTROL_CHARS.test(trimmed)) return null;
  return trimmed;
}

function readCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const integer = Math.trunc(value);
  return integer >= 0 ? integer : null;
}

/**
 * Stateful participant digest. One instance per mount/load; call `reset()` on
 * `onLoadStart` so a reload starts with a fresh snapshot.
 */
export class ParticipantDigest {
  readonly maxParticipants: number;
  readonly resyncMin: number;
  readonly resyncRatio: number;

  #ids = new Set<string>();
  #count = 0;
  #revision = 0;
  #initialized = false;

  constructor(limits: LargeRoomLimits = {}) {
    const normalized = normalizeLargeRoomLimits(limits);
    this.maxParticipants = normalized.maxParticipants;
    this.resyncMin = normalized.resyncMin;
    this.resyncRatio = normalized.resyncRatio;
  }

  get count(): number {
    return this.#count;
  }

  get revision(): number {
    return this.#revision;
  }

  /** Current bounded ids (copy). */
  get ids(): string[] {
    return [...this.#ids];
  }

  reset(): void {
    this.#ids = new Set();
    this.#count = 0;
    this.#revision = 0;
    this.#initialized = false;
  }

  /**
   * Applies one widget snapshot. Returns `null` when nothing meaningful changed
   * (which keeps the bridge silent on unchanged periodic ticks).
   */
  apply(input: ParticipantInput): ParticipantUpdate | null {
    const rawIds = Array.isArray(input.participantIds) ? input.participantIds : null;
    const explicitCount = readCount(input.count);

    if (rawIds === null) {
      if (explicitCount === null) return null;
      if (this.#initialized && explicitCount === this.#count) return null;
      this.#initialized = true;
      this.#count = explicitCount;
      this.#revision += 1;
      return {
        kind: 'summary',
        count: explicitCount,
        revision: this.#revision,
        added: [],
        removed: [],
      };
    }

    let truncated = false;
    const next = new Set<string>();
    for (const raw of rawIds) {
      if (next.size >= this.maxParticipants) {
        truncated = true;
        break;
      }
      const id = normalizeId(raw);
      if (id) next.add(id);
    }
    const count = explicitCount ?? next.size;

    if (!this.#initialized) {
      this.#initialized = true;
      this.#ids = next;
      this.#count = count;
      this.#revision = 1;
      return {
        kind: 'snapshot',
        count,
        revision: 1,
        added: [...next],
        removed: [],
        ids: [...next],
        ...(truncated ? { truncated: true } : {}),
      };
    }

    const added: string[] = [];
    const removed: string[] = [];
    for (const id of next) {
      if (!this.#ids.has(id)) added.push(id);
    }
    for (const id of this.#ids) {
      if (!next.has(id)) removed.push(id);
    }
    const changed = added.length + removed.length;
    if (changed === 0 && count === this.#count && !truncated) return null;

    const baseline = Math.max(this.#ids.size, next.size, 1);
    const resync = changed >= this.resyncMin && changed / baseline >= this.resyncRatio;

    this.#ids = next;
    this.#count = count;
    this.#revision += 1;

    if (resync) {
      return {
        kind: 'snapshot',
        count,
        revision: this.#revision,
        added: [...next],
        removed: [],
        ids: [...next],
        ...(truncated ? { truncated: true } : {}),
      };
    }
    return {
      kind: 'delta',
      count,
      revision: this.#revision,
      added,
      removed,
      ...(truncated ? { truncated: true } : {}),
    };
  }
}

/** Public connection states exposed by the SDK (widget wire values normalized). */
export type AgilConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'offline'
  | 'closed'
  | 'failed'
  | 'unknown';

/** Reconnect state is the same normalized union; kept as a named alias for hosts. */
export type AgilReconnectState = AgilConnectionState;

const CONNECTION_STATES: ReadonlySet<string> = new Set<AgilConnectionState>([
  'idle',
  'connecting',
  'connected',
  'reconnecting',
  'disconnected',
  'offline',
  'closed',
  'failed',
]);

/** Normalizes a widget connection value; unknown values become `unknown`. */
export function normalizeConnectionState(value: unknown): AgilConnectionState | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (CONNECTION_STATES.has(normalized)) return normalized as AgilConnectionState;
  if (normalized === 'open') return 'connected';
  if (normalized === 'connecting' || normalized === 'new') return 'connecting';
  if (normalized === 'reconnecting' || normalized === 'reconnect') return 'reconnecting';
  return 'unknown';
}

/** Compact connection/reconnect update delivered to the host. */
export interface ConnectionUpdate {
  state: AgilReconnectState;
  previous?: AgilReconnectState;
  /** True while the SDK/widget is reconnecting after a drop. */
  reconnecting: boolean;
  /** Reconnect attempt number when the widget reports one. */
  attempt?: number;
  /** Backoff delay in milliseconds when the widget reports one. */
  delayMs?: number;
}

function readNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const integer = Math.trunc(value);
  return integer >= 0 ? integer : undefined;
}

function readReconnectDetails(payload: Record<string, unknown>): {
  attempt?: number;
  delayMs?: number;
} {
  const details: { attempt?: number; delayMs?: number } = {};
  const attempt = readNonNegativeInt(payload['attempt'] ?? payload['reconnectAttempt']);
  const delayMs = readNonNegativeInt(payload['delayMs'] ?? payload['delay']);
  if (attempt !== undefined) details.attempt = attempt;
  if (delayMs !== undefined) details.delayMs = delayMs;
  return details;
}

/**
 * Stateful connection/reconnect digest: emits only on state (or attempt)
 * changes, so a repeating `reconnecting` snapshot does not spam host callbacks.
 */
export class ConnectionDigest {
  #state: AgilReconnectState | null = null;
  #attempt: number | undefined;
  #delayMs: number | undefined;

  get state(): AgilReconnectState | null {
    return this.#state;
  }

  reset(): void {
    this.#state = null;
    this.#attempt = undefined;
    this.#delayMs = undefined;
  }

  apply(input: { state?: unknown; attempt?: unknown; delayMs?: unknown }): ConnectionUpdate | null {
    const state = normalizeConnectionState(input.state);
    if (!state) return null;
    const attempt = readNonNegativeInt(input.attempt);
    const delayMs = readNonNegativeInt(input.delayMs);
    const sameState = state === this.#state;
    const sameDetails = attempt === this.#attempt && delayMs === this.#delayMs;
    if (sameState && sameDetails) return null;
    const previous = this.#state ?? undefined;
    this.#state = state;
    this.#attempt = attempt;
    this.#delayMs = delayMs;
    return {
      state,
      ...(previous ? { previous } : {}),
      reconnecting: state === 'reconnecting',
      ...(attempt !== undefined ? { attempt } : {}),
      ...(delayMs !== undefined ? { delayMs } : {}),
    };
  }
}

/**
 * Removes the full participant array from a state snapshot and replaces it with
 * compact count/revision fields. Never mutates the input.
 */
export function compactCallState(
  state: Record<string, unknown>,
  update: ParticipantUpdate | null,
): Record<string, unknown> {
  const compact: Record<string, unknown> = { ...state };
  delete compact['participantIds'];
  if (update) {
    compact['participantCount'] = update.count;
    compact['participantRevision'] = update.revision;
    compact['participants'] = update.count;
  }
  return compact;
}

/**
 * Maximum ids read from one widget state by {@link extractParticipantIds}.
 *
 * One above the profile cap so the digest can see that the widget sent more ids
 * than `maxParticipants` and set `truncated`. The digest still keeps at most
 * `maxParticipants` ids; this function is only the bridge-side reader.
 */
const PARTICIPANT_ID_PARSE_LIMIT = LARGE_ROOM_MAX_PARTICIPANTS + 1;

/** Reads the untrusted `participantIds` array without the generic 100-item cap. */
export function extractParticipantIds(state: Record<string, unknown>): string[] {
  const raw = state['participantIds'];
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (ids.length >= PARTICIPANT_ID_PARSE_LIMIT) break;
    const id = normalizeId(value);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Connection fields from an `agil:state` snapshot or a `connection-state` event. */
export function readConnectionFields(
  source: Record<string, unknown>,
): { state?: string; attempt?: number; delayMs?: number } {
  const record =
    typeof source['connection'] === 'string' || typeof source['connectionState'] === 'string'
      ? source
      : typeof source['payload'] === 'object' && source['payload'] !== null
        ? (source['payload'] as Record<string, unknown>)
        : source;
  const state =
    typeof record['connection'] === 'string'
      ? record['connection']
      : typeof record['connectionState'] === 'string'
        ? record['connectionState']
        : typeof record['state'] === 'string'
          ? record['state']
          : undefined;
  const { attempt, delayMs } = readReconnectDetails(record);
  return {
    ...(state ? { state } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(delayMs !== undefined ? { delayMs } : {}),
  };
}
