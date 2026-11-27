/**
 * Large-room gallery maths (200 participants, stage 1).
 *
 * Pure functions shared by the renderer, the controller and the SFU
 * subscription policy. Keeping them DOM-free makes the hardest part of a
 * 200-participant room (which tile is rendered, which video is subscribed)
 * unit-testable without a browser or a LiveKit server.
 *
 * Design constraints:
 *  - one page holds 25–36 tiles including the local self tile;
 *  - only a bounded budget of remote videos is subscribed per page: all visible
 *    videos up to 8 people, then the capacity-profile budget (low 2, standard 6,
 *    high 12 — pinned + active speaker first) for every larger room;
 *  - the profile describes the deployed SFU (`AGIL_SFU_PROFILE` /
 *    `scale.sfu.capacityProfile`); it is a sizing knob, not a product limit;
 *  - the self preview is not an SFU subscription, so a self pin/speaker leaves
 *    the remote slots to remote participants;
 *  - the rest of the page renders avatars with a “play video” affordance that
 *    swaps into the budget (a manual promotion outranks the auto speaker);
 *  - the smaller room and scaling subscription limit is the hard cap;
 *  - audio is never budgeted: every remote participant stays audible.
 */
import {
  DEFAULT_SFU_CAPACITY_PROFILE,
  SFU_CAPACITY_PROFILES,
  resolveSfuCapacityProfile,
  type SfuCapacityProfile,
} from '@agil/protocol';

/** Stage-1 supported room size. Larger rooms are not claimed as supported. */
export const LARGE_ROOM_MAX_PARTICIPANTS = 200;
/** At/above this count the UI shows `200+` instead of a precise number. */
export const LARGE_ROOM_BADGE_THRESHOLD = 200;
/** Five columns on phones (390 px viewport). */
export const LARGE_ROOM_MOBILE_PAGE_TILES = 25;
/** Six columns on desktop. */
export const LARGE_ROOM_DESKTOP_PAGE_TILES = 36;

/** Up to this many participants (including self) every visible remote video is subscribed. */
export const GALLERY_ALL_VIDEOS_MAX_PARTICIPANTS = 8;

/**
 * Remote videos a client subscribes per page above 8 participants, by capacity
 * profile. The numbers live in the protocol table (`SFU_CAPACITY_PROFILES`) so
 * server status/docs and the widget cannot drift:
 *
 * | profile  | SFU sizing        | remote videos/client | participants |
 * |----------|-------------------|----------------------|--------------|
 * | low      | 1–2 vCPU / 2 GB   | 2                    | 25           |
 * | standard | 8–16 vCPU / 16 GB | 6                    | 50           |
 * | high     | 16–32 vCPU / 32 GB| 12                   | 100–200      |
 *
 * The budget is capped by the lower room and scaling limits (default 36) and
 * can be overridden by `limits.galleryVideoBudget` / `scale.maxVisibleVideos`.
 * A 50-video budget per client needs cascading/more SFU nodes, not a profile.
 */
export const GALLERY_VIDEO_BUDGET_BY_PROFILE: Record<SfuCapacityProfile, number> = {
  low: SFU_CAPACITY_PROFILES.low.remoteVideosPerClient,
  standard: SFU_CAPACITY_PROFILES.standard.remoteVideosPerClient,
  high: SFU_CAPACITY_PROFILES.high.remoteVideosPerClient,
};

/** Deployment default when neither env nor tenant config names a profile. */
export const DEFAULT_GALLERY_CAPACITY_PROFILE: SfuCapacityProfile = DEFAULT_SFU_CAPACITY_PROFILE;

export type { SfuCapacityProfile };

/** Remote-video budget for a profile; unknown/unset values use `standard`. */
export function sfuProfileVideoBudget(profile: unknown): number {
  return GALLERY_VIDEO_BUDGET_BY_PROFILE[resolveSfuCapacityProfile(profile)];
}

export type VideoQualityPreference = 'auto' | 'high' | 'medium' | 'low';
export const VIDEO_QUALITY_PREFERENCES: readonly VideoQualityPreference[] = ['auto', 'high', 'medium', 'low'];

export interface GalleryParticipant {
  id: string;
}

/** One page of the remote-participant gallery. */
export interface GalleryPageInfo {
  /** Zero-based, clamped to `0..pageCount-1`. */
  page: number;
  pageCount: number;
  /** Tile budget of a full page (25 or 36). */
  pageSize: number;
  /** Remote tiles per page (the self tile takes one slot when present). */
  remotePageSize: number;
  /** Total remote participants (never includes self). */
  total: number;
  /** `[start, end)` slice indexes into the remote participant list. */
  start: number;
  end: number;
}

