/**
 * Media acquisition and device management (contract §6: getUserMedia with
 * audio/video constraints from tenant config, device switching, screen share).
 *
 * Every failure is normalized to `MediaAccessError`; the UI translates its code
 * into a human sentence and offers the listen-only fallback.
 */
import type { TenantConfig } from '@agil/protocol';
import type { I18nKey } from '../i18n.js';

export type MediaErrorCode = 'permission_denied' | 'not_found' | 'in_use' | 'constraints' | 'unsupported' | 'unknown';

/** UI copy for every media error code (localized at the presentation boundary). */
export const MEDIA_ERROR_KEYS: Record<MediaErrorCode, I18nKey> = {
  permission_denied: 'mediaPermissionDenied',
  not_found: 'mediaDeviceNotFound',
  in_use: 'mediaDeviceBusy',
  constraints: 'mediaConstraintsFailed',
  unsupported: 'mediaUnsupported',
  unknown: 'mediaErrorGeneric',
};

export class MediaAccessError extends Error {
  readonly code: MediaErrorCode;
  /** i18n key the UI must render instead of `message`. */
  readonly messageKey: I18nKey;

  constructor(code: MediaErrorCode, message: string, messageKey: I18nKey = MEDIA_ERROR_KEYS[code]) {
    super(message);
    this.name = 'MediaAccessError';
    this.code = code;
    this.messageKey = messageKey;
  }
}

export function mapMediaError(error: unknown): MediaAccessError {
  if (error instanceof MediaAccessError) return error;
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new MediaAccessError('permission_denied', message);
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return new MediaAccessError('not_found', message);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new MediaAccessError('in_use', message);
    case 'TypeError':
    case 'OverconstrainedErrorConstraint':
      return new MediaAccessError('constraints', message);
    default:
      return new MediaAccessError('unknown', message);
  }
}

export interface DeviceLists {
  microphones: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
}

export function resolutionFor(maxResolution: TenantConfig['video']['maxResolution']): { width: number; height: number } {
  switch (maxResolution) {
    case '1080p':
      return { width: 1920, height: 1080 };
    case '720p':
      return { width: 1280, height: 720 };
    case '540p':
      return { width: 960, height: 540 };
    case '360p':
      return { width: 640, height: 360 };
    default:
      return { width: 1280, height: 720 };
  }
}

export function audioConstraints(config: TenantConfig, deviceId?: string | null): MediaTrackConstraints {
  const base: MediaTrackConstraints = {
    echoCancellation: config.audio.echoCancellation,
    noiseSuppression: config.audio.noiseSuppression,
    autoGainControl: config.audio.autoGainControl,
    channelCount: config.audio.stereo ? 2 : 1,
  };
  if (deviceId) base.deviceId = { exact: deviceId };
  return base;
}

export function videoConstraints(config: TenantConfig, deviceId?: string | null): MediaTrackConstraints {
  const { width, height } = resolutionFor(config.video.maxResolution);
  const base: MediaTrackConstraints = {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: config.video.maxFps, max: config.video.maxFps },
    facingMode: 'user',
  };
  if (deviceId) base.deviceId = { exact: deviceId };
  return base;
}

export interface AcquireOptions {
  micEnabled: boolean;
  camEnabled: boolean;
  micDeviceId?: string | null;
  camDeviceId?: string | null;
}

export interface AcquireResult {
  stream: MediaStream;
  audioError?: MediaAccessError;
  videoError?: MediaAccessError;
}

export class MediaController {
  private stream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private noiseSuppression: boolean | undefined;

  constructor(private readonly onCaptureEnded?: (kind: 'audio' | 'video') => void) {}

  private watchCapture(track: MediaStreamTrack, kind: 'audio' | 'video'): void {
    track.addEventListener('ended', () => {
      const stream = this.stream;
      if (!stream?.getTracks().includes(track)) return;
      stream.removeTrack(track);
      this.onCaptureEnded?.(kind);
    }, { once: true });
  }

