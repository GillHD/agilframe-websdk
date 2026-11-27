/**
 * Whiteboard + screen-share annotations (optional).
 *
 * Both surfaces share one wire model: a **stroke** is a list of normalized
 * points (`0..1` on both axes) plus a tool, color and width. Coordinates are
 * normalized so the same drawing renders on every surface; the width is
 * normalized to the surface *height* (a `0.012` stroke is ~6px on a 500px-tall
 * board) and is clamped to at least 1 CSS pixel on render.
 *
 * The server is authoritative: it assigns `seq`/`revision`, bounds memory
 * (strokes, points, bytes) and only host/moderator may `clear` a board or
 * `close` (lock) it. Annotations belong to the current screen share and are
 * wiped when the share ends.
 */
import { z } from 'zod';

/** Tools accepted by `whiteboard.stroke`; `clear`/`undo` are commands, not stored strokes. */
export const whiteboardToolSchema = z.enum(['pen', 'eraser', 'clear', 'undo']);
export type WhiteboardTool = z.infer<typeof whiteboardToolSchema>;

export const whiteboardPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type WhiteboardPoint = z.infer<typeof whiteboardPointSchema>;

/** `#rrggbb` only: no CSS injection through stroke colors. */
export const whiteboardColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Palette shared by the widget toolbar and the docs. */
export const WHITEBOARD_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#0f172a'] as const;
export const WHITEBOARD_DEFAULT_COLOR = WHITEBOARD_COLORS[0];

/** Normalized stroke widths (fraction of the surface height): thin / medium / thick. */
export const WHITEBOARD_WIDTHS = [0.006, 0.012, 0.02] as const;
export const WHITEBOARD_DEFAULT_WIDTH = WHITEBOARD_WIDTHS[1];
export const WHITEBOARD_MIN_WIDTH = 0.001;
export const WHITEBOARD_MAX_WIDTH = 0.1;

/* ------------------------------------------------------------------ */
/* Memory limits (server-enforced, mirrored by the widget)             */
/* ------------------------------------------------------------------ */

/** Strokes kept per room board; the oldest are evicted first. */
export const MAX_WHITEBOARD_STROKES = 200;
/** Points accepted in one stroke (the widget throttles to far fewer). */
export const MAX_WHITEBOARD_POINTS_PER_STROKE = 1000;
/** Total points kept across all strokes of one board. */
export const MAX_WHITEBOARD_TOTAL_POINTS = 20000;
/** Serialized point payload cap for one stroke (bytes, JSON). */
export const MAX_WHITEBOARD_STROKE_BYTES = 32 * 1024;
/** Annotation strokes kept per room (they belong to one screen share). */
export const MAX_ANNOTATION_STROKES = 100;
export const MAX_ANNOTATION_POINTS_PER_STROKE = 1000;
export const MAX_ANNOTATION_TOTAL_POINTS = 8000;
export const MAX_ANNOTATION_STROKE_BYTES = 24 * 1024;
/** Cap for `whiteboard.close` reason. */
export const MAX_WHITEBOARD_CLOSE_REASON = 120;

export interface WhiteboardAuthor {
  id: string;
  name: string;
  role: 'host' | 'moderator' | 'guest';
}

/** One drawing stroke as stored and broadcast by the server. */
export interface WhiteboardStroke {
  id: string;
  /** Monotonic server sequence within the room (for ordering/debug). */
  seq: number;
  tool: 'pen' | 'eraser';
  color: string;
  width: number;
  points: WhiteboardPoint[];
  authorId: string;
  authorName: string;
  ts: number;
}

/** Full board state (sent on join as `welcome.whiteboard` and on every snapshot). */
export interface WhiteboardSnapshot {
  roomId: string;
  open: boolean;
  /** Host/moderator closed the board: only they may reopen it. */
  locked: boolean;
  strokes: WhiteboardStroke[];
  revision: number;
  updatedAt: number;
  ts: number;
}

/** Screen-share annotation stroke (same normalized geometry as whiteboard). */
export interface AnnotationStroke {
  id: string;
  seq: number;
  tool: 'pen' | 'eraser';
  color: string;
  width: number;
  points: WhiteboardPoint[];
  authorId: string;
  authorName: string;
  ts: number;
}

export interface AnnotationSnapshot {
  roomId: string;
  /** Participant whose screen is currently shared (`null` when nobody shares). */
  presenterId: string | null;
  strokes: AnnotationStroke[];
  revision: number;
  updatedAt: number;
  ts: number;
}

export type WhiteboardSyncReason = 'join' | 'open' | 'close' | 'request' | 'clear' | 'undo' | 'trim';
export type AnnotationClearReason = 'moderator' | 'share_ended' | 'presenter_changed' | 'room_idle';

/** Validation result for one `whiteboard.stroke` frame (server + tests share it). */
export interface WhiteboardStrokeInput {
  id?: string;
  tool: WhiteboardTool;
  color?: string;
  width?: number;
  points?: WhiteboardPoint[];
}

/**
 * Semantic validation of a `whiteboard.stroke` command that a plain zod object
 * cannot express inside the discriminated union: pen/eraser need points, while
 * clear/undo must not carry any.
 */
export function whiteboardStrokeProblem(input: WhiteboardStrokeInput): string | null {
  if (input.tool === 'clear' || input.tool === 'undo') {
    if (input.points && input.points.length > 0) return 'points_not_allowed_for_command';
    return null;
  }
  if (!Array.isArray(input.points) || input.points.length === 0) return 'points_required';
  if (input.points.length > MAX_WHITEBOARD_POINTS_PER_STROKE) return 'too_many_points';
  if (input.width !== undefined && (input.width < WHITEBOARD_MIN_WIDTH || input.width > WHITEBOARD_MAX_WIDTH)) {
    return 'invalid_width';
  }
  if (input.color !== undefined && !whiteboardColorSchema.safeParse(input.color).success) return 'invalid_color';
  return null;
}

/** Serialized byte size of a stroke's point payload (server memory guard; browser-safe). */
export function strokePointsBytes(points: readonly WhiteboardPoint[]): number {
  return new TextEncoder().encode(JSON.stringify(points)).length;
}

/** Clamps one raw point into the normalized surface; returns `null` for non-finite input. */
export function normalizeWhiteboardPoint(x: number, y: number): WhiteboardPoint | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
