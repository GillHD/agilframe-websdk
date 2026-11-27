/**
 * Canvas renderer for the whiteboard and screen-share annotation layers.
 *
 * With normal 2D canvas is enough: strokes are bounded by the protocol caps
 * (≤200 committed strokes, ≤1000 points each) and only the active layer is
 * redrawn. Eraser strokes use `destination-out`, so they erase pixels below
 * them exactly like a real eraser.
 */
import type { LocalStroke } from '../call/whiteboard.js';
import { strokeGeometry } from '../call/whiteboard.js';

export class StrokeCanvas {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private widthPx = 0;
  private heightPx = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas is not available');
    this.ctx = ctx;
  }

  get width(): number {
    return this.widthPx;
  }

  get height(): number {
    return this.heightPx;
  }

  /** Sizes the backing store to the CSS box; returns true when it changed. */
  resize(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(3, Math.max(1, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1));
    if (width === this.widthPx && height === this.heightPx && dpr === this.dpr) return false;
    this.widthPx = width;
    this.heightPx = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  clear(): void {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    this.ctx.globalCompositeOperation = 'source-over';
  }

  drawAll(strokes: readonly LocalStroke[]): void {
    this.clear();
    for (const stroke of strokes) this.drawStroke(stroke);
    this.ctx.globalCompositeOperation = 'source-over';
  }

  /** Draws a whole stroke (used for full repaints and remote strokes). */
  drawStroke(stroke: LocalStroke): void {
    if (stroke.points.length === 0) return;
    this.ctx.save();
    this.ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    this.ctx.strokeStyle = stroke.color;
    this.ctx.fillStyle = stroke.color;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    const { points, lineWidth } = strokeGeometry(stroke, this.widthPx, this.heightPx);
    this.ctx.lineWidth = lineWidth;
    if (points.length === 1) {
      const point = points[0]!;
      this.ctx.beginPath();
      this.ctx.arc(point.x, point.y, lineWidth / 2, 0, Math.PI * 2);
      this.ctx.fill();
    } else {
      this.ctx.beginPath();
      this.ctx.moveTo(points[0]!.x, points[0]!.y);
      for (let index = 1; index < points.length; index += 1) {
        this.ctx.lineTo(points[index]!.x, points[index]!.y);
      }
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  /**
   * Draws the segment starting at `fromIndex - 1` (one new pointer sample):
   * keeps live drawing cheap even with hundreds of strokes on the layer.
   */
  drawSegment(stroke: LocalStroke, fromIndex: number): void {
    const points = stroke.points;
    if (fromIndex <= 0 || fromIndex >= points.length) {
      this.drawStroke(stroke);
      return;
    }
    this.ctx.save();
    this.ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    this.ctx.strokeStyle = stroke.color;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    const geometry = strokeGeometry(stroke, this.widthPx, this.heightPx);
    this.ctx.lineWidth = geometry.lineWidth;
    this.ctx.beginPath();
    this.ctx.moveTo(geometry.points[fromIndex - 1]!.x, geometry.points[fromIndex - 1]!.y);
    this.ctx.lineTo(geometry.points[fromIndex]!.x, geometry.points[fromIndex]!.y);
    this.ctx.stroke();
    this.ctx.restore();
  }
}
