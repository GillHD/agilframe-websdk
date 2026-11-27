/**
 * Headless stroke model for the whiteboard and screen-share annotations.
 *
 * The model owns normalized geometry, local optimistic strokes, server
 * reconciliation and the same memory caps the server enforces. It has **no DOM
 * dependency**, so it can be unit-tested in Node (see `test/whiteboard.test.ts`
 * in the widget package) and reused by both surfaces.
 *
 * Coordinates are `0..1` on both axes; `width` is normalized to the surface
 * height. Rendering (`ui/whiteboard-canvas.ts`) maps points to pixels.
 */
import {
  MAX_ANNOTATION_POINTS_PER_STROKE,
  MAX_ANNOTATION_STROKE_BYTES,
  MAX_ANNOTATION_STROKES,
  MAX_ANNOTATION_TOTAL_POINTS,
  MAX_WHITEBOARD_POINTS_PER_STROKE,
  MAX_WHITEBOARD_STROKE_BYTES,
  MAX_WHITEBOARD_STROKES,
  MAX_WHITEBOARD_TOTAL_POINTS,
  WHITEBOARD_DEFAULT_COLOR,
  WHITEBOARD_DEFAULT_WIDTH,
  normalizeWhiteboardPoint,
  strokePointsBytes,
  type AnnotationSnapshot,
  type AnnotationStroke,
  type ClientMessage,
  type WhiteboardPoint,
  type WhiteboardSnapshot,
  type WhiteboardStroke,
} from '@agil/protocol';

export type StrokeSurface = 'whiteboard' | 'annotation';
export type DrawTool = 'pen' | 'eraser';

export interface StrokeAuthor {
  id: string;
  name: string;
}

/** A stroke as rendered locally (server fields filled once acknowledged). */
export interface LocalStroke {
  id: string;
  tool: DrawTool;
  color: string;
  width: number;
  points: WhiteboardPoint[];
  authorId: string;
  authorName: string;
  /** Drawn locally, not acknowledged by the server yet (offline demo keeps these). */
  pending: boolean;
  ts: number;
}

export interface StrokeLayerLimits {
  maxStrokes: number;
  maxPointsPerStroke: number;
  maxStrokeBytes: number;
  maxTotalPoints: number;
}

export const WHITEBOARD_LIMITS: StrokeLayerLimits = {
  maxStrokes: MAX_WHITEBOARD_STROKES,
  maxPointsPerStroke: MAX_WHITEBOARD_POINTS_PER_STROKE,
  maxStrokeBytes: MAX_WHITEBOARD_STROKE_BYTES,
  maxTotalPoints: MAX_WHITEBOARD_TOTAL_POINTS,
};

export const ANNOTATION_LIMITS: StrokeLayerLimits = {
  maxStrokes: MAX_ANNOTATION_STROKES,
  maxPointsPerStroke: MAX_ANNOTATION_POINTS_PER_STROKE,
  maxStrokeBytes: MAX_ANNOTATION_STROKE_BYTES,
  maxTotalPoints: MAX_ANNOTATION_TOTAL_POINTS,
};

/** Minimum distance between recorded samples (normalized units). */
const MIN_POINT_DISTANCE = 0.0008;
/**
 * How long an unacknowledged local stroke survives a room snapshot. Long enough
 * for a retry/reconnect, short enough that a stroke the server rejected cannot
 * linger as a ghost forever.
 */
const PENDING_TTL_MS = 15_000;

let strokeCounter = 0;