/** True for viewports where the phone page size applies. */
export function isNarrowViewport(viewportWidth: number | undefined): boolean {
  return typeof viewportWidth === 'number' && Number.isFinite(viewportWidth) && viewportWidth <= 640;
}

/** 25 tiles on phones, 36 on tablets/desktops. */
export function resolvePageSize(viewportWidth?: number): number {
  return isNarrowViewport(viewportWidth) ? LARGE_ROOM_MOBILE_PAGE_TILES : LARGE_ROOM_DESKTOP_PAGE_TILES;
}

export function resolveRemotePageSize(pageSize: number, hasSelf: boolean): number {
  const safe = Math.max(1, Math.floor(Number.isFinite(pageSize) ? pageSize : LARGE_ROOM_DESKTOP_PAGE_TILES));
  return hasSelf ? Math.max(1, safe - 1) : safe;
}

export function galleryPageCount(total: number, hasSelf: boolean, pageSize: number): number {
  const safeTotal = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  const remotePageSize = resolveRemotePageSize(pageSize, hasSelf);
  return Math.max(1, Math.ceil(safeTotal / remotePageSize));
}

export function clampGalleryPage(page: number, pageCount: number): number {
  const safeCount = Math.max(1, Math.floor(Number.isFinite(pageCount) ? pageCount : 1));
  const safePage = Number.isFinite(page) ? Math.floor(page) : 0;
  return Math.min(Math.max(0, safePage), safeCount - 1);
}

export function galleryPageInfo(total: number, hasSelf: boolean, pageSize: number, page = 0): GalleryPageInfo {
  const safeTotal = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  const safePageSize = Math.max(1, Math.floor(Number.isFinite(pageSize) ? pageSize : LARGE_ROOM_DESKTOP_PAGE_TILES));
  const remotePageSize = resolveRemotePageSize(safePageSize, hasSelf);
  const pageCount = galleryPageCount(safeTotal, hasSelf, safePageSize);
  const clamped = clampGalleryPage(page, pageCount);
  const start = clamped * remotePageSize;
  return {
    page: clamped,
    pageCount,
    pageSize: safePageSize,
    remotePageSize,
    total: safeTotal,
    start,
    end: Math.min(safeTotal, start + remotePageSize),
  };
}

export function pageParticipants<T extends GalleryParticipant>(
  participants: readonly T[],
  info: GalleryPageInfo,
): T[] {
  return participants.slice(info.start, info.end);
}

export function participantPageIndex(index: number, hasSelf: boolean, pageSize: number): number {
  const remotePageSize = resolveRemotePageSize(pageSize, hasSelf);
  const safeIndex = Math.max(0, Math.floor(Number.isFinite(index) ? index : 0));
  return Math.floor(safeIndex / remotePageSize);
}

/** Page that contains a participant id, or `null` when the participant is unknown. */
export function pageForParticipantId(
  participants: readonly GalleryParticipant[],
  participantId: string | null | undefined,
  hasSelf: boolean,
  pageSize: number,
): number | null {
  if (!participantId) return null;
  const index = participants.findIndex((participant) => participant.id === participantId);
  if (index < 0) return null;
  const remotePageSize = resolveRemotePageSize(pageSize, hasSelf);
  return Math.floor(index / remotePageSize);
}

/** `200+` once the room reaches the stage-1 limit (or a larger configured cap). */
export function formatParticipantCount(total: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  return safe >= LARGE_ROOM_BADGE_THRESHOLD ? `${LARGE_ROOM_BADGE_THRESHOLD}+` : String(safe);
}

/** Clamp a video subscription limit to the supported client-side range. */
export function clampVideoSubscriptions(value: unknown, fallback = 36): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1000, Math.max(1, Math.floor(numeric)));
}

export function configuredVideoSubscriptionLimit(roomLimit?: number | null, scaleLimit?: number | null): number {
  return clampVideoSubscriptions(Math.min(roomLimit ?? Infinity, scaleLimit ?? Infinity));
}

export interface GalleryVideoBudgetOptions {
  /** Optional `limits.galleryVideoBudget` override (wins over `maxVisibleVideos`). */
  galleryVideoBudget?: number | null;
  /** Optional `scale.maxVisibleVideos` alias override. */
  maxVisibleVideos?: number | null;
  /** Effective hard cap from the room and scaling settings. */
  maxVideoSubscriptions?: number | null;
  /**
   * Effective deployment capacity profile (`scale.sfu.capacityProfile`, surfaced
   * by the server from `AGIL_SFU_PROFILE`). Unset/invalid = `standard`.
   */
  capacityProfile?: SfuCapacityProfile | string | null;
}

