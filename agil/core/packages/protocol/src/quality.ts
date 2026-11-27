/**
 * Network quality policy: turns RTC stats into a user-visible tier and a set of
 * concrete actions (reduce video, drop to audio-only, fall back to chat).
 */
import type { TenantConfig } from './config.js';

export type LowBandwidthConfig = TenantConfig['fallback']['lowBandwidth'];
export type QualityTier = 'good' | 'fair' | 'poor' | 'critical' | 'offline';

export const qualityTierOrder: QualityTier[] = ['offline', 'critical', 'poor', 'fair', 'good'];

export interface QualitySnapshot {
  connectionState?: string;
  iceConnectionState?: string;
  /** Round-trip time in ms. */
  rttMs: number;
  /** Packet loss, percent 0..100. */
  packetLossPct: number;
  jitterMs: number;
  /** Inbound media bitrate in kbps (all tracks). */
  inboundBitrateKbps: number;
  /** Available outgoing bitrate reported by the browser, kbps. */
  availableOutgoingBitrateKbps?: number;
  fps: number;
  width: number;
  height: number;
}

export interface QualityVideoTarget {
  resolution: '720p' | '540p' | '360p' | '180p';
  fps: number;
  bitrateKbps: number;
}

export interface QualityActions {
  video: 'on' | 'reduced' | 'off';
  videoTarget: QualityVideoTarget;
  audio: 'on' | 'reduced';
  /** Chat traffic must keep working over the signaling socket. */
  chatFallback: boolean;
  /** Reconnect / ICE restart recommended. */
  reconnect: boolean;
  showBanner: boolean;
}

export interface QualityDecision {
  tier: QualityTier;
  score: number;
  actions: QualityActions;
  reasons: string[];
}

const VIDEO_TARGETS: Record<'720p' | '540p' | '360p' | '180p', QualityVideoTarget> = {
  '720p': { resolution: '720p', fps: 30, bitrateKbps: 1800 },
  '540p': { resolution: '540p', fps: 24, bitrateKbps: 900 },
  '360p': { resolution: '360p', fps: 15, bitrateKbps: 400 },
  '180p': { resolution: '180p', fps: 10, bitrateKbps: 150 },
};

function tierFromThresholds(snapshot: QualitySnapshot, cfg: LowBandwidthConfig): { tier: QualityTier; reasons: string[] } {
  if (
    snapshot.connectionState === 'failed' ||
    snapshot.connectionState === 'closed' ||
    snapshot.iceConnectionState === 'failed' ||
    snapshot.iceConnectionState === 'disconnected'
  ) {
    return { tier: 'offline', reasons: ['connection_failed'] };
  }

  const reasons: string[] = [];
  let worst: QualityTier = 'good';
  const rank: Record<QualityTier, number> = { good: 0, fair: 1, poor: 2, critical: 3, offline: 4 };
  const bump = (tier: QualityTier, reason: string) => {
    if (rank[tier] > rank[worst]) worst = tier;
    if (tier !== 'good') reasons.push(`${reason}:${tier}`);
  };

  const { enterThreshold: enter, restoreThreshold: restore } = cfg;
  const goodRtt = restore.rttMs;
  const goodLoss = restore.lossPct;
  const goodBitrate = restore.minBitrateKbps;

  // RTT
  if (snapshot.rttMs > enter.rttMs * 1.25) bump('critical', 'rtt');
  else if (snapshot.rttMs > enter.rttMs) bump('poor', 'rtt');
  else if (snapshot.rttMs > goodRtt) bump('fair', 'rtt');

  // Packet loss
  if (snapshot.packetLossPct > enter.lossPct * 2) bump('critical', 'loss');
  else if (snapshot.packetLossPct > enter.lossPct) bump('poor', 'loss');
  else if (snapshot.packetLossPct > goodLoss) bump('fair', 'loss');

  // Jitter
  if (snapshot.jitterMs > enter.jitterMs * 2) bump('critical', 'jitter');
  else if (snapshot.jitterMs > enter.jitterMs) bump('poor', 'jitter');

  // Use the transport's bandwidth estimate. Received bitrate and dimensions
  // depend on content, selected quality and capture settings.
  const bandwidth = snapshot.availableOutgoingBitrateKbps ?? 0;
  if (bandwidth > 0) {
    if (bandwidth < enter.minBitrateKbps * 0.5) bump('critical', 'bitrate');
    else if (bandwidth < enter.minBitrateKbps) bump('poor', 'bitrate');
    else if (bandwidth < goodBitrate) bump('fair', 'bitrate');
  }

  return { tier: worst, reasons };
}

