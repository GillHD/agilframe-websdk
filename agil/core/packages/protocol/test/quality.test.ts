import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FALLBACK } from '../src/config.js';
import { evaluateQuality, scoreQuality, shouldEscalate, tierLabel } from '../src/quality.js';
import type { LowBandwidthConfig, QualitySnapshot } from '../src/quality.js';

const cfg: LowBandwidthConfig = DEFAULT_FALLBACK.lowBandwidth;

const good: QualitySnapshot = {
  connectionState: 'connected',
  iceConnectionState: 'connected',
  rttMs: 40,
  packetLossPct: 0.2,
  jitterMs: 8,
  inboundBitrateKbps: 1500,
  fps: 30,
  width: 1280,
  height: 720,
};

test('good network keeps video on', () => {
  const decision = evaluateQuality(good, cfg);
  assert.equal(decision.tier, 'good');
  assert.equal(decision.actions.video, 'on');
  assert.equal(decision.actions.chatFallback, false);
  assert.ok(decision.score > 80);
});

test('a low-bitrate preview is not a link impairment', () => {
  const preview = { ...good, inboundBitrateKbps: 32, width: 160, height: 90, fps: 10 };
  for (const availableOutgoingBitrateKbps of [undefined, 1200]) {
    const decision = evaluateQuality({ ...preview, availableOutgoingBitrateKbps }, cfg);
    assert.equal(decision.tier, 'good');
    assert.equal(decision.actions.video, 'on');
    assert.equal(decision.score, scoreQuality(good, cfg));
  }
});

test('a low transport bandwidth estimate still triggers fallback', () => {
  const decision = evaluateQuality({ ...good, availableOutgoingBitrateKbps: 100 }, { ...cfg, strategy: 'audio-only' });
  assert.equal(decision.tier, 'poor');
  assert.equal(decision.actions.video, 'off');
  assert.deepEqual(decision.reasons, ['bitrate:poor']);
});

test('fair network reduces video only', () => {
  const decision = evaluateQuality({ ...good, rttMs: 250, packetLossPct: 2 }, cfg);
  assert.equal(decision.tier, 'fair');
  assert.equal(decision.actions.video, 'reduced');
  assert.equal(decision.actions.chatFallback, false);
});

test('poor network with reduce-video strategy degrades resolution', () => {
  const decision = evaluateQuality({ ...good, rttMs: 500, packetLossPct: 6, jitterMs: 90 }, cfg);
  assert.equal(decision.tier, 'poor');
  assert.equal(decision.actions.video, 'reduced');
  assert.equal(decision.actions.videoTarget.resolution, '360p');
  assert.equal(decision.actions.showBanner, true);
});

test('critical network turns video off and enables chat fallback', () => {
  const decision = evaluateQuality(
    { ...good, rttMs: 2000, packetLossPct: 30, jitterMs: 400, inboundBitrateKbps: 40 },
    cfg,
  );
  assert.equal(decision.tier, 'critical');
  assert.equal(decision.actions.video, 'off');
  assert.equal(decision.actions.chatFallback, true);
  assert.equal(decision.actions.reconnect, true);
});

test('chat-first strategy drops video already at poor', () => {
  const decision = evaluateQuality(
    { ...good, rttMs: 500, packetLossPct: 6, jitterMs: 90 },
    { ...cfg, strategy: 'chat-first' },
  );
  assert.equal(decision.actions.video, 'off');
  assert.equal(decision.actions.chatFallback, true);
});

test('audio-only strategy drops video at poor', () => {
  const decision = evaluateQuality(
    { ...good, rttMs: 500, packetLossPct: 6, jitterMs: 90 },
    { ...cfg, strategy: 'audio-only' },
  );
  assert.equal(decision.actions.video, 'off');
  assert.equal(decision.actions.audio, 'reduced');
});

test('offline when connection failed', () => {
  const decision = evaluateQuality({ ...good, connectionState: 'failed' }, cfg);
  assert.equal(decision.tier, 'offline');
  assert.equal(decision.actions.reconnect, true);
  assert.equal(decision.actions.chatFallback, true);
});

test('disabled fallback keeps audio and video on under critical conditions', () => {
  const decision = evaluateQuality({ ...good, rttMs: 2000, packetLossPct: 30 }, { ...cfg, enabled: false });
  assert.equal(decision.actions.video, 'on');
  assert.equal(decision.actions.audio, 'on');
  assert.equal(decision.actions.chatFallback, false);
});

test('disabling fallback bypasses recovery hysteresis', () => {
  const decision = evaluateQuality(good, { ...cfg, enabled: false }, 'critical');
  assert.equal(decision.tier, 'good');
  assert.equal(decision.actions.video, 'on');
});

test('scoreQuality is bounded and decreases with loss', () => {
  assert.ok(scoreQuality(good, cfg) <= 100 && scoreQuality(good, cfg) >= 0);
  const worse = scoreQuality({ ...good, packetLossPct: 20, rttMs: 900 }, cfg);
  assert.ok(worse < scoreQuality(good, cfg));
});

test('shouldEscalate compares tiers', () => {
  assert.equal(shouldEscalate('good', 'poor'), true);
  assert.equal(shouldEscalate('poor', 'fair'), false);
  assert.equal(shouldEscalate(undefined, 'critical'), false);
});

test('tierLabel is localized', () => {
  assert.equal(tierLabel('poor', 'ru'), 'Плохое соединение');
  assert.equal(tierLabel('poor', 'en'), 'Poor connection');
});