  private micConstraints(config: TenantConfig, deviceId?: string | null): MediaTrackConstraints {
    const constraints = audioConstraints(config, deviceId);
    return this.noiseSuppression === undefined ? constraints : { ...constraints, noiseSuppression: this.noiseSuppression };
  }

  async setNoiseSuppression(enabled: boolean): Promise<void> {
    const track = this.audioTrack;
    if (track) await track.applyConstraints({ ...track.getConstraints(), noiseSuppression: enabled });
    this.noiseSuppression = enabled;
  }

  get localStream(): MediaStream | null {
    return this.stream;
  }

  get currentScreenStream(): MediaStream | null {
    return this.screenStream;
  }

  get audioTrack(): MediaStreamTrack | null {
    return this.stream?.getAudioTracks()[0] ?? null;
  }

  get videoTrack(): MediaStreamTrack | null {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  /**
   * A combined request allows one permission prompt and one capture startup.
   * Retry devices individually if the browser cannot provide both.
   */
  async acquire(config: TenantConfig, options: AcquireOptions): Promise<AcquireResult> {
    this.stopLocal();
    const stream = new MediaStream();
    let audioError: MediaAccessError | undefined;
    let videoError: MediaAccessError | undefined;
    const audioConstraints = () => this.micConstraints(config, options.micDeviceId);
    const cameraConstraints = () => videoConstraints(config, options.camDeviceId);
    if (options.micEnabled && options.camEnabled) {
      try {
        const capture = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: cameraConstraints() });
        for (const track of capture.getTracks()) {
          track.contentHint = track.kind === 'audio' ? 'speech' : config.video.contentHint;
          stream.addTrack(track);
        }
      } catch {
        // A denied or unavailable device must not prevent using the other.
      }
    }