/** 0..100 quality score for UI display (higher is better). */
export function scoreQuality(snapshot: QualitySnapshot, cfg: LowBandwidthConfig): number {
  let score = 100;
  const { enterThreshold: enter } = cfg;
  score -= Math.min(30, Math.max(0, (snapshot.rttMs / Math.max(enter.rttMs, 1)) * 20));
  score -= Math.min(30, (snapshot.packetLossPct / Math.max(enter.lossPct, 0.1)) * 18);
  score -= Math.min(15, (snapshot.jitterMs / Math.max(enter.jitterMs, 1)) * 10);
  const bandwidth = snapshot.availableOutgoingBitrateKbps ?? 0;
  if (bandwidth > 0) {
    score -= Math.min(25, Math.max(0, 1 - bandwidth / Math.max(enter.minBitrateKbps, 1)) * 25);
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Decides what to do right now. `previousTier` adds hysteresis so the UI does not
 * flap between reduced and normal video on a single bad stats sample.
 */
export function evaluateQuality(
  snapshot: QualitySnapshot,
  cfg: LowBandwidthConfig,
  previousTier?: QualityTier,
): QualityDecision {
  const { tier, reasons } = tierFromThresholds(snapshot, cfg);
  const score = scoreQuality(snapshot, cfg);
  const strategy = cfg.strategy;

  const actions: QualityActions = {
    video: 'on',
    videoTarget: { ...VIDEO_TARGETS['720p'] },
    audio: 'on',
    chatFallback: false,
    reconnect: false,
    showBanner: false,
  };

  switch (tier) {
    case 'good':
      break;
    case 'fair':
      actions.video = 'reduced';
      actions.videoTarget = { ...VIDEO_TARGETS['540p'] };
      break;
    case 'poor':
      if (strategy === 'reduce-video') {
        actions.video = 'reduced';
        actions.videoTarget = { ...VIDEO_TARGETS['360p'] };
        actions.showBanner = true;
      } else if (strategy === 'audio-only') {
        actions.video = 'off';
        actions.audio = 'reduced';
        actions.chatFallback = true;
        actions.showBanner = true;
      } else {
        actions.video = 'off';
        actions.chatFallback = true;
        actions.showBanner = true;
      }
      break;
    case 'critical':
      actions.video = 'off';
      actions.audio = 'reduced';
      actions.chatFallback = true;
      actions.reconnect = cfg.iceRestartOnFailure;
      actions.showBanner = true;
      break;
    case 'offline':
      actions.video = 'off';
      actions.audio = 'reduced';
      actions.chatFallback = true;
      actions.reconnect = true;
      actions.showBanner = true;
      break;
  }

  if (!cfg.enabled) {
    actions.video = 'on';
    actions.videoTarget = { ...VIDEO_TARGETS['720p'] };
    actions.audio = 'on';
    actions.chatFallback = false;
    actions.reconnect = false;
    if (tier !== 'offline') actions.showBanner = false;
    return { tier, score, actions, reasons };
  }

  // Hysteresis: do not restore video on a single "fair" sample after a drop.
  const rank: Record<QualityTier, number> = { good: 0, fair: 1, poor: 2, critical: 3, offline: 4 };
  if (previousTier && rank[tier] + 1 < rank[previousTier] && tier !== 'offline') {
    actions.video = previousTier === 'good' || previousTier === 'fair' ? actions.video : 'off';
  }

  return { tier, score, actions, reasons };
}

export function shouldEscalate(previous: QualityTier | undefined, next: QualityTier): boolean {
  const rank: Record<QualityTier, number> = { good: 0, fair: 1, poor: 2, critical: 3, offline: 4 };
  if (!previous) return false;
  return rank[next] > rank[previous];
}

export function tierLabel(tier: QualityTier, locale: 'ru' | 'en' = 'ru'): string {
  const labels: Record<QualityTier, { ru: string; en: string }> = {
    good: { ru: 'Хорошее соединение', en: 'Good connection' },
    fair: { ru: 'Среднее соединение', en: 'Fair connection' },
    poor: { ru: 'Плохое соединение', en: 'Poor connection' },
    critical: { ru: 'Критическое соединение', en: 'Critical connection' },
    offline: { ru: 'Соединение потеряно', en: 'Connection lost' },
  };
  return labels[tier][locale];
}
