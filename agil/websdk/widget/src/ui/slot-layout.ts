/**
 * Fixed 16:9 slot matrix for the call gallery.
 *
 * Problem this solves: when the grid template depends on the exact participant
 * count, every join/leave re-flows every tile (the measured gallery CLS was
 * 1.55 at 2 people, 1.46 at 4, 0.47 at 8 and 1.05 at 25). The chrome was already
 * stable; only the tile grid moved.
 *
 * The matrix is therefore reserved per *bucket*, not per count:
 *
 * | Participants | Slots | Capacity |
 * |---|---|---|
 * | 1–4 | 2×2 | 4 |
 * | 5–9 | 3×3 | 9 |
 * | 10–16 | 4×4 | 16 |
 * | 17–25 | 5×5 | 25 |
 * | 26–36 | 6×6 | 36 |
 *
 * Tiles keep their reading-order slot; unused slots render as neutral, empty
 * placeholders (never fake participants). A join inside a bucket only replaces
 * one empty slot with a tile of exactly the same box, so no existing tile
 * moves or resizes. Crossing into the next bucket is the one accepted shift.
 *
 * `fitSlotMatrix` is the second half of the contract: it fits a 16:9 tile into
 * the available cell (width- or height-constrained), centres the whole matrix
 * in the stage and guarantees that the block never overflows.
 */

export interface SlotBucket {
  /** First participant count (inclusive). */
  readonly min: number;
  /** Last participant count (inclusive). */
  readonly max: number;
  /** Slots per row. */
  readonly columns: number;
  /** Slot rows. */
  readonly rows: number;
  /** `columns * rows`; every bucket is a square. */
  readonly capacity: number;
}

/** The five reservation buckets. Keep in sync with `.agil-grid[data-slot-layout]`. */
export const SLOT_BUCKETS: readonly SlotBucket[] = [
  { min: 1, max: 4, columns: 2, rows: 2, capacity: 4 },
  { min: 5, max: 9, columns: 3, rows: 3, capacity: 9 },
  { min: 10, max: 16, columns: 4, rows: 4, capacity: 16 },
  { min: 17, max: 25, columns: 5, rows: 5, capacity: 25 },
  { min: 26, max: 36, columns: 6, rows: 6, capacity: 36 },
] as const;

/** Largest supported page/bucket (6×6). */
export const SLOT_MAX_TILES = 36;

/** One grid child, in DOM order. */
export type SlotKind = 'tile' | 'empty';

export interface SlotLayout {
  readonly bucket: SlotBucket;
  readonly columns: number;
  readonly rows: number;
  readonly capacity: number;
  /** Tiles actually rendered on this page (0..capacity). */
  readonly tiles: number;
  /** Neutral placeholder cells (capacity - tiles). */
  readonly empty: number;
  /**
   * `true` on narrow (phone/tablet) stages: tiles fill their cell instead of
   * being forced into a centred 16:9 box. A 16:9 matrix on a 390 px portrait
   * stage left each 25-person tile 70 px wide (names `Б…`, C-01) and wasted
   * 285 px of vertical stage; filling the cell gives 90×90 px tiles whose
   * names fit at 11–12 px.
   */
  readonly fill: boolean;
  /**
   * `true` only for the compact phone/tablet matrix. CSS uses it to switch
   * dense-tile typography; a desktop solo call also `fill`s but is not compact.
   */
  readonly compact: boolean;
  /**
   * The grid children in DOM order: `tiles` real slots followed by `empty`
   * placeholders. The renderer consumes this array directly, so slot math and
   * DOM count cannot drift.
   */
  readonly slots: readonly SlotKind[];
}

/** Viewport box available to the slot matrix (already minus grid padding). */
export interface CompactSlotBox {
  width: number;
  height: number;
  gap: number;
}

/** Phones cannot fit more than four readable columns. */
export const COMPACT_SLOT_MAX_COLUMNS_PHONE = 4;
/** Tablets/landscape phones may use up to six columns. */
export const COMPACT_SLOT_MAX_COLUMNS_TABLET = 6;
/** At/below this width the compact (fill) matrix replaces the 16:9 buckets. */
export const COMPACT_SLOT_MAX_VIEWPORT = 900;

/**
 * Column candidates for a compact matrix. A 390 px phone never gets the five
 * 70 px columns that made names illegible; a 768 px tablet may use five or six
 * because its cells are still 120–150 px wide.
 */
function compactColumnCandidates(width: number): number[] {
  const max = width >= 600 ? COMPACT_SLOT_MAX_COLUMNS_TABLET : COMPACT_SLOT_MAX_COLUMNS_PHONE;
  return Array.from({ length: max }, (_, index) => index + 1);
}

/**
 * Target tile aspect for the compact matrix. Portrait stages get near-square
 * cells (a 0.57 sliver crops a 16:9 camera to 32 % of its width), landscape
 * stages get gentle landscape cells that keep names on one line.
 */