    if (options.micEnabled && stream.getAudioTracks().length === 0) {
      try {
        const audio = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints(),
          video: false,
        });
        for (const track of audio.getAudioTracks()) {
          track.contentHint = 'speech';
          stream.addTrack(track);
        }
      } catch (error) {
        audioError = mapMediaError(error);
      }
    }

    if (options.camEnabled && stream.getVideoTracks().length === 0) {
      try {
        const video = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: cameraConstraints(),
        });
        for (const track of video.getVideoTracks()) {
          track.contentHint = config.video.contentHint;
          stream.addTrack(track);
        }
      } catch (error) {
        videoError = mapMediaError(error);
      }
    }

    this.stream = stream;
    for (const track of stream.getAudioTracks()) this.watchCapture(track, 'audio');
    for (const track of stream.getVideoTracks()) this.watchCapture(track, 'video');

    // Listen-only fallback: keep an empty stream object (no tracks) so the
    // engine and UI have a stable object to work with.
    return { stream, audioError, videoError };
  }

  async requestAudio(config: TenantConfig, deviceId?: string | null): Promise<MediaStreamTrack> {
    const media = await navigator.mediaDevices.getUserMedia({
      audio: this.micConstraints(config, deviceId),
      video: false,
    });
    const track = media.getAudioTracks()[0];
    if (!track) throw new MediaAccessError('not_found', 'no audio track in getUserMedia result', 'mediaMicrophoneUnavailable');
    return track;
  }

  async requestVideo(config: TenantConfig, deviceId?: string | null): Promise<MediaStreamTrack> {
    const media = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: videoConstraints(config, deviceId),
    });
    const track = media.getVideoTracks()[0];
    if (!track) throw new MediaAccessError('not_found', 'no video track in getUserMedia result', 'mediaCameraUnavailable');
    track.contentHint = config.video.contentHint;
    return track;
  }

  /** Adopts a track acquired on demand (mic/camera toggled on after joining). */
  adoptAudioTrack(track: MediaStreamTrack): void {
    const stream = this.stream ?? new MediaStream();
    const existing = stream.getAudioTracks()[0];
    if (existing && existing !== track) {
      stream.removeTrack(existing);
      existing.stop();
    }
    if (!stream.getAudioTracks().includes(track)) {
      stream.addTrack(track);
      this.watchCapture(track, 'audio');
    }
    this.stream = stream;
  }

  /** Adopts a track acquired on demand (camera toggled on after joining). */
  adoptVideoTrack(track: MediaStreamTrack): void {
    const stream = this.stream ?? new MediaStream();
    const existing = stream.getVideoTracks()[0];
    if (existing && existing !== track) {
      stream.removeTrack(existing);
      existing.stop();
    }
    if (!stream.getVideoTracks().includes(track)) {
      stream.addTrack(track);
      this.watchCapture(track, 'video');
    }
    this.stream = stream;
  }

  releaseVideoTrack(): void {
    for (const track of this.stream?.getVideoTracks() ?? []) {
      this.stream?.removeTrack(track);
      track.stop();
    }
  }

  /** Replaces the microphone track in the local stream, returns the new track. */
  async switchMicrophone(config: TenantConfig, deviceId: string): Promise<MediaStreamTrack> {
    const track = await this.requestAudio(config, deviceId);
    const stream = this.stream ?? new MediaStream();
    const old = stream.getAudioTracks()[0];
    if (old) {
      stream.removeTrack(old);
      old.stop();
    }
    stream.addTrack(track);
    this.watchCapture(track, 'audio');
    this.stream = stream;
    return track;
  }

  /** Replaces the camera track in the local stream, returns the new track. */
  async switchCamera(config: TenantConfig, deviceId: string): Promise<MediaStreamTrack> {
    const track = await this.requestVideo(config, deviceId);
    const previous = this.stream;
    const next = new MediaStream();
    for (const audio of previous?.getAudioTracks() ?? []) next.addTrack(audio);
    next.addTrack(track);
    this.watchCapture(track, 'video');
    this.stream = next;
    // Stop the old video only after the new stream exists; keep audio untouched.
    for (const old of previous?.getVideoTracks() ?? []) old.stop();
    return track;
  }

  async enumerate(): Promise<DeviceLists> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return { microphones: [], cameras: [], speakers: [] };
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      microphones: devices.filter((device) => device.kind === 'audioinput'),
      cameras: devices.filter((device) => device.kind === 'videoinput'),
      speakers: devices.filter((device) => device.kind === 'audiooutput'),
    };
  }

  async startScreenShare(config: TenantConfig): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new MediaAccessError('unsupported', 'getDisplayMedia is not supported');
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: config.session.screenShare.maxFps, max: config.session.screenShare.maxFps },
          width: { max: config.session.screenShare.maxWidth },
        } as MediaTrackConstraints,
        audio: config.session.screenShare.shareAudio,
      });
    } catch (error) {
      // Normalize DOMException (NotAllowedError, AbortError, …) to a code the UI localizes.
      throw mapMediaError(error);
    }
    this.screenStream = stream;
    const track = stream.getVideoTracks()[0];
    if (track) track.contentHint = config.session.screenShare.preferMotion ? 'motion' : 'detail';
    return stream;
  }

  stopScreenShare(): void {
    if (!this.screenStream) return;
    for (const track of this.screenStream.getTracks()) track.stop();
    this.screenStream = null;
  }

  stopLocal(): void {
    if (!this.stream) return;
    for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
  }

  stopAll(): void {
    this.stopScreenShare();
    this.stopLocal();
  }

  /** Applies a video target (from `evaluateQuality` actions) to the local camera track. */
  applyVideoTarget(target: { resolution: string; fps: number }): void {
    const track = this.videoTrack;
    if (!track) return;
    const resolution = resolutionFor(target.resolution as TenantConfig['video']['maxResolution']);
    track
      .applyConstraints({
        width: { ideal: resolution.width },
        height: { ideal: resolution.height },
        frameRate: { ideal: target.fps, max: target.fps },
      })
      .catch(() => {
        /* constraints are best-effort — a degraded browser must not break the call */
      });
  }
}
