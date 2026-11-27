/**
 * Media integrity: liveness challenge + frame-timing heuristics (contract §12).
 *
 * Honest limitations (documented in agil/core/docs/liveness-av.md): browser-side
 * detection is probabilistic. The liveness challenge reports signals of human
 * presence at that moment, and frame timing reports signs of synthetic feeds.
 *
 * Two liveness paths exist:
 *   - `security.liveness.enabled` → the server issues a random, tenant-scoped
 *     challenge (`POST /v1/rooms/:id/liveness/challenge`) and adjudicates the
 *     reported signals; the verdict is advisory, not certified.
 *   - legacy `security.mediaIntegrity.livenessChallenge` → local-only task.
 *
 * MediaPipe Face Landmarker is loaded lazily from the CDN; when it is
 * unavailable the checker reports `unknown` (never a false "suspicious").
 */
import type { LivenessChallengeResponse, LivenessSignals, ParticipantIntegrity, TenantConfig } from '@agil/protocol';
import type { ApiClient } from '../api.js';
import type { SignalingClient } from './signaling-client.js';
import { createFaceLandmarker, type FaceLandmarkerLike, type FaceLandmarkerResultLike } from './mediapipe.js';

export type LivenessTask = 'blink' | 'head-left' | 'head-right';

export interface IntegrityOptions {
  config: TenantConfig;
  signaling: SignalingClient;
  getVideoTrack: () => MediaStreamTrack | null;
  getVideoElement: () => HTMLVideoElement | null;
  /** REST client used for the server-issued challenge (absent = local only). */
  api?: ApiClient;
  /** Room id used by the liveness endpoints. */
  roomId?: string;
  onResult: (status: ParticipantIntegrity, score: number, flags: string[]) => void;
  onChallenge: (task: LivenessTask | null, state: 'running' | 'success' | 'failed' | 'unavailable') => void;
  onNote: (text: string) => void;
}

export interface FrameTimingResult {
  suspicious: boolean;
  score: number;
  flags: string[];
  samples: number;
}

/** What the local monitor observed; only these booleans reach the server. */
interface LivenessObservation {
  passed: boolean;
  signals: LivenessSignals;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 3) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

export class IntegrityChecker {
  private readonly options: IntegrityOptions;
  private heuristicTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastSent = '';

  constructor(options: IntegrityOptions) {
    this.options = options;
  }

  get enabled(): boolean {
    return this.options.config.security.mediaIntegrity.enabled;
  }

  /** True when the server can issue/track a challenge for this tenant. */
  get serverLivenessEnabled(): boolean {
    return Boolean(this.options.config.security.liveness.enabled && this.options.api && this.options.roomId);
  }

  get livenessEnabled(): boolean {
    return this.serverLivenessEnabled || (this.enabled && this.options.config.security.mediaIntegrity.livenessChallenge);
  }

  get frameHeuristicsEnabled(): boolean {
    return this.enabled && this.options.config.security.mediaIntegrity.frameHeuristics;
  }

  /** Periodic frame-timing sampling while joined. */
  start(): void {
    if (!this.frameHeuristicsEnabled || this.heuristicTimer) return;
    this.heuristicTimer = setInterval(() => {
      void this.sampleFrameTiming();
    }, 15_000);
  }

  stop(): void {
    if (this.heuristicTimer) {
      clearInterval(this.heuristicTimer);
      this.heuristicTimer = null;
    }
  }

