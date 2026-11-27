/**
 * Background blur / virtual background (contract §6).
 *
 * Pipeline: input camera track → source canvas → (optional MediaPipe selfie
 * segmentation, loaded lazily from a CDN) → composited output canvas →
 * `captureStream()` track sent to peers.
 *
 * Graceful degradation: if MediaPipe (CDN) is unavailable the processor falls
 * back to a whole-frame canvas blur (real outgoing effect, no segmentation) and
 * reports `degraded: true`; the UI shows a warning and `getStats()` exposes the
 * flag. Virtual backgrounds with an empty URL are replaced by theme gradients.
 */
import type { BlurMode } from '../types.js';
import { createSelfieSegmenter, type ImageSegmenterLike, type MaskLike } from './mediapipe.js';

export interface BackgroundOptions {
  mode: BlurMode;
  /** Blur radius in px (config.session.blurStrength). */
  strength: number;
  imageUrl?: string;
  /** Gradient fallback colors for empty virtual backgrounds (from the theme). */
  colors?: { primary: string; surface: string; background: string };
  fps?: number;
  /** Container for the hidden video element (defaults to document.body). */
  container?: HTMLElement;
  onDegraded?: (reason: 'cdn' | 'unsupported') => void;
}

export interface BackgroundResult {
  track: MediaStreamTrack | null;
  degraded: boolean;
  mode: BlurMode;
  error?: 'segmenter';
}

const OUTPUT_WIDTH = 640;
const OUTPUT_HEIGHT = 360;
const DEFAULT_FPS = 24;

interface SegmentMask {
  data: Float32Array;
  width: number;
  height: number;
}

type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };

function drawCover(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
  scale = 1,
): void {
  const sw = 'videoWidth' in source ? (source as HTMLVideoElement).videoWidth : (source as HTMLCanvasElement).width;
  const sh = 'videoHeight' in source ? (source as HTMLVideoElement).videoHeight : (source as HTMLCanvasElement).height;
  if (!sw || !sh) return;
  const cover = Math.max(width / sw, height / sh) * scale;
  const dw = sw * cover;
  const dh = sh * cover;
  ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
}

export class BackgroundProcessor {
  private readonly input: MediaStreamTrack;
  private options: BackgroundOptions;
  private readonly container: HTMLElement;
  private video: HTMLVideoElement | null = null;
  private sourceCanvas: HTMLCanvasElement;
  private sourceCtx: CanvasRenderingContext2D | null;
  private outputCanvas: HTMLCanvasElement;
  private outputCtx: CanvasRenderingContext2D | null;
  private maskCanvas: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D | null;
  private foregroundCanvas: HTMLCanvasElement;
  private foregroundCtx: CanvasRenderingContext2D | null;
  private segmenter: ImageSegmenterLike | null = null;
  private mask: SegmentMask | null = null;
  private segmentBusy = false;
  private image: HTMLImageElement | null = null;
  private imageReady = false;
  private outputTrack: MediaStreamTrack | null = null;
  private stream: MediaStream | null = null;
  private running = false;
  private loopStarted = false;
  private loopHandle: number | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private degraded = false;
  private warnShown = false;
  private lastFrameAt = 0;
  private frameInterval = 1000 / DEFAULT_FPS;
  private inputEndedHandler: (() => void) | null = null;

  constructor(input: MediaStreamTrack, options: BackgroundOptions) {
    this.input = input;
    this.options = { ...options, fps: options.fps ?? DEFAULT_FPS };
    this.container = options.container ?? document.body;
    this.frameInterval = 1000 / (options.fps ?? DEFAULT_FPS);

    this.sourceCanvas = document.createElement('canvas');
    this.sourceCanvas.width = OUTPUT_WIDTH;
    this.sourceCanvas.height = OUTPUT_HEIGHT;
    this.sourceCtx = this.sourceCanvas.getContext('2d', { willReadFrequently: false });

    this.outputCanvas = document.createElement('canvas');
    this.outputCanvas.width = OUTPUT_WIDTH;
    this.outputCanvas.height = OUTPUT_HEIGHT;
    this.outputCtx = this.outputCanvas.getContext('2d');

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = 256;
    this.maskCanvas.height = 144;
    this.maskCtx = this.maskCanvas.getContext('2d');

    this.foregroundCanvas = document.createElement('canvas');
    this.foregroundCanvas.width = OUTPUT_WIDTH;
    this.foregroundCanvas.height = OUTPUT_HEIGHT;
    this.foregroundCtx = this.foregroundCanvas.getContext('2d');

    const { width, height } = input.getSettings();
    if (width && height) this.resizeForSource(width, height);
  }