const COMPACT_TARGET_ASPECT_PORTRAIT = 0.95;
const COMPACT_TARGET_ASPECT_LANDSCAPE = 1.6;

/**
 * Deterministic matrix for narrow stages.
 *
 * Every column candidate 1..max is scored as `area / (1 + |ln(aspect / target)|)`:
 * a cell that is much wider or much taller than the target loses value even if
 * it is larger, so the result is never a single column of 3.6:1 strips on a
 * tablet or a row of 0.28:1 slivers on a phone. Concretely:
 *
 * | tiles @ 390×663 | result |
 * |---|---|
 * | 2 | 1×2 (378×328) |
 * | 4 | 2×2 (186×328) |
 * | 8 | 2×4 (186×161) |
 * | 25 | 4×7 (90×90) — never five 70 px columns |
 * | 36 | 4×9 (90×68) |
 */
export function compactSlotLayout(tileCount: number, box: CompactSlotBox): SlotLayout {
  const tiles = Math.min(normalizeTileCount(tileCount), SLOT_MAX_TILES);
  const width = Math.max(0, Number.isFinite(box.width) ? box.width : 0);
  const height = Math.max(0, Number.isFinite(box.height) ? box.height : 0);
  const gap = Number.isFinite(box.gap) && box.gap > 0 ? box.gap : 0;
  const target = height >= width ? COMPACT_TARGET_ASPECT_PORTRAIT : COMPACT_TARGET_ASPECT_LANDSCAPE;
  const candidates = compactColumnCandidates(width).map((columns) => {
    const rows = Math.max(1, Math.ceil(tiles / columns));
    const tileWidth = Math.max(0, (width - gap * (columns - 1)) / columns);
    const tileHeight = Math.max(0, (height - gap * (rows - 1)) / rows);
    const aspect = tileHeight > 0 ? tileWidth / tileHeight : 1;
    const area = tileWidth * tileHeight;
    // ln-distance to the target aspect, mapped into (0, 1].
    const aspectFactor = 1 / (1 + Math.abs(Math.log(aspect > 0 ? aspect / target : 1)));
    return { columns, rows, area, score: area * aspectFactor };
  });
  let chosen = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.score > chosen.score * 1.02) chosen = candidate;
  }
  const capacity = chosen.columns * chosen.rows;
  return {
    bucket: slotBucketFor(tiles),
    columns: chosen.columns,
    rows: chosen.rows,
    capacity,
    tiles,
    empty: capacity - tiles,
    fill: true,
    compact: true,
    slots: [
      ...Array.from({ length: tiles }, (): SlotKind => 'tile'),
      ...Array.from({ length: capacity - tiles }, (): SlotKind => 'empty'),
    ],
  };
}

/** Clamp a participant/tile count to a finite non-negative integer. */
export function normalizeTileCount(tileCount: number): number {
  if (!Number.isFinite(tileCount)) return 0;
  return Math.min(SLOT_MAX_TILES, Math.max(0, Math.floor(tileCount)));
}

/** Bucket that reserves space for `tileCount` visible tiles. */
export function slotBucketFor(tileCount: number): SlotBucket {
  const safe = normalizeTileCount(tileCount);
  for (const bucket of SLOT_BUCKETS) {
    if (safe <= bucket.max) return bucket;
  }
  return SLOT_BUCKETS[SLOT_BUCKETS.length - 1]!;
}

/**
 * Slot matrix for a page. Counts above 36 clamp to the 6×6 bucket; an empty
 * page still reserves the 2×2 matrix (the grid is hidden when not joined, so
 * this is only a defensive path).
 *
 * Two counts are deliberately *not* bucket-shaped (C-15):
 *  - 1 participant fills the stage (a full-bleed self view, never a 16:9 card
 *    lost in three empty cells);
 *  - 2 participants are a centred 16:9 pair (2×1). The 2×2 bucket used to put
 *    the pair in the top row and leave two 636×358 empty cells underneath —
 *    the “50 % empty stage” the design review flagged as an unfinished scene.
 */
export function slotLayout(tileCount: number): SlotLayout {
  const tiles = Math.min(normalizeTileCount(tileCount), SLOT_MAX_TILES);
  if (tiles <= 2) {
    const columns = Math.max(1, tiles);
    return {
      bucket: slotBucketFor(tiles),
      columns,
      rows: 1,
      capacity: Math.max(1, tiles),
      tiles,
      empty: 0,
      fill: tiles <= 1,
      compact: false,
      slots: Array.from({ length: Math.max(1, tiles) }, (): SlotKind => 'tile'),
    };
  }
  const bucket = slotBucketFor(tiles);
  const empty = bucket.capacity - tiles;
  const slots: SlotKind[] = [
    ...Array.from({ length: tiles }, (): SlotKind => 'tile'),
    ...Array.from({ length: empty }, (): SlotKind => 'empty'),
  ];
  return {
    bucket,
    columns: bucket.columns,
    rows: bucket.rows,
    capacity: bucket.capacity,
    tiles,
    empty,
    fill: false,
    compact: false,
    slots,
  };
}

