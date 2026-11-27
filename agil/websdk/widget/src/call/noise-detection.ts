/**
 * Local microphone noise detection (advisory only).
 *
 * The analysis runs entirely in the browser on the local microphone track:
 * no audio samples, buffers or spectral data leave the page. `NoiseMonitor`
 * taps the track with a Web Audio `AnalyserNode` (an unconnected analysis
 * branch, so it never adds echo), samples a short time-domain frame and feeds
 * it into a small state machine that applies thresholds, hysteresis and a
 * cooldown before the UI is allowed to warn the participant.
 *
 * The goal is *awareness*, not denoising: background noise is classified as
 * "broadband and steady" (spectral flatness + noise floor). Voiced speech is
 * harmonic, so it has a low flatness and must not trigger the warning.
 */

export type NoiseLevel = 'quiet' | 'low' | 'moderate' | 'high';

/** Result of analyzing one time-domain frame. All levels are linear (0..1). */
export interface AudioFrameAnalysis {
  /** Root mean square of the frame (linear amplitude). */
  rms: number;
  /** Steady low percentile of short-window RMS — an on-device noise-floor estimate. */
  noiseFloor: number;
  /** Ratio of geometric to arithmetic mean power (1 = white noise, ~0 = tonal). */
  spectralFlatness: number;
  /** True when the frame looks like steady broadband background noise. */
  noisy: boolean;
  /** Loudness band derived from `rms` (not the same thing as `noisy`). */
  level: NoiseLevel;
}

export interface NoiseThresholds {
  /** Minimum RMS for a frame to be considered noisy (default 0.03 ≈ -30 dBFS). */
  rms: number;
  /** Minimum noise-floor estimate (default 0.015). */
  noiseFloor: number;
  /** Minimum spectral flatness, 0..1 (default 0.35). */
  spectralFlatness: number;
}

export const DEFAULT_NOISE_THRESHOLDS: Readonly<NoiseThresholds> = Object.freeze({
  rms: 0.03,
  noiseFloor: 0.015,
  spectralFlatness: 0.35,
});

/** RMS band boundaries used for `AudioFrameAnalysis.level`. */
export const NOISE_LEVEL_RMS = Object.freeze({
  low: 0.01,
  moderate: 0.035,
  high: 0.08,
});

/** Cooldown bounds from the product spec: never warn more than once per 30–60 s. */
export const NOISE_COOLDOWN_MIN_MS = 30_000;
export const NOISE_COOLDOWN_MAX_MS = 60_000;
export const NOISE_COOLDOWN_DEFAULT_MS = 45_000;

/** 100 ms frames → 300 ms to enter, 800 ms to leave (before cooldown). */
export const NOISE_FRAME_INTERVAL_MS = 100;
export const NOISE_ENTER_FRAMES = 3;
export const NOISE_RELEASE_FRAMES = 8;

/** Payload emitted to the host. Deliberately contains no audio data. */
export interface NoiseDetectedEvent {
  level: NoiseLevel;
  rms: number;
  /** Epoch milliseconds of the frame that crossed the threshold. */
  at: number;
}

/** Clamps a configured cooldown to the documented 30–60 s window. */
export function resolveNoiseCooldownMs(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NOISE_COOLDOWN_DEFAULT_MS;
  return Math.min(NOISE_COOLDOWN_MAX_MS, Math.max(NOISE_COOLDOWN_MIN_MS, Math.round(value)));
}

function levelForRms(rms: number): NoiseLevel {
  if (rms >= NOISE_LEVEL_RMS.high) return 'high';
  if (rms >= NOISE_LEVEL_RMS.moderate) return 'moderate';
  if (rms >= NOISE_LEVEL_RMS.low) return 'low';
  return 'quiet';
}

function frameRms(samples: Float32Array): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    if (!Number.isFinite(value)) continue;
    sum += value * value;
    count += 1;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/**
 * Estimates the noise floor inside one frame as the 10th percentile of
 * short-window RMS values. White noise is steady → all windows are similar;
 * speech has pauses and syllable gaps → the low percentile stays low.
 */
