const MAX_FRAMES = 48;
const FRAME_TTL_MS = 30_000;

interface CachedFrame {
  publicationId: string;
  canvas: HTMLCanvasElement;
  expiresAt: number;
}

/** Owns small camera bitmaps for one call view. Canvas pixels never leave memory. */
export class GalleryFrameCache {
  private readonly frames = new Map<string, CachedFrame>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onExpiry: () => void) {}

  get(participantId: string): HTMLCanvasElement | undefined {
    const frame = this.frames.get(participantId);
    if (!frame || frame.expiresAt <= Date.now()) return undefined;
    this.frames.delete(participantId);
    this.frames.set(participantId, frame);
    return frame.canvas;
  }

  save(participantId: string, publicationId: string, canvas: HTMLCanvasElement): void {
    this.remove(participantId);
    this.frames.set(participantId, { publicationId, canvas, expiresAt: Date.now() + FRAME_TTL_MS });
    if (this.frames.size > MAX_FRAMES) {
      const oldest = this.frames.keys().next().value;
      if (oldest !== undefined) this.remove(oldest);
    }
    this.scheduleExpiry();
  }

  retain(isCurrent: (participantId: string, publicationId: string) => boolean): void {
    for (const [id, frame] of this.frames) {
      if (!isCurrent(id, frame.publicationId)) this.remove(id);
    }
    if (this.frames.size === 0) this.cancelExpiry();
  }

  clear(): void {
    for (const id of this.frames.keys()) this.remove(id);
    this.cancelExpiry();
  }

  private remove(participantId: string): void {
    const frame = this.frames.get(participantId);
    if (!frame) return;
    frame.canvas.remove();
    frame.canvas.width = frame.canvas.height = 0;
    this.frames.delete(participantId);
  }

  private cancelExpiry(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleExpiry(): void {
    if (this.timer !== null) return;
    if (this.frames.size === 0) return;
    let nextExpiry = Infinity;
    for (const frame of this.frames.values()) nextExpiry = Math.min(nextExpiry, frame.expiresAt);
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = Date.now();
      let changed = false;
      for (const [id, frame] of this.frames) {
        if (frame.expiresAt <= now) {
          this.remove(id);
          changed = true;
        }
      }
      if (changed) this.onExpiry();
      this.scheduleExpiry();
    }, Math.max(0, nextExpiry - Date.now()));
  }
}