/**
 * The layout the renderer should use for a page at a given viewport width.
 *
 * `viewportWidth <= COMPACT_SLOT_MAX_VIEWPORT` → compact fill matrix (4 columns
 * on a phone, up to 6 on a tablet); wider stages keep the 16:9 bucket matrix,
 * so the desktop 25/36-person composition is unchanged.
 */
export function resolveSlotLayout(
  tileCount: number,
  viewportWidth: number | undefined,
  box: CompactSlotBox,
): SlotLayout {
  if (typeof viewportWidth !== 'number' || !Number.isFinite(viewportWidth)) return slotLayout(tileCount);
  if (viewportWidth > COMPACT_SLOT_MAX_VIEWPORT) return slotLayout(tileCount);
  return compactSlotLayout(tileCount, box);
}

/** Convenience: neutral placeholder count for a page. */
export function emptySlotCount(tileCount: number): number {
  return slotLayout(tileCount).empty;
}

/**
 * How close a stage must be to 16:9 before the exact 16:9 bucket matrix is used.
 * Everything else fills the host card: a 680×716 / 1440×900 embedded card is
 * not 16:9 and a centred 16:9 block would leave a letterbox band above/below
 * the video — the “black strip” the embedded call redesign removes.
 */
export const EMBEDDED_SLOT_ASPECT_TOLERANCE = 0.08;

/** True when `width / height` is within the tolerance of a 16:9 surface. */
export function isSixteenByNineBox(width: number, height: number): boolean {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  if (safeWidth <= 0 || safeHeight <= 0) return false;
  return Math.abs(safeWidth / safeHeight - 16 / 9) <= EMBEDDED_SLOT_ASPECT_TOLERANCE;
}

/**
 * Slot matrix for the embedded desktop call (embedded call, `chrome:'none'`, dock).
 *
 * The dock floats over the video, so the stage is the whole call surface:
 *  - an exactly 16:9 host card keeps the documented 16:9 bucket matrix;
 *  - any other host aspect (16:10, a 680 px card that is taller than 16:9,
 *    1440×900 edge-to-edge) fills its cells with `object-fit:cover` instead of
 *    centring a 16:9 block inside a non-16:9 card, which would show black bars
 *    above/below the video;
 *  - 1–2 participants keep the existing full-bleed / 16:9-pair compositions,
 *    where the pair is deliberately a centred cinematic box rather than two
 *    stretched portrait panes.
 */
export function embeddedSlotLayout(tileCount: number, box: CompactSlotBox): SlotLayout {
  const tiles = normalizeTileCount(tileCount);
  if (tiles <= 2) return slotLayout(tiles);
  if (isSixteenByNineBox(box.width, box.height)) return slotLayout(tiles);
  return compactSlotLayout(tiles, box);
}

export interface SlotFitInput {
  columns: number;
  rows: number;
  /** Inner width available to the matrix (stage minus grid padding). */
  width: number;
  /** Inner height available to the matrix (stage minus grid padding). */
  height: number;
  /** Uniform gap between slots, in CSS pixels. */
  gap: number;
  /**
   * Compact matrices fill their cell (no 16:9 letterbox). The block then covers
   * the stage exactly instead of leaving a 200–300 px empty band on a phone.
   */
  fill?: boolean;
}

export interface SlotFit {
  readonly columns: number;
  readonly rows: number;
  /** Exact 16:9 tile box. */
  readonly tileWidth: number;
  readonly tileHeight: number;
  /** Whole matrix box, including gaps (never larger than width/height input). */
  readonly blockWidth: number;
  readonly blockHeight: number;
}

const TILE_ASPECT = 16 / 9;

function positiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.max(1, Math.floor(value));
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Fit a rows×columns matrix of 16:9 tiles into `width`×`height`, keeping the
 * tiles undistorted. Width and height constraints are both honoured, so the
 * matrix is either width-limited (landscape) or height-limited (square/tall
 * stages) and never overflows. The caller centres the returned block.
 */
export function fitSlotMatrix(input: SlotFitInput): SlotFit {
  const columns = positiveInteger(input.columns, 2);
  const rows = positiveInteger(input.rows, 2);
  const gap = nonNegative(input.gap);
  const width = Math.max(0, nonNegative(input.width) - gap * (columns - 1));
  const height = Math.max(0, nonNegative(input.height) - gap * (rows - 1));
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const tileWidth = input.fill
    ? Math.max(0, cellWidth)
    : Math.max(0, Math.min(cellWidth, cellHeight * TILE_ASPECT));
  const tileHeight = input.fill ? Math.max(0, cellHeight) : tileWidth / TILE_ASPECT;
  return {
    columns,
    rows,
    tileWidth,
    tileHeight,
    blockWidth: tileWidth * columns + gap * (columns - 1),
    blockHeight: tileHeight * rows + gap * (rows - 1),
  };
}