function estimateNoiseFloor(samples: Float32Array): number {
  const length = samples.length;
  if (length < 2) return 0;
  const windowSize = Math.max(16, Math.floor(length / 16));
  const windows: number[] = [];
  for (let start = 0; start + windowSize <= length; start += windowSize) {
    let sum = 0;
    let count = 0;
    for (let i = start; i < start + windowSize; i += 1) {
      const value = samples[i] ?? 0;
      if (!Number.isFinite(value)) continue;
      sum += value * value;
      count += 1;
    }
    if (count > 0) windows.push(Math.sqrt(sum / count));
  }
  if (windows.length === 0) return 0;
  windows.sort((a, b) => a - b);
  const index = Math.min(windows.length - 1, Math.floor((windows.length - 1) * 0.1));
  return windows[index] ?? 0;
}

/** In-place iterative radix-2 Cooley–Tukey FFT (length must be a power of two). */
function fftInPlace(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const realValue = real[i] ?? 0;
      const imagValue = imag[i] ?? 0;
      real[i] = real[j] ?? 0;
      imag[i] = imag[j] ?? 0;
      real[j] = realValue;
      imag[j] = imagValue;
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    const half = length >> 1;
    for (let start = 0; start < n; start += length) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < half; k += 1) {
        const evenIndex = start + k;
        const oddIndex = evenIndex + half;
        const oddReal = real[oddIndex] ?? 0;
        const oddImag = imag[oddIndex] ?? 0;
        const tReal = oddReal * curReal - oddImag * curImag;
        const tImag = oddReal * curImag + oddImag * curReal;
        const evenReal = real[evenIndex] ?? 0;
        const evenImag = imag[evenIndex] ?? 0;
        real[evenIndex] = evenReal + tReal;
        imag[evenIndex] = evenImag + tImag;
        real[oddIndex] = evenReal - tReal;
        imag[oddIndex] = evenImag - tImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
}

/**
 * Spectral flatness of the 80 Hz–8 kHz band (speech band). The band is derived
 * from `sampleRate`, so DC offset, mains hum below 80 Hz and near-Nyquist hiss
 * do not dominate the result.
 */
function computeSpectralFlatness(samples: Float32Array, sampleRate: number): number {
  const usable = Math.min(samples.length, 2048);
  let fftSize = 64;
  while (fftSize * 2 <= usable) fftSize *= 2;
  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);
  const denominator = fftSize > 1 ? fftSize - 1 : 1;
  for (let i = 0; i < fftSize; i += 1) {
    const value = i < samples.length ? samples[i] ?? 0 : 0;
    if (!Number.isFinite(value)) continue;
    // Hann window keeps leakage from a strong harmonic from flattening the spectrum.
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denominator);
    real[i] = value * window;
  }
  fftInPlace(real, imag);

  const nyquistBin = fftSize >> 1;
  const binHz = sampleRate / fftSize;
  let lowBin = Math.max(1, Math.ceil(80 / binHz));
  let highBin = Math.min(nyquistBin - 1, Math.floor(Math.min(8000, sampleRate / 2) / binHz));
  if (highBin <= lowBin) {
    lowBin = 1;
    highBin = nyquistBin - 1;
  }
  if (highBin <= lowBin) return 0;

  let totalPower = 0;
  for (let bin = lowBin; bin <= highBin; bin += 1) {
    const re = real[bin] ?? 0;
    const im = imag[bin] ?? 0;
    totalPower += re * re + im * im;
  }
  // Digital silence / all-zero frames have no meaningful spectrum.
  if (totalPower <= 1e-18) return 0;

  let logSum = 0;
  let count = 0;
  for (let bin = lowBin; bin <= highBin; bin += 1) {
    const re = real[bin] ?? 0;
    const im = imag[bin] ?? 0;
    const power = re * re + im * im;
    logSum += Math.log(Math.max(power, 1e-30));
    count += 1;
  }
  if (count === 0) return 0;
  const arithmeticMean = totalPower / count;
  const geometricMean = Math.exp(logSum / count);
  if (!Number.isFinite(geometricMean) || arithmeticMean <= 0) return 0;
  return Math.max(0, Math.min(1, geometricMean / arithmeticMean));
}

