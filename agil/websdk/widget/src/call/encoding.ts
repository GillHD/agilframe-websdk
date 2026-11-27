/**
 * Video encoding policy (docs/media-encoding.md).
 *
 * Browsers hand WebRTC raw camera frames, not a ready encoded stream: what we
 * can control is codec preference order (which lets the browser/OS use its
 * hardware encoder when available) and diagnostics of the chosen path.
 */
import { DEFAULT_VIDEO, videoCodecPriority, type TenantConfig } from '@agil/protocol';
import { resolutionFor } from './media.js';

export type VideoCodecName = 'av1' | 'h264' | 'vp9' | 'vp8';
export type EncodingStrategy = 'auto' | 'prefer-hardware' | 'software-only';
export type HardwarePath = 'hardware' | 'software' | 'unknown';

interface CodecCapabilityLike {
  mimeType: string;
  clockRate?: number;
  channels?: number;
  sdpFmtpLine?: string;
}

export interface EncodingInfo {
  codec: VideoCodecName | null;
  strategy: EncodingStrategy;
  hardware: HardwarePath;
  /** Human label for the settings panel. */
  label: string;
}

function videoConfig(config: TenantConfig): Partial<TenantConfig['video']> {
  return config.video ?? {};
}

const MIME: Record<VideoCodecName, string> = {
  av1: 'video/av1',
  h264: 'video/h264',
  vp9: 'video/vp9',
  vp8: 'video/vp8',
};

/** Ordered codec preference from the tenant config (encoding.preferredCodecs). */
export function preferredVideoCodecs(config: TenantConfig): VideoCodecName[] {
  const video = videoConfig(config);
  const strategy = video.encoding?.strategy ?? 'auto';
  const enabled = video.codecs?.length ? video.codecs : DEFAULT_VIDEO.codecs;
  if (strategy === 'software-only') {
    // Software encoders: VP8/H.264 baseline are the most reliable fallback.
    const software: VideoCodecName[] = ['vp8', 'h264', 'vp9', 'av1'];
    return software.filter((codec) => enabled.includes(codec));
  }
  const ordered = [...new Set([...videoCodecPriority(video), ...enabled])];
  if (strategy !== 'prefer-hardware') return ordered;
  return ordered.sort((first, second) => accelerationRank(config, second) - accelerationRank(config, first));
}

function codecCapabilities(kind: 'audio' | 'video' = 'video'): CodecCapabilityLike[] {
  try {
    const sender = (globalThis as unknown as { RTCRtpSender?: typeof RTCRtpSender }).RTCRtpSender;
    const receiver = (globalThis as unknown as { RTCRtpReceiver?: typeof RTCRtpReceiver }).RTCRtpReceiver;
    const senderCaps = sender?.getCapabilities?.(kind);
    if (senderCaps?.codecs?.length) return senderCaps.codecs;
    const receiverCaps = receiver?.getCapabilities?.(kind);
    return receiverCaps?.codecs ?? [];
  } catch {
    return [];
  }
}

function sortedAudioCodecs(config: TenantConfig): CodecCapabilityLike[] {
  const { codecs, preferredCodec } = config.audio;
  const primaryOrder = [preferredCodec, ...codecs]
    .filter((codec) => codec !== 'red' && codecs.includes(codec));
  const rank = new Map([...new Set(primaryOrder)].map((codec, index) => [`audio/${codec}`, index]));
  const capabilities = codecCapabilities('audio');
  const name = (codec: CodecCapabilityLike) => codec.mimeType.toLowerCase();
  const primary = capabilities.filter((codec) => rank.has(name(codec)));
  if (primary.length === 0) return [];
  primary.sort((a, b) => rank.get(name(a))! - rank.get(name(b))!);
  const allowRed = codecs.includes('red') && primary.some((codec) => name(codec) === 'audio/opus');
  const supplemental = capabilities.filter((codec) =>
    ['audio/cn', 'audio/telephone-event'].includes(name(codec)) || (allowRed && name(codec) === 'audio/red'),
  );
  return [...primary, ...supplemental];
}

/**
 * Reorders browser video capabilities by the tenant preference, drops H.265,
 * keeps RTX/red/ulpfec after the primary codecs (needed for retransmissions).
 */
export function sortedVideoCodecs(config: TenantConfig): CodecCapabilityLike[] {
  const preferred = preferredVideoCodecs(config);
  const rank = new Map(preferred.map((codec, index) => [MIME[codec], index]));
  const capabilities = codecCapabilities().filter((codec) => !/h265|hevc/i.test(codec.mimeType));
  const name = (codec: CodecCapabilityLike) => codec.mimeType.toLowerCase();
  const chosen = capabilities.filter((codec) => rank.has(name(codec)));
  if (!chosen.length) return capabilities;
  chosen.sort((a, b) => {
    const aMime = (a.mimeType || '').toLowerCase();
    const bMime = (b.mimeType || '').toLowerCase();
    const aRank = rank.get(aMime) ?? 999;
    const bRank = rank.get(bMime) ?? 999;
    return aRank - bRank;
  });
  const supplemental = capabilities.filter((codec) => /^video\/(rtx|red|ulpfec|flexfec(?:-03)?)$/.test(name(codec)));
  return [...chosen, ...supplemental];
}