function numericOverride(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Adaptive remote-video budget for a gallery page.
 *
 * - up to 8 participants (including self): all visible videos (the plan can
 *   never subscribe more remotes than exist);
 * - above 8: the capacity-profile budget — `low` 2, `standard` 6, `high` 12 —
 *   selected as pinned → active speaker → promoted → page order;
 * - `limits.galleryVideoBudget` / `scale.maxVisibleVideos` override the
 *   adaptive value (the first one set wins), subject to the effective hard
 *   ceiling (default 36).
 *
 * The budget counts remote videos only: the self preview is separate and is
 * never part of the SFU subscription set. When the pin or the active speaker is
 * the local self tile, that tile does not consume a remote slot, so one more
 * remote participant keeps a video compared with a remote pin + speaker.
 */
export function resolveGalleryVideoBudget(
  participantCount: number,
  options: GalleryVideoBudgetOptions = {},
): number {
  const total = Math.max(0, Math.floor(Number.isFinite(participantCount) ? participantCount : 0));
  const override = numericOverride(options.galleryVideoBudget) ?? numericOverride(options.maxVisibleVideos);
  let budget: number;
  if (override !== null) {
    budget = clampVideoSubscriptions(override);
  } else if (total <= GALLERY_ALL_VIDEOS_MAX_PARTICIPANTS) {
    budget = Math.max(1, total);
  } else {
    budget = sfuProfileVideoBudget(options.capacityProfile);
  }
  const hardCap = numericOverride(options.maxVideoSubscriptions);
  if (hardCap !== null) budget = Math.min(budget, clampVideoSubscriptions(hardCap));
  return Math.max(1, budget);
}

/** Reads the optional overrides from a tenant config without importing the protocol package. */
export function resolveGalleryVideoBudgetForConfig(
  config:
    | {
        limits?: { galleryVideoBudget?: number | null; maxParticipants?: number; maxVideoSubscriptions?: number | null };
        scale?: {
          maxVisibleVideos?: number | null;
          maxVideoSubscriptions?: number | null;
          sfu?: { capacityProfile?: string | null };
        };
      }
    | null
    | undefined,
  participantCount: number,
): number {
  const roomLimit = config?.limits?.maxVideoSubscriptions;
  const scaleLimit = config?.scale?.maxVideoSubscriptions;
  return resolveGalleryVideoBudget(participantCount, {
    galleryVideoBudget: config?.limits?.galleryVideoBudget,
    maxVisibleVideos: config?.scale?.maxVisibleVideos,
    ...(roomLimit != null || scaleLimit != null
      ? { maxVideoSubscriptions: configuredVideoSubscriptionLimit(roomLimit, scaleLimit) }
      : {}),
    capacityProfile: config?.scale?.sfu?.capacityProfile,
  });
}

export interface VideoSubscriptionInput {
  participants: readonly GalleryParticipant[];
  page: number;
  pageSize: number;
  hasSelf: boolean;
  /** Visible remote tiles in the scrolling Web widget, in grid order. */
  viewportIds?: readonly string[];
  /** Pinned participant is always allowed to keep its video. */
  pinnedId?: string | null;
  /** Active speaker, when speaker-follow is enabled. */
  speakerId?: string | null;
  /** Effective hard cap from the room and scaling settings. */
  maxVideoSubscriptions: number;
  /**
   * Manually promoted tiles, newest first. Promoted videos are selected before
   * ordinary page tiles; when the budget is already full the promotion evicts
   * an off-page video first, then the first non-pinned page tile.
   */
  promotedIds?: readonly string[];
  /** `limits.galleryVideoBudget` override (wins over `maxVisibleVideos`). */
  galleryVideoBudget?: number | null;
  /** `scale.maxVisibleVideos` alias override. */
  maxVisibleVideos?: number | null;
  /** Effective capacity profile (`scale.sfu.capacityProfile`); unset = standard. */
  capacityProfile?: SfuCapacityProfile | string | null;
}

export interface VideoSubscriptionPlan {
  page: GalleryPageInfo;
  /**
   * Remote participant ids the grid actually renders on this page. This slice
   * is trimmed to the remote-tile slots (25/36 minus self), so an off-page
   * pinned/speaker tile replaces the last page tile instead of becoming an
   * extra, invisible subscription.
   */
  visible: string[];
  /**
   * Ordered, de-duplicated participant ids to subscribe. Pinned → speaker →
   * promoted (newest first) → page order; never longer than `budget`.
   */
  submit: string[];
  /** Participant ids that lost their video because a protected/promoted video entered the budget. */
  evicted: string[];
  /** Every remote participant: audio is never budgeted, only video is. */
  audio: string[];
  /** Participants whose video is intentionally not subscribed. */
  dropped: string[];
  /** Effective adaptive/override budget, already capped by `maxSubscriptions`. */
  budget: number;
  /** Effective hard cap from the room and scaling settings. */
  maxSubscriptions: number;
}

/** First non-protected video the promotion has to remove (or `null` if the promotion cannot fit). */
function pickPromotionVictim(
  selected: readonly string[],
  options: {
    pageIds: readonly string[];
    pinned: string | null;
    speaker: string | null;
    target: string;
    promoted: readonly string[];
  },
): string | null {
  const pageSet = new Set(options.pageIds);
  // The pin and the tile the user just clicked are protected. The automatic
  // active speaker is deliberately **not** protected: with a tight budget a
  // pinned + speaker pair can fill every slot, and an explicit “play video”
  // click must still swap in (the click outranks the automatic speaker). Older
  // manual promotions are evictable once nothing else is left.
  const protectedIds = new Set([options.pinned, options.target].filter(Boolean) as string[]);
  const promotedSet = new Set(options.promoted);
  // 1. Off-page videos are the least valuable: drop them before any on-page
  // tile, but keep the auto speaker while an ordinary page tile can yield.
  const offPage = selected.find(
    (id) => !pageSet.has(id) && !protectedIds.has(id) && id !== options.speaker,
  );
  if (offPage) return offPage;
  // 2. First ordinary (non-pinned/non-speaker/non-promoted) page tile in page
  // order. This is the design/QA contract: a promotion/pin evicts the first
  // ordinary slot, while manual promotions and the auto speaker outrank it.
  const pageVictim = options.pageIds.find(
    (id) =>
      selected.includes(id) &&
      !protectedIds.has(id) &&
      !promotedSet.has(id) &&
      id !== options.speaker,
  );
  if (pageVictim) return pageVictim;
  // 3. Too many manual promotions: evict the oldest one, never the new target
  // or the pin (the pin can also appear in the promotion history).
  for (let index = options.promoted.length - 1; index >= 0; index -= 1) {
    const id = options.promoted[index];
    if (id && id !== options.target && id !== options.pinned && selected.includes(id)) return id;
  }
  // 4. Last resort: the automatic active speaker. This is what makes
  // “pinned + speaker” → “pinned + clicked tile” work on a tight-budget client;
  // the pinned tile itself is never evicted.
  if (options.speaker && options.speaker !== options.target && selected.includes(options.speaker)) {
    return options.speaker;
  }
  // The budget is entirely pinned; the promotion cannot fit (the click is a
  // no-op) rather than silently dropping the pin.
  return null;
}

/**
 * Chooses the small set of remote videos a client should receive.
 *
 * A page renders all of its tiles, but only the adaptive video budget is
 * subscribed. Pinned and active-speaker participants are selected before
 * ordinary page tiles; a manually promoted tile then enters the set and evicts
 * an off-page video first, otherwise the first ordinary page tile, and finally
 * the automatic speaker (never the pin). The effective subscription
 * cap is applied after the adaptive budget, so a tenant/mesh limit can only
 * lower the result. Audio is **not** part of the video budget: `audio` lists
 * every remote participant.
 */
export function planVideoSubscriptions(input: VideoSubscriptionInput): VideoSubscriptionPlan {
  const page = galleryPageInfo(input.participants.length, input.hasSelf, input.pageSize, input.page);
  const viewport = input.viewportIds;
  const pageIds = viewport ?? pageParticipants(input.participants, page).map((participant) => participant.id);
  const maxSubscriptions = clampVideoSubscriptions(input.maxVideoSubscriptions);
  const totalParticipants = input.participants.length + (input.hasSelf ? 1 : 0);
  const budget = resolveGalleryVideoBudget(totalParticipants, {
    galleryVideoBudget: input.galleryVideoBudget,
    maxVisibleVideos: input.maxVisibleVideos,
    maxVideoSubscriptions: maxSubscriptions,
    capacityProfile: input.capacityProfile,
  });
  const byId = new Map(input.participants.map((participant) => [participant.id, participant] as const));
  const ordered: string[] = [];
  const add = (id: string | null | undefined): void => {
    if (!id || !byId.has(id) || ordered.includes(id)) return;
    ordered.push(id);
  };

  const pinned = input.pinnedId && byId.has(input.pinnedId) ? input.pinnedId : null;
  const speaker = input.speakerId && byId.has(input.speakerId) ? input.speakerId : null;
  if (!viewport || (pinned && viewport.includes(pinned))) add(pinned);
  // Pinned and active speaker are selected before ordinary page tiles: the
  // speaker only yields to an explicit “play video” promotion, never to page
  // order. The self tile is not in `participants`, so a self pin/speaker does
  // not consume a remote slot.
  if (!viewport || (speaker && viewport.includes(speaker))) add(speaker);
  for (const id of pageIds) add(id);

  // The renderer has exactly `remotePageSize` remote slots. Trim the ordered
  // set to that slice *before* applying the subscription budget: a full page
  // plus an off-page pin otherwise plans a video for a tile that is not drawn
  // (Q-4). The renderer consumes the same `visible` slice, so plan and DOM
  // cannot drift.
  const visible = viewport ? ordered : ordered.slice(0, page.remotePageSize);

  // Only tiles that are actually rendered can consume the video budget. An
  // off-page pin displaces the last page slot, so `renderedPageIds` excludes
  // that displaced tile; a promotion for another page stays remembered in
  // state, but is inactive here.
  const visibleSet = new Set(visible);
  const renderedPageIds = pageIds.filter((id) => visibleSet.has(id));
  const promoted = (input.promotedIds ?? []).filter(
    (id): id is string => typeof id === 'string' && visibleSet.has(id) && byId.has(id),
  );

  // Base selection: the first rendered page tiles up to the budget.
  // Pinned/speaker and manual promotions are then inserted; if the budget is
  // full the lowest priority ordinary page tile is evicted (off-page first,
  // then page order), then the auto speaker for an explicit promotion. This
  // makes a pin and a “play video” click use one eviction rule and prevents an
  // off-page pin from silently pushing out only the last page tile.
  const submit: string[] = [];
  for (const id of renderedPageIds) {
    if (submit.length >= budget) break;
    submit.push(id);
  }
  const evicted: string[] = [];
  const insertProtected = (id: string | null | undefined): void => {
    if (!id || !visibleSet.has(id) || submit.includes(id)) return;
    if (submit.length >= budget) {
      const victim = pickPromotionVictim(submit, {
        pageIds: renderedPageIds,
        pinned,
        speaker,
        target: id,
        promoted,
      });
      // A budget fully occupied by the pin/speaker cannot fit the promotion;
      // leave the plan untouched instead of evicting a protected video.
      if (!victim) return;
      submit.splice(submit.indexOf(victim), 1);
      evicted.push(victim);
    }
    submit.push(id);
  };
  insertProtected(pinned);
  insertProtected(speaker);
  for (const id of promoted) insertProtected(id);

  // Stable render/subscription order regardless of the eviction order above.
  const selected = new Set(submit);
  const orderedSubmit: string[] = [];
  const pushOrdered = (id: string | null | undefined): void => {
    if (!id || !selected.has(id) || orderedSubmit.includes(id)) return;
    orderedSubmit.push(id);
  };
  pushOrdered(pinned);
  pushOrdered(speaker);
  for (const id of promoted) pushOrdered(id);
  for (const id of renderedPageIds) pushOrdered(id);

  const selectedSet = new Set(orderedSubmit);
  const dropped = [...byId.keys()].filter((id) => !selectedSet.has(id));
  const audio = [...byId.keys()];
  return {
    page,
    visible,
    submit: orderedSubmit,
    evicted,
    audio,
    dropped,
    budget,
    maxSubscriptions,
  };
}

/** `null` requests return the SDK's adaptive stream dimensions. */
export function videoQualityDimensions(
  preference: VideoQualityPreference,
  role: 'grid' | 'spotlight' = 'grid',
): { width: number; height: number } | null {
  switch (preference) {
    case 'low':
      return { width: 320, height: 180 };
    case 'medium':
      return { width: 640, height: 360 };
    case 'high':
      return { width: 1280, height: 720 };
    case 'auto':
      return role === 'spotlight' ? { width: 1280, height: 720 } : { width: 480, height: 270 };
    default:
      return null;
  }
}

export function normalizeVideoQuality(value: unknown): VideoQualityPreference {
  return value === 'high' || value === 'medium' || value === 'low' || value === 'auto' ? value : 'auto';
}