/**
 * Pure frame analysis. Safe for synthetic buffers, empty arrays and arrays
 * containing `NaN`/`Infinity`; never throws and never allocates a network
 * request (the whole feature lives on-device).
 */
export function analyzeAudioFrame(
  samples: Float32Array,
  sampleRate: number,
  thresholds: NoiseThresholds = DEFAULT_NOISE_THRESHOLDS,
): AudioFrameAnalysis {
  const rms = frameRms(samples);
  if (samples.length < 2 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { rms, noiseFloor: 0, spectralFlatness: 0, noisy: false, level: levelForRms(rms) };
  }
  const noiseFloor = estimateNoiseFloor(samples);
  const spectralFlatness = computeSpectralFlatness(samples, sampleRate);
  const level = levelForRms(rms);
  const noisy =
    rms >= thresholds.rms &&
    noiseFloor >= thresholds.noiseFloor &&
    spectralFlatness >= thresholds.spectralFlatness &&
    level !== 'quiet';
  return { rms, noiseFloor, spectralFlatness, noisy, level };
}

export interface NoiseGateOptions {
  /** Clamped to 30–60 s; defaults to 45 s. */
  cooldownMs?: number;
  /** Consecutive noisy frames needed to start alerting. */
  enterFrames?: number;
  /** Consecutive clean frames needed to stop alerting. */
  releaseFrames?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * Threshold + hysteresis + cooldown state machine.
 *
 * - `enterFrames` consecutive `noisy` analyses activate the alert;
 * - while active, a new event is emitted at most once per cooldown window;
 * - `releaseFrames` consecutive clean analyses deactivate the alert;
 * - muted input is ignored and resets the hysteresis counters.
 */
export class NoiseGate {
  private readonly cooldownMs: number;
  private readonly enterFrames: number;
  private readonly releaseFrames: number;
  private readonly now: () => number;
  private noisyFrames = 0;
  private quietFrames = 0;
  private alerting = false;
  private muted = false;
  private lastEmittedAt: number | null = null;

  constructor(options: NoiseGateOptions = {}) {
    this.cooldownMs = resolveNoiseCooldownMs(options.cooldownMs);
    this.enterFrames = Math.max(1, Math.floor(options.enterFrames ?? NOISE_ENTER_FRAMES));
    this.releaseFrames = Math.max(1, Math.floor(options.releaseFrames ?? NOISE_RELEASE_FRAMES));
    this.now = options.now ?? Date.now;
  }

  /** True between threshold crossing and the release hysteresis. */
  get isAlerting(): boolean {
    return this.alerting;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Mic muted/disabled: drop counters, never emit, keep the cooldown clock. */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (muted) this.resetHysteresis();
  }

  /** Clears hysteresis and the cooldown clock (new device / new call). */
  reset(): void {
    this.muted = false;
    this.resetHysteresis();
    this.lastEmittedAt = null;
  }

  push(analysis: AudioFrameAnalysis, now: number = this.now()): NoiseDetectedEvent | null {
    if (this.muted) {
      this.resetHysteresis();
      return null;
    }
    if (!analysis.noisy) {
      this.noisyFrames = 0;
      if (this.alerting) {
        this.quietFrames += 1;
        if (this.quietFrames >= this.releaseFrames) this.resetHysteresis();
      }
      return null;
    }

    this.quietFrames = 0;
    this.noisyFrames += 1;
    if (!this.alerting) {
      if (this.noisyFrames < this.enterFrames) return null;
      this.alerting = true;
    }
    if (this.lastEmittedAt !== null && now - this.lastEmittedAt < this.cooldownMs) return null;
    this.lastEmittedAt = now;
    return { level: analysis.level, rms: analysis.rms, at: now };
  }