  /** Measures frame callback regularity over ~2 s. */
  async sampleFrameTiming(): Promise<FrameTimingResult | null> {
    const video = this.options.getVideoElement();
    if (!video) return null;
    const intervals: number[] = [];
    await new Promise<void>((resolve) => {
      let last = 0;
      let count = 0;
      const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
        if (last > 0) intervals.push(metadata.mediaTime * 1000 - last);
        last = metadata.mediaTime * 1000;
        count += 1;
        if (count >= 40) {
          resolve();
          return;
        }
        requestAnimationFrame(() => onFrame(performance.now(), metadata));
      };
      const requestCallback = (
        video as HTMLVideoElement & {
          requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
        }
      ).requestVideoFrameCallback;
      if (typeof requestCallback === 'function') {
        requestCallback.call(video, onFrame);
      } else {
        resolve();
      }
      setTimeout(resolve, 2600);
    });
    if (intervals.length < 6) return null;
    const cv = coefficientOfVariation(intervals);
    const unique = new Set(intervals.map((value) => Math.round(value))).size;
    const flags: string[] = [];
    let score = 0.15;
    // Perfectly uniform frame delivery strongly suggests a synthetic source.
    if (cv < 0.01 && unique <= 2) {
      flags.push('frame_timing_uniform');
      score = 0.8;
    } else if (cv > 0.9) {
      flags.push('frame_timing_irregular');
      score = 0.55;
    }
    // A frozen or non-advancing feed is reported separately.
    if (intervals.every((value) => value === 0)) {
      flags.push('frame_timing_frozen');
      score = 0.7;
    }
    const result: FrameTimingResult = { suspicious: score >= this.options.config.security.mediaIntegrity.flagThreshold, score, flags, samples: intervals.length };
    if (this.enabled && result.suspicious) {
      this.emit('suspicious', score, flags);
    }
    return result;
  }

  private emit(status: ParticipantIntegrity, score: number, flags: string[]): void {
    const signature = `${status}:${score.toFixed(2)}:${flags.join(',')}`;
    if (signature === this.lastSent) return;
    this.lastSent = signature;
    this.options.signaling.send({ type: 'integrity', status, score, flags });
    this.options.onResult(status, score, flags);
  }

  /**
   * Runs a liveness challenge; resolves true when the (server-issued or local)
   * task was observed. A server verdict always wins when the endpoint answers;
   * any server failure degrades to the local verdict with an explicit note.
   */
  async runLivenessChallenge(): Promise<boolean> {
    if (!this.livenessEnabled) return false;
    const video = this.options.getVideoElement();
    const track = this.options.getVideoTrack();
    if (!video || !track) {
      this.options.onChallenge(null, 'unavailable');
      return false;
    }

    const remote = await this.requestRemoteChallenge();
    const landmarker = await createFaceLandmarker();
    const task = remote?.task ?? this.pickTask();
    if (!landmarker) {
      this.options.onNote('livenessUnavailable');
      this.options.onChallenge(null, 'unavailable');
      this.emit('unknown', 0.5, ['liveness_model_unavailable']);
      // Tell the server the model was unavailable so the attempt is auditable
      // (the verdict is `unavailable`, not a fabricated pass/fail).
      if (remote) await this.sendRemoteVerdict(remote, { modelAvailable: false, faceDetected: false }, false);
      return false;
    }

    this.options.onChallenge(task, 'running');
    this.running = true;
    const observation = await this.monitorTask(landmarker, video, task);
    this.running = false;
    landmarker.close?.();

    if (remote) {
      const verdict = await this.sendRemoteVerdict(remote, observation.signals, observation.passed);
      if (verdict !== null) {
        if (verdict === 'verified') {
          this.options.onChallenge(task, 'success');
          this.emit('verified', 0.9, []);
          return true;
        }
        if (verdict === 'failed') {
          // A failed/timed-out liveness check is not proof of a deepfake: report
          // `unknown` instead of accusing the participant.
          this.options.onChallenge(task, 'failed');
          this.emit('unknown', 0.4, ['liveness_failed']);
          return false;
        }
        this.options.onChallenge(null, 'unavailable');
        this.emit('unknown', 0.5, ['liveness_model_unavailable']);
        return false;
      }
      // Server unreachable on verify: fall through to the local verdict.
    }

    this.options.onChallenge(task, observation.passed ? 'success' : 'failed');
    if (observation.passed) {
      this.emit('verified', 0.9, []);
    } else {
      this.emit('unknown', 0.4, ['liveness_failed']);
    }
    return observation.passed;
  }

  /** Asks the server for a challenge; null when disabled/unavailable. */
  private async requestRemoteChallenge(): Promise<LivenessChallengeResponse | null> {
    if (!this.serverLivenessEnabled) return null;
    try {
      return await (this.options.api as ApiClient).createLivenessChallenge(this.options.roomId as string);
    } catch {
      // 403/501/network: keep the call usable, the local check still runs.
      this.options.onNote('livenessServerUnavailable');
      return null;
    }
  }

  /** Submits signals; returns the server status, or null when the call failed. */
  private async sendRemoteVerdict(
    challenge: LivenessChallengeResponse,
    signals: LivenessSignals,
    _localPassed: boolean,
  ): Promise<'verified' | 'failed' | 'unavailable' | null> {
    if (!this.serverLivenessEnabled) return null;
    try {
      const verdict = await (this.options.api as ApiClient).verifyLiveness(
        this.options.roomId as string,
        challenge.sessionId,
        signals,
      );
      if (verdict.status === 'verified') return 'verified';
      if (verdict.status === 'failed') return 'failed';
      return 'unavailable';
    } catch {
      this.options.onNote('livenessServerUnavailable');
      return null;
    }
  }

  private pickTask(): LivenessTask {
    const tasks: LivenessTask[] = ['blink', 'head-left', 'head-right'];
    return tasks[Math.floor(Math.random() * tasks.length)] ?? 'blink';
  }

  private monitorTask(landmarker: FaceLandmarkerLike, video: HTMLVideoElement, task: LivenessTask): Promise<LivenessObservation> {
    return new Promise<LivenessObservation>((resolve) => {
      const startedAt = performance.now();
      let blinkSeen = false;
      let blinkCompleted = false;
      let turned = false;
      let faceSeen = false;
      let frames = 0;
      const settle = (passed: boolean): void => {
        resolve({
          passed,
          signals: {
            faceDetected: faceSeen,
            blinkDetected: blinkCompleted,
            headTurnDetected: turned,
            modelAvailable: true,
            confidence: passed ? 0.9 : 0.3,
            framesAnalyzed: frames,
            durationMs: Math.round(performance.now() - startedAt),
          },
        });
      };
      const tick = (): void => {
        if (!this.running || video.readyState < 2) {
          settle(false);
          return;
        }
        let result: FaceLandmarkerResultLike | null = null;
        try {
          result = landmarker.detectForVideo(video, performance.now());
        } catch {
          result = null;
        }
        if (result) {
          frames += 1;
          if (result.faceLandmarks.length > 0) faceSeen = true;
          if (task === 'blink') {
            const categories = result.faceBlendshapes[0]?.categories ?? [];
            const left = categories.find((category) => category.categoryName === 'eyeBlinkLeft')?.score ?? 0;
            const right = categories.find((category) => category.categoryName === 'eyeBlinkRight')?.score ?? 0;
            if (left > 0.5 && right > 0.5) blinkSeen = true;
            if (blinkSeen && left < 0.3 && right < 0.3) {
              blinkCompleted = true;
              settle(true);
              return;
            }
          } else {
            const landmarks = result.faceLandmarks[0];
            if (landmarks) {
              const nose = landmarks[1];
              const leftCheek = landmarks[234];
              const rightCheek = landmarks[454];
              if (nose && leftCheek && rightCheek) {
                const middle = (leftCheek.x + rightCheek.x) / 2;
                // MediaPipe x is mirrored for a selfie camera: invert the sign.
                const delta = middle - nose.x;
                if (task === 'head-left' && delta > 0.05) turned = true;
                if (task === 'head-right' && delta < -0.05) turned = true;
                if (turned) {
                  settle(true);
                  return;
                }
              }
            }
          }
        }
        if (performance.now() - startedAt > 12_000) {
          settle(false);
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  reset(): void {
    this.lastSent = '';
  }
}
