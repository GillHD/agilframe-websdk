/**
 * Call recording (contract §14).
 *
 * Composes a canvas grid of all video streams plus an AudioContext mix into a
 * single MediaStream, records it with MediaRecorder in the configured format
 * (webm/mp4), and either uploads the blob to `POST /v1/recordings` (Bearer join
 * token) or downloads it locally.
 */
import type { TenantConfig } from '@agil/protocol';
import type { ApiClient } from '../api.js';
import { withWebmDuration } from './webm-duration.js';

export interface RecordingSource {
  id: string;
  label: string;
  stream: MediaStream;
}

export interface RecordingOptions {
  config: TenantConfig;
  api: ApiClient;
  /** MIME type requested by the tenant config, resolved against browser support. */
  onError: (message: string, code?: string) => void;
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  durationSec: number;
  uploaded: boolean;
  uploadFailed?: boolean;
  url?: string;
}

export interface RecorderCallbacks {
  onStarted?: (startedAt: number) => void;
  onStopped?: (result: RecordingResult | null) => void;
  onTick?: (elapsedSec: number) => void;
}

function pickMimeType(format: 'webm' | 'mp4'): string {
  const candidates =
    format === 'mp4'
      ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return 'video/webm';
}

/** How long recording waits for one `<video>` to reach playback before skipping it. */
export const VIDEO_PLAY_TIMEOUT_MS = 1500;

/**
 * `HTMLVideoElement.play()` can stay pending forever for a remote stream whose
 * frame never arrives, which used to hang `startRecording()` (QA P2-6). Timed
 * playback is only a warm-up for the canvas draw loop: on timeout the composer
 * keeps going and paints the first available frame (or black) instead.
 */