/** Unique-enough client stroke id (dedupe key for retries/echoes). */
export function newStrokeId(prefix: string): string {
  strokeCounter += 1;
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}-${Date.now().toString(36)}-${strokeCounter.toString(36)}-${random}`;
}

/** Maps normalized points to pixel coordinates for a surface of `width`×`height`. */
export function strokeGeometry(
  stroke: Pick<LocalStroke, 'points' | 'width'>,
  width: number,
  height: number,
): { points: Array<{ x: number; y: number }>; lineWidth: number } {
  const points = stroke.points.map((point) => ({ x: point.x * width, y: point.y * height }));
  // Keep hairlines visible on phones: at least 1 CSS px, at most 28% of the
  // surface height (a fat marker on a tiny stage must not cover everything).
  const lineWidth = Math.min(height * 0.28, Math.max(1, stroke.width * height));
  return { points, lineWidth };
}

export class StrokeLayer {
  readonly surface: StrokeSurface;
  readonly limits: StrokeLayerLimits;
  private strokes: LocalStroke[] = [];
  private seq = 0;
  /** Board open state (whiteboard) / presenter id (annotations). */
  open = false;
  locked = false;
  presenterId: string | null = null;
  revision = 0;

  constructor(surface: StrokeSurface, limits: StrokeLayerLimits) {
    this.surface = surface;
    this.limits = limits;
  }

  /** Confirmed + pending strokes in drawing order (do not mutate). */
  get items(): readonly LocalStroke[] {
    return this.strokes;
  }

  get length(): number {
    return this.strokes.length;
  }

  get confirmedCount(): number {
    return this.strokes.filter((stroke) => !stroke.pending).length;
  }

  get totalPoints(): number {
    let total = 0;
    for (const stroke of this.strokes) total += stroke.points.length;
    return total;
  }

  hasContent(): boolean {
    return this.strokes.length > 0;
  }

  /** Starts a local stroke; it is visible immediately (optimistic drawing). */
  begin(tool: DrawTool, color: string, width: number, author: StrokeAuthor): LocalStroke {
    const stroke: LocalStroke = {
      id: newStrokeId(this.surface === 'annotation' ? 'an' : 'wb'),
      tool,
      color: color || WHITEBOARD_DEFAULT_COLOR,
      width: width || WHITEBOARD_DEFAULT_WIDTH,
      points: [],
      authorId: author.id,
      authorName: author.name,
      pending: true,
      ts: Date.now(),
    };
    this.strokes.push(stroke);
    this.trim();
    return stroke;
  }

  /**
   * Appends one pointer sample. Returns true when the stroke changed (the
   * caller can draw the new segment without a full repaint).
   */
  addPoint(stroke: LocalStroke, x: number, y: number): boolean {
    if (!this.strokes.includes(stroke)) return false;
    if (stroke.points.length >= this.limits.maxPointsPerStroke) return false;
    const point = normalizeWhiteboardPoint(x, y);
    if (!point) return false;
    const previous = stroke.points[stroke.points.length - 1];
    if (previous && Math.abs(previous.x - point.x) < MIN_POINT_DISTANCE && Math.abs(previous.y - point.y) < MIN_POINT_DISTANCE) {
      return false;
    }
    stroke.points.push(point);
    return true;
  }

  /** Drops a stroke that was never sent (e.g. pointer cancel with no samples). */
  discard(stroke: LocalStroke): void {
    const index = this.strokes.indexOf(stroke);
    if (index >= 0) this.strokes.splice(index, 1);
  }

  /** Marks the stroke ready to send; returns the client frame or `null`. */
  finish(stroke: LocalStroke): ClientMessage | null {
    const index = this.strokes.indexOf(stroke);
    if (index < 0) return null;
    if (stroke.points.length === 0) {
      this.strokes.splice(index, 1);
      return null;
    }
    this.fitStrokeBytes(stroke);
    // Still `pending`: only the server echo (same id) confirms it.
    this.trim();
    if (this.surface === 'annotation') {
      return {
        type: 'annotation.stroke',
        id: stroke.id,
        tool: stroke.tool,
        color: stroke.color,
        width: stroke.width,
        points: stroke.points.map((point) => ({ ...point })),
      };
    }
    return {
      type: 'whiteboard.stroke',
      id: stroke.id,
      tool: stroke.tool,
      color: stroke.color,
      width: stroke.width,
      points: stroke.points.map((point) => ({ ...point })),
    };
  }

  /** Client command for the destructive toolbar actions. */
  command(tool: 'undo' | 'clear'): ClientMessage {
    if (this.surface === 'annotation') return { type: 'annotation.clear' };
    return { type: 'whiteboard.stroke', tool };
  }

  /**
   * Ingests a stroke broadcast by the server (including the echo of our own
   * stroke). Returns true when the visible drawing changed.
   */
  ingest(raw: WhiteboardStroke | AnnotationStroke): boolean {
    const existing = this.strokes.find((stroke) => stroke.id === raw.id);
    if (existing) {
      existing.pending = false;
      existing.ts = raw.ts;
      // Trust the server-assigned geometry (it clamps and may drop samples).
      if (raw.points.length > 0) existing.points = raw.points.map((point) => ({ ...point }));
      return true;
    }
    this.strokes.push({
      id: raw.id,
      tool: raw.tool,
      color: raw.color,
      width: raw.width,
      points: raw.points.map((point) => ({ ...point })),
      authorId: raw.authorId,
      authorName: raw.authorName,
      pending: false,
      ts: raw.ts,
    });
    this.seq = Math.max(this.seq, raw.seq);
    this.trim();
    return true;
  }

  /**
   * Replaces the confirmed drawing with a room snapshot. Pending local strokes
   * are kept unless `dropPending` is set (a moderator clear/close invalidates
   * anything still in flight).
   */
  applySnapshot(
    snapshot: WhiteboardSnapshot | AnnotationSnapshot,
    options: { dropPending?: boolean } = {},
  ): void {
    const confirmed = snapshot.strokes.map<LocalStroke>((stroke) => toLocalStroke(stroke));
    const cutoff = Date.now() - PENDING_TTL_MS;
    const pending = options.dropPending
      ? []
      : this.strokes.filter((stroke) => stroke.pending && stroke.ts >= cutoff);
    this.strokes = [...confirmed, ...pending];
    this.revision = snapshot.revision;
    this.seq = snapshot.strokes.reduce((max, stroke) => Math.max(max, stroke.seq), this.seq);
    if ('presenterId' in snapshot) this.presenterId = snapshot.presenterId;
    if ('open' in snapshot) {
      this.open = snapshot.open;
      this.locked = snapshot.locked;
    }
    this.trim();
  }

  reset(): void {
    this.strokes = [];
    this.revision = 0;
    this.open = false;
    this.locked = false;
    this.presenterId = null;
  }

  /** Evicts the oldest strokes until the local caps hold (mirrors the server). */
  trim(): void {
    while (this.strokes.length > this.limits.maxStrokes) {
      this.strokes.shift();
    }
    while (this.strokes.length > 1 && this.totalPoints > this.limits.maxTotalPoints) {
      this.strokes.shift();
    }
  }

  /**
   * Decimates a dense stroke until its serialized point payload fits the byte
   * budget. Keeps the endpoint so the visible line ends where the user lifted
   * the pen; the server independently rejects oversized payloads.
   */
  private fitStrokeBytes(stroke: LocalStroke): void {
    if (stroke.points.length < 3) return;
    while (stroke.points.length > 2 && strokePointsBytes(stroke.points) > this.limits.maxStrokeBytes) {
      const last = stroke.points[stroke.points.length - 1]!;
      const decimated = stroke.points.filter((_, index) => index % 2 === 0);
      if (decimated[decimated.length - 1] !== last) decimated.push(last);
      if (decimated.length >= stroke.points.length) break;
      stroke.points = decimated;
    }
  }
}

/** Convenience factory used by the panel and the overlay. */
export function createStrokeLayer(surface: StrokeSurface): StrokeLayer {
  return new StrokeLayer(surface, surface === 'annotation' ? ANNOTATION_LIMITS : WHITEBOARD_LIMITS);
}

/** Converts a stored whiteboard snapshot entry to the local stroke shape. */
export function toLocalStroke(stroke: WhiteboardStroke | AnnotationStroke): LocalStroke {
  return {
    id: stroke.id,
    tool: stroke.tool,
    color: stroke.color,
    width: stroke.width,
    points: stroke.points.map((point) => ({ ...point })),
    authorId: stroke.authorId,
    authorName: stroke.authorName,
    pending: false,
    ts: stroke.ts,
  };
}