  private resetHysteresis(): void {
    this.noisyFrames = 0;
    this.quietFrames = 0;
    this.alerting = false;
  }
}

/* ------------------------------------------------------------------ */
/* Web Audio tap                                                      */
/* ------------------------------------------------------------------ */

/** Minimal timer surface, injectable so monitor lifecycle is testable. */
export type NoiseTimerHandle = unknown;

export interface NoiseTimerApi {
  setInterval(callback: () => void, intervalMs: number): NoiseTimerHandle;
  clearInterval(handle: NoiseTimerHandle): void;
}

const DEFAULT_TIMERS: NoiseTimerApi = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Reads time-domain samples from the local microphone analysis graph. */
export interface NoiseTap {
  read(target: Float32Array<ArrayBuffer>): void;
  disconnect(): void;
}

export interface NoiseTapContext {
  track: MediaStreamTrack;
  /** `null` only when a test injects its own tap factory. */
  audioContext: AudioContext | null;
  fftSize: number;
}

export type NoiseTapFactory = (context: NoiseTapContext) => NoiseTap;

export interface NoiseMonitorOptions {
  track: MediaStreamTrack;
  /** Called at most once per cooldown window while the input stays noisy. */
  onNoise: (event: NoiseDetectedEvent) => void;
  cooldownMs?: number;
  /** Analysis cadence, defaults to 100 ms. */
  intervalMs?: number;
  /** Analyser FFT size, power of two between 256 and 2048 (default 1024). */
  fftSize?: number;
  /** Optional shared context; the monitor never closes a context it did not create. */
  audioContext?: AudioContext;
  /** Sample rate override (tests); defaults to the context sample rate or 48 kHz. */
  sampleRate?: number;
  now?: () => number;
  timers?: NoiseTimerApi;
  /** Test seam: replaces the Web Audio analyser with a deterministic source. */
  tapFactory?: NoiseTapFactory;
}

function resolveFftSize(value: number | undefined): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1024;
  let size = 256;
  while (size * 2 <= requested && size < 2048) size *= 2;
  return size;
}

function createAudioContext(): AudioContext | null {
  try {
    if (typeof AudioContext === 'undefined') return null;
    return new AudioContext();
  } catch {
    return null;
  }
}

/**
 * Creates an unconnected analyser branch. Because the analyser is not wired to
 * `destination`, monitoring cannot produce audio or echo.
 */
function createWebAudioTap(
  track: MediaStreamTrack,
  audioContext: AudioContext,
  fftSize: number,
): NoiseTap | null {
  if (typeof MediaStream === 'undefined') return null;
  const stream = new MediaStream([track]);
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  return {
    read(target: Float32Array<ArrayBuffer>): void {
      analyser.getFloatTimeDomainData(target);
    },
    disconnect(): void {
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        analyser.disconnect();
      } catch {
        /* already disconnected */
      }
    },
  };
}

/**
 * Local microphone noise monitor.
 *
 * Lifecycle: `start()` → periodic analysis → `dispose()`. Muting the track
 * (`track.enabled=false`), `track.muted` or `setMuted(true)` pauses analysis
 * without emitting warnings; `dispose()` clears the timer, removes track
 * listeners, disconnects the audio graph and closes an owned AudioContext.
 */
export class NoiseMonitor {
  private readonly track: MediaStreamTrack;
  private readonly onNoise: (event: NoiseDetectedEvent) => void;
  private readonly intervalMs: number;
  private readonly fftSize: number;
  private readonly sampleRate: number;
  private readonly now: () => number;
  private readonly timers: NoiseTimerApi;
  private readonly tapFactory: NoiseTapFactory | null;
  private readonly gate: NoiseGate;
  private context: AudioContext | null;
  private ownsContext = false;
  private tap: NoiseTap | null = null;
  private timer: NoiseTimerHandle | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private running = false;
  private disposed = false;
  private externallyMuted = false;
  private readonly handleTrackEnded = (): void => this.dispose();