  private resizeForSource(width: number, height: number): void {
    if (!width || !height) return;
    const portrait = width < height;
    const scale = Math.min(1, (portrait ? OUTPUT_HEIGHT : OUTPUT_WIDTH) / width, (portrait ? OUTPUT_WIDTH : OUTPUT_HEIGHT) / height);
    const outputWidth = Math.max(1, Math.round(width * scale));
    const outputHeight = Math.max(1, Math.round(height * scale));
    if (this.outputCanvas.width === outputWidth && this.outputCanvas.height === outputHeight) return;
    for (const canvas of [this.sourceCanvas, this.outputCanvas, this.foregroundCanvas]) {
      canvas.width = outputWidth;
      canvas.height = outputHeight;
    }
    this.mask = null;
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  get currentMode(): BlurMode {
    return this.options.mode;
  }

  get track(): MediaStreamTrack | null {
    return this.outputTrack;
  }

  private async loadImage(): Promise<void> {
    const url = this.options.imageUrl;
    if (!url) {
      this.imageReady = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        this.image = image;
        this.imageReady = true;
        resolve();
      };
      image.onerror = () => {
        this.image = null;
        this.imageReady = false;
        console.warn('[agil] virtual background image failed to load');
        resolve();
      };
      image.src = url;
    });
  }

  private async ensureSegmenter(): Promise<boolean> {
    if (this.options.mode === 'off') return true;
    if (this.segmenter) return true;
    this.segmenter = await createSelfieSegmenter();
    if (!this.segmenter) {
      this.degraded = true;
      if (!this.warnShown) {
        this.warnShown = true;
        this.options.onDegraded?.('cdn');
      }
      return false;
    }
    return true;
  }

  private async startVideoElement(): Promise<void> {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.setAttribute('aria-hidden', 'true');
    video.style.position = 'absolute';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    video.style.left = '-9999px';
    video.srcObject = new MediaStream([this.input]);
    this.container.appendChild(video);
    this.video = video;
    try {
      await video.play();
    } catch {
      /* autoplay of a muted track is normally allowed */
    }
  }

  /** Starts processing; returns the output track (null when mode is `off`). */
  async start(): Promise<BackgroundResult> {
    if (this.options.mode === 'off') return { track: null, degraded: false, mode: 'off' };
    if (!this.outputTrack) {
      if (!(await this.ensureSegmenter())) return { track: null, degraded: true, mode: this.options.mode, error: 'segmenter' };
      await this.loadImage();
      this.stream = this.outputCanvas.captureStream(this.options.fps ?? DEFAULT_FPS);
      this.outputTrack = this.stream.getVideoTracks()[0] ?? null;
      if (this.outputTrack) this.outputTrack.contentHint = 'motion';
    }
    this.running = true;
    this.inputEndedHandler = () => this.stop();
    this.input.addEventListener('ended', this.inputEndedHandler);
    void this.runLoop();
    return { track: this.outputTrack, degraded: this.degraded, mode: this.options.mode };
  }

  async setMode(mode: BlurMode, imageUrl?: string): Promise<BackgroundResult> {
    if (mode === 'off') {
      this.stop();
      return { track: null, degraded: false, mode: 'off' };
    }
    const modeChanged = this.options.mode !== mode;
    this.options.mode = mode;
    if (imageUrl !== undefined) this.options.imageUrl = imageUrl;
    if (mode === 'image' && modeChanged) await this.loadImage();
    if (mode === 'blur' && modeChanged && !(await this.ensureSegmenter())) {
      return { track: null, degraded: true, mode: 'blur', error: 'segmenter' };
    }
    if (!this.outputTrack) return this.start();
    return { track: this.outputTrack, degraded: this.degraded, mode: this.options.mode };
  }

  setStrength(strength: number): void {
    this.options.strength = Math.max(1, Math.min(40, strength));
  }

  private async runLoop(): Promise<void> {
    if (this.loopStarted) return;
    this.loopStarted = true;
    try {
      await this.startVideoElement();
      const TrackProcessor = (window as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
      if (TrackProcessor) {
        await this.loopWithTrackProcessor(TrackProcessor);
      } else {
        await this.loopWithVideoElement();
      }
    } catch (error) {
      console.warn('[agil] background processor loop failed', error);
      this.degraded = true;
    } finally {
      this.loopStarted = false;
    }
  }

  private segmentFrame(timestamp: number): void {
    if (!this.segmenter || this.segmentBusy) return;
    const input = this.video ?? this.sourceCanvas;
    this.segmentBusy = true;
    try {
      this.segmenter.segmentForVideo(input, timestamp, (result) => {
        this.segmentBusy = false;
        const mask: MaskLike | undefined = result.confidenceMasks?.[0] ?? result.categoryMask;
        if (!mask) return;
        try {
          const data =
            'getAsFloat32Array' in mask && result.confidenceMasks?.[0]
              ? mask.getAsFloat32Array()
              : Float32Array.from(mask.getAsUint8Array());
          this.mask = { data, width: mask.width, height: mask.height };
        } catch {
          this.mask = null;
        } finally {
          mask.close?.();
        }
      });
    } catch {
      this.segmentBusy = false;
      this.segmenter = null;
      this.degraded = true;
      if (!this.warnShown) {
        this.warnShown = true;
        this.options.onDegraded?.('cdn');
      }
    }
  }

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.outputCanvas;
    if (this.options.mode === 'image') {
      if (this.imageReady && this.image) {
        drawCover(ctx, this.image, width, height);
      } else {
        const colors = this.options.colors ?? { primary: '#2563eb', surface: '#0f172a', background: '#080d16' };
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, colors.background);
        gradient.addColorStop(0.55, colors.surface);
        gradient.addColorStop(1, colors.primary);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
      }
    }
  }

  private drawMaskedForeground(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.outputCanvas;
    const source = this.video ?? this.sourceCanvas;
    const fg = this.foregroundCtx;
    if (!fg) {
      ctx.drawImage(source, 0, 0, width, height);
      return;
    }
    fg.clearRect(0, 0, width, height);
    fg.drawImage(source, 0, 0, width, height);
    if (this.mask && this.maskCtx) {
      const mask = this.mask;
      this.maskCanvas.width = mask.width;
      this.maskCanvas.height = mask.height;
      const imageData = this.maskCtx.createImageData(mask.width, mask.height);
      for (let i = 0; i < mask.data.length; i += 1) {
        const person = (mask.data[i] ?? 0) > 0.5;
        const offset = i * 4;
        imageData.data[offset] = 255;
        imageData.data[offset + 1] = 255;
        imageData.data[offset + 2] = 255;
        imageData.data[offset + 3] = person ? 255 : 0;
      }
      this.maskCtx.putImageData(imageData, 0, 0);
      fg.save();
      fg.globalCompositeOperation = 'destination-in';
      fg.drawImage(this.maskCanvas, 0, 0, mask.width, mask.height, 0, 0, width, height);
      fg.restore();
    }
    ctx.drawImage(this.foregroundCanvas, 0, 0, width, height);
  }

  private compose(timestamp: number): void {
    const ctx = this.outputCtx;
    if (!ctx) return;
    const { width, height } = this.outputCanvas;
    const source = this.video ?? this.sourceCanvas;
    this.segmentFrame(timestamp);
    const hasMask = this.mask !== null;
    if (this.options.mode === 'blur') {
      if (!hasMask) {
        // No person mask: show the raw camera instead of blurring the whole frame.
        drawCover(ctx, source, width, height, 1);
        return;
      }
      ctx.save();
      ctx.filter = `blur(${this.options.strength}px)`;
      drawCover(ctx, source, width, height, 1.08);
      ctx.restore();
      this.drawMaskedForeground(ctx);
    } else {
      this.drawBackground(ctx);
      if (hasMask) {
        this.drawMaskedForeground(ctx);
      } else {
        ctx.drawImage(source, 0, 0, width, height);
      }
    }
  }

  private async loopWithVideoElement(): Promise<void> {
    const step = (): void => {
      if (!this.running) return;
      this.loopHandle = requestAnimationFrame(step);
      const now = performance.now();
      if (now - this.lastFrameAt < this.frameInterval) return;
      this.lastFrameAt = now;
      const video = this.video;
      if (!video || video.readyState < 2) return;
      this.resizeForSource(video.videoWidth, video.videoHeight);
      this.sourceCtx?.drawImage(video, 0, 0, this.sourceCanvas.width, this.sourceCanvas.height);
      this.compose(now);
    };
    this.loopHandle = requestAnimationFrame(step);
  }

  private async loopWithTrackProcessor(TrackProcessor: TrackProcessorCtor): Promise<void> {
    const processor = new TrackProcessor({ track: this.input });
    const reader = processor.readable.getReader();
    this.reader = reader;
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || !frame || !this.running) {
        frame?.close();
        break;
      }
      try {
        this.resizeForSource(frame.displayWidth, frame.displayHeight);
        this.sourceCtx?.drawImage(frame, 0, 0, this.sourceCanvas.width, this.sourceCanvas.height);
        this.compose(performance.now());
      } finally {
        frame.close();
      }
    }
  }

  stop(): void {
    this.running = false;
    this.loopStarted = false;
    if (this.loopHandle !== null) {
      cancelAnimationFrame(this.loopHandle);
      this.loopHandle = null;
    }
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    if (this.inputEndedHandler) this.input.removeEventListener('ended', this.inputEndedHandler);
    this.inputEndedHandler = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
    this.segmenter?.close?.();
    this.segmenter = null;
    this.mask = null;
    if (this.outputTrack) {
      this.outputTrack.stop();
      this.outputTrack = null;
    }
    this.stream = null;
    this.options.mode = 'off';
  }
}