export async function playWithTimeout(
  video: Pick<HTMLVideoElement, 'play'>,
  timeoutMs = VIDEO_PLAY_TIMEOUT_MS,
): Promise<'played' | 'timeout' | 'rejected'> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      video.play().then(
        () => 'played' as const,
        () => 'rejected' as const,
      ),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class CallRecorder {
  private readonly config: TenantConfig;
  private readonly api: ApiClient;
  private readonly onError: RecordingOptions['onError'];
  private callbacks: RecorderCallbacks = {};
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private canvas: HTMLCanvasElement | null = null;
  private canvasCtx: CanvasRenderingContext2D | null = null;
  private videoElements: Array<{ video: HTMLVideoElement; label: string }> = [];
  private audioContext: AudioContext | null = null;
  private mixDestination: MediaStreamAudioDestinationNode | null = null;
  private composedStream: MediaStream | null = null;
  private animationHandle: number | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private stopResolver: ((result: RecordingResult | null) => void) | null = null;
  /** Room id is needed for `x-recording-meta`; set before `start()`. */
  roomId = '';

  constructor(options: RecordingOptions) {
    this.config = options.config;
    this.api = options.api;
    this.onError = options.onError;
  }

  get supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  get active(): boolean {
    return this.recorder?.state === 'recording';
  }

  get finalizing(): boolean {
    return this.stopResolver !== null;
  }

  get startedAtMs(): number {
    return this.startedAt;
  }

  static isSupported(): boolean {
    return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  async start(sources: RecordingSource[], callbacks: RecorderCallbacks = {}): Promise<boolean> {
    if (!this.supported) {
      this.onError('recordingNotSupported', 'unsupported');
      return false;
    }
    if (this.active) return true;
    if (this.finalizing) return false;
    this.callbacks = callbacks;
    if (sources.length === 0) {
      this.onError('recordingNoSources', 'no_sources');
      return false;
    }

    const width = 1280;
    const height = 720;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.onError('recordingNotSupported', 'unsupported');
      return false;
    }
    this.canvas = canvas;
    this.canvasCtx = ctx;
    this.videoElements = [];

    const playbacks: Array<Promise<'played' | 'timeout' | 'rejected'>> = [];
    for (const source of sources) {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.srcObject = source.stream;
      video.style.display = 'none';
      document.body.appendChild(video);
      playbacks.push(playWithTimeout(video));
      this.videoElements.push({ video, label: source.label });
    }
    // Bounded wait: one stalled remote video must not block the whole recording.
    await Promise.all(playbacks);

    const composed = new MediaStream();
    const canvasStream = canvas.captureStream(15);
    for (const track of canvasStream.getVideoTracks()) composed.addTrack(track);

    // Audio mix: self + every remote participant.
    try {
      const audioSources = sources.map((source) => source.stream).filter((stream) => stream.getAudioTracks().length > 0);
      if (audioSources.length > 0 && typeof AudioContext !== 'undefined') {
        const audioContext = new AudioContext();
        this.audioContext = audioContext;
        const destination = audioContext.createMediaStreamDestination();
        this.mixDestination = destination;
        for (const stream of audioSources) {
          try {
            const sourceNode = audioContext.createMediaStreamSource(stream);
            sourceNode.connect(destination);
          } catch {
            /* a muted/empty stream cannot be mixed — skip it */
          }
        }
        for (const track of destination.stream.getAudioTracks()) composed.addTrack(track);
      }
    } catch (error) {
      console.warn('[agil] recording audio mix unavailable', error);
    }

    this.composedStream = composed;
    const mimeType = pickMimeType(this.config.session.recording.format);
    this.chunks = [];
    try {
      this.recorder = new MediaRecorder(composed, { mimeType });
    } catch (error) {
      console.warn('[agil] MediaRecorder failed, trying default mime', error);
      try {
        this.recorder = new MediaRecorder(composed);
      } catch (fallbackError) {
        this.cleanup();
        this.onError('recordingNotSupported', 'unsupported');
        return false;
      }
    }

    this.recorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    this.recorder.addEventListener('error', () => this.onError('recordingFailed', 'recorder_error'));
    this.recorder.addEventListener('stop', () => {
      void this.finish();
    });

    this.startedAt = Date.now();
    this.recorder.start(1000);
    this.callbacks.onStarted?.(this.startedAt);
    this.tickTimer = setInterval(() => {
      this.callbacks.onTick?.(Math.floor((Date.now() - this.startedAt) / 1000));
    }, 1000);
    this.drawLoop();
    return true;
  }

  private drawLoop = (): void => {
    if (!this.recorder || this.recorder.state !== 'recording') return;
    this.animationHandle = requestAnimationFrame(this.drawLoop);
    const ctx = this.canvasCtx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    const { width, height } = canvas;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    const count = this.videoElements.length;
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    const cellWidth = width / columns;
    const cellHeight = height / rows;
    this.videoElements.forEach((entry, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * cellWidth;
      const y = row * cellHeight;
      const video = entry.video;
      if (video.videoWidth && video.videoHeight) {
        const scale = Math.min(cellWidth / video.videoWidth, cellHeight / video.videoHeight);
        const drawWidth = video.videoWidth * scale;
        const drawHeight = video.videoHeight * scale;
        ctx.drawImage(video, x + (cellWidth - drawWidth) / 2, y + (cellHeight - drawHeight) / 2, drawWidth, drawHeight);
      }
      ctx.font = '600 16px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      const labelWidth = ctx.measureText(entry.label).width + 16;
      ctx.fillRect(x + 10, y + 10, labelWidth, 26);
      ctx.fillStyle = '#fff';
      ctx.fillText(entry.label, x + 18, y + 29);
    });
  };

  /** Stops recording and resolves with the finished (and uploaded/downloaded) blob. */
  async stop(): Promise<RecordingResult | null> {
    if (!this.recorder || this.recorder.state === 'inactive') {
      this.cleanup();
      return null;
    }
    const promise = new Promise<RecordingResult | null>((resolve) => {
      this.stopResolver = resolve;
    });
    this.recorder.stop();
    return promise;
  }

  private async finish(): Promise<void> {
    const result = await this.finalize();
    this.stopResolver?.(result);
    this.stopResolver = null;
  }

  private async finalize(): Promise<RecordingResult | null> {
    const elapsedSec = Math.max(0, (Date.now() - this.startedAt) / 1000);
    const durationSec = Math.max(1, Math.round(elapsedSec));
    const mimeType = this.recorder?.mimeType || 'video/webm';
    let blob = new Blob(this.chunks, { type: mimeType });
    const config = this.config.session.recording;
    this.cleanup();
    if (blob.size === 0) {
      this.onError('recordingFailed', 'empty');
      this.callbacks.onStopped?.(null);
      return null;
    }
    // P3: MediaRecorder omits WebM `Duration`; add it best-effort so players can
    // show a duration/seek before re-indexing. Failure keeps the original blob.
    if (mimeType.includes('webm')) {
      try {
        blob = await withWebmDuration(blob, elapsedSec);
      } catch (error) {
        console.warn('[agil] recording duration metadata unavailable', error);
      }
    }
    let uploaded = false;
    let url: string | undefined;
    if (config.storeOnServer) {
      try {
        const meta = { roomId: this.roomId || 'unknown', durationSec, mimeType };
        const record = await this.api.uploadRecording(blob, meta);
        uploaded = true;
        url = record.url;
        this.callbacks.onStopped?.({ blob, mimeType, durationSec, uploaded, url });
        return { blob, mimeType, durationSec, uploaded, url };
      } catch (error) {
        console.warn('[agil] recording upload failed', error);
      }
    }
    const result: RecordingResult = { blob, mimeType, durationSec, uploaded: false, uploadFailed: config.storeOnServer };
    this.callbacks.onStopped?.(result);
    return result;
  }

  private cleanup(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.animationHandle !== null) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = null;
    }
    for (const entry of this.videoElements) {
      entry.video.srcObject = null;
      entry.video.remove();
    }
    this.videoElements = [];
    if (this.composedStream) {
      for (const track of this.composedStream.getTracks()) track.stop();
      this.composedStream = null;
    }
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
    this.mixDestination = null;
    this.recorder = null;
    this.canvas = null;
    this.canvasCtx = null;
  }

  destroy(): void {
    if (this.recorder?.state === 'recording') {
      try {
        this.recorder.stop();
      } catch {
        /* ignore */
      }
    }
    this.cleanup();
  }
}