/** Best primary codec supported by this browser, in tenant order. */
export function selectedVideoCodec(config: TenantConfig): VideoCodecName | null {
  const supported = new Set(
    codecCapabilities()
      .map((codec) => (codec.mimeType || '').toLowerCase())
      .filter((mime) => !/h265|hevc|rtx|red|ulpfec|flexfec/i.test(mime)),
  );
  for (const codec of preferredVideoCodecs(config)) {
    if (supported.has(MIME[codec])) return codec;
  }
  return null;
}

/** Applies codec order to a transceiver (mesh path); never throws. */
export function applyCodecPreferencesToTransceiver(
  transceiver: RTCRtpTransceiver,
  kind: 'audio' | 'video',
  config: TenantConfig,
): void {
  const target = transceiver as RTCRtpTransceiver & {
    setCodecPreferences?: (codecs: CodecCapabilityLike[]) => void;
  };
  if (!target.setCodecPreferences) return;
  try {
    const codecs = kind === 'video' ? sortedVideoCodecs(config) : sortedAudioCodecs(config);
    if (codecs.length > 0) target.setCodecPreferences(codecs);
  } catch (error) {
    console.warn('[agil] setCodecPreferences failed', error);
  }
}

const rtcAcceleration = new Map<string, number>();

function accelerationProfile(config: TenantConfig, codec: VideoCodecName) {
  const { maxResolution = DEFAULT_VIDEO.maxResolution, maxFps = DEFAULT_VIDEO.maxFps,
    maxBitrateKbps = DEFAULT_VIDEO.maxBitrateKbps } = videoConfig(config);
  return { key: `${codec}:${maxResolution}:${maxFps}:${maxBitrateKbps}`, video: { contentType: MIME[codec],
    ...resolutionFor(maxResolution), bitrate: maxBitrateKbps * 1000, framerate: maxFps } };
}

function accelerationRank(config: TenantConfig, codec: VideoCodecName): number {
  return rtcAcceleration.get(accelerationProfile(config, codec).key) ?? 0;
}

const accelerationProbes = new Map<string, Promise<void>>();

/** Prepare a codec order based on WebRTC capabilities, before negotiation. */
export async function prepareVideoCodecPreferences(config: TenantConfig): Promise<void> {
  const api = globalThis.navigator?.mediaCapabilities;
  if (!api?.encodingInfo || !api?.decodingInfo) return;
  const supported = new Set(codecCapabilities().map((option) => option.mimeType.toLowerCase()));
  const pending = preferredVideoCodecs(config).filter((codec) => supported.has(MIME[codec])).map((codec) => {
    const { key, video } = accelerationProfile(config, codec);
    let probe = accelerationProbes.get(key);
    if (!probe) {
      probe = Promise.resolve().then(async () => {
        const [encoded, decoded] = await Promise.all([
          api.encodingInfo({ type: 'webrtc', video }), api.decodingInfo({ type: 'webrtc', video }),
        ]);
        if (encoded.supported) {
          rtcAcceleration.set(key, encoded.powerEfficient ? (decoded.supported && decoded.powerEfficient ? 2 : 1) : 0);
        }
      }).catch(() => undefined);
      accelerationProbes.set(key, probe);
    }
    return probe;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all(pending), new Promise<void>((resolve) => { timer = setTimeout(resolve, 250); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Synchronous part used by the settings panel (cached hardware diagnostic). */
export function currentEncodingInfo(config: TenantConfig): EncodingInfo {
  const video = videoConfig(config);
  const strategy = video.encoding?.strategy ?? 'auto';
  const codec = selectedVideoCodec(config);
  const rank = codec ? rtcAcceleration.get(accelerationProfile(config, codec).key) : undefined;
  const hardware: HardwarePath = rank === undefined ? 'unknown' : rank > 0 ? 'hardware' : 'software';
  const codecLabel = codec ? codec.toUpperCase() : '—';
  const hardwareLabel =
    hardware === 'hardware' ? 'вероятно доступно' : hardware === 'software' ? 'не подтверждено' : 'нет данных';
  return { codec, strategy, hardware, label: `${codecLabel} · ${hardwareLabel}` };
}

/** Kicks the async probe (settings panel calls this once) and returns fresh info. */
export async function refreshEncodingInfo(config: TenantConfig): Promise<EncodingInfo> {
  await prepareVideoCodecPreferences(config);
  return currentEncodingInfo(config);
}

/** Whether the tenant asked for simulcast/SVC (best effort for SFU options). */
export function wantsSimulcast(config: TenantConfig): boolean {
  return Boolean(videoConfig(config).simulcast);
}