  constructor(options: NoiseMonitorOptions) {
    this.track = options.track;
    this.onNoise = options.onNoise;
    this.intervalMs = Math.max(50, Math.floor(options.intervalMs ?? NOISE_FRAME_INTERVAL_MS));
    this.fftSize = resolveFftSize(options.fftSize);
    this.context = options.audioContext ?? null;
    this.sampleRate =
      typeof options.sampleRate === 'number' && Number.isFinite(options.sampleRate) && options.sampleRate > 0
        ? options.sampleRate
        : options.audioContext?.sampleRate ?? 48_000;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.tapFactory = options.tapFactory ?? null;
    this.gate = new NoiseGate({ cooldownMs: options.cooldownMs, now: this.now });
  }

  /** The local track this monitor is attached to (used by the controller). */
  get sourceTrack(): MediaStreamTrack {
    return this.track;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isAlerting(): boolean {
    return this.gate.isAlerting;
  }

  /** Explicit mute (mic toggled off by the UI); track flags are checked too. */
  setMuted(muted: boolean): void {
    this.externallyMuted = muted;
    if (muted) this.gate.setMuted(true);
  }

  /** Starts analysis. Returns false when Web Audio is unavailable or the track is dead. */
  start(): boolean {
    if (this.disposed) return false;
    if (this.running) return true;
    if (!this.isTrackLive()) return false;

    if (!this.context && !this.tapFactory) {
      this.context = createAudioContext();
      this.ownsContext = this.context !== null;
    }
    if (!this.context && !this.tapFactory) return false;

    try {
      if (this.tapFactory) {
        this.tap = this.tapFactory({ track: this.track, audioContext: this.context, fftSize: this.fftSize });
      } else if (this.context) {
        this.tap = createWebAudioTap(this.track, this.context, this.fftSize);
      }
    } catch {
      this.tap = null;
    }
    if (!this.tap) {
      this.releaseContext();
      return false;
    }

    this.buffer = new Float32Array(this.fftSize);
    this.running = true;
    this.track.addEventListener?.('ended', this.handleTrackEnded);
    this.timer = this.timers.setInterval(() => this.tick(), this.intervalMs);
    if (this.ownsContext && this.context?.state === 'suspended') {
      void this.context.resume().catch(() => undefined);
    }
    return true;
  }

  /** Stops analysis and releases every browser resource held by the monitor. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    if (this.timer !== null) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.track.removeEventListener?.('ended', this.handleTrackEnded);
    } catch {
      /* track already gone */
    }
    try {
      this.tap?.disconnect();
    } catch {
      /* ignore */
    }
    this.tap = null;
    this.buffer = null;
    this.releaseContext();
    this.gate.reset();
  }

  private isTrackLive(): boolean {
    return this.track.readyState === 'live';
  }

  private isMuted(): boolean {
    return this.externallyMuted || !this.track.enabled || this.track.muted;
  }

  private tick(): void {
    if (!this.running || this.disposed) return;
    const muted = this.isMuted() || !this.isTrackLive();
    this.gate.setMuted(muted);
    if (muted) return;

    if (this.ownsContext && this.context?.state === 'suspended') {
      void this.context.resume().catch(() => undefined);
    }
    if (!this.tap || !this.buffer) return;
    try {
      this.tap.read(this.buffer);
    } catch {
      return;
    }
    const analysis = analyzeAudioFrame(this.buffer, this.sampleRate);
    const event = this.gate.push(analysis);
    if (event) this.onNoise(event);
  }

  private releaseContext(): void {
    if (this.ownsContext && this.context) {
      const context = this.context;
      this.context = null;
      this.ownsContext = false;
      void context.close().catch(() => undefined);
      return;
    }
    this.context = null;
    this.ownsContext = false;
  }
}
