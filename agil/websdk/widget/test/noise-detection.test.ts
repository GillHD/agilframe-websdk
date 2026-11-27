/**
 * Deterministic tests for local mic noise detection.
 *
 * Synthetic buffers stand in for real audio: digital silence, seeded white
 * noise and a harmonic speech-like signal. The monitor tests inject a fake
 * analyser tap and fake timers, so no browser/Web Audio is required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NOISE_THRESHOLDS,
  NOISE_COOLDOWN_MAX_MS,
  NOISE_COOLDOWN_MIN_MS,
  NoiseGate,
  NoiseMonitor,
  analyzeAudioFrame,
  resolveNoiseCooldownMs,
  type AudioFrameAnalysis,
  type NoiseDetectedEvent,
  type NoiseTap,
  type NoiseTimerApi,
} from '../src/call/noise-detection.js';

const SAMPLE_RATE = 48_000;

function silence(length = 2048): Float32Array {
  return new Float32Array(length);
}

/** Uniform white noise in [-amplitude, amplitude] with a seeded LCG. */
function whiteNoise(length = 2048, amplitude = 0.12, seed = 0x12345678): Float32Array {
  const samples = new Float32Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    samples[i] = ((state / 0x1_0000_0000) * 2 - 1) * amplitude;
  }
  return samples;
}

/** Harmonic, amplitude-modulated "speech": voiced, not broadband. */
function speechLike(length = 2048, amplitude = 0.3): Float32Array {
  const samples = new Float32Array(length);
  const f0 = 180;
  for (let i = 0; i < length; i += 1) {
    const t = i / SAMPLE_RATE;
    const syllable = 0.65 + 0.35 * Math.sin(2 * Math.PI * 2 * t);
    const carrier =
      0.6 * Math.sin(2 * Math.PI * f0 * t) +
      0.25 * Math.sin(2 * Math.PI * 2 * f0 * t) +
      0.1 * Math.sin(2 * Math.PI * 3 * f0 * t) +
      0.05 * Math.sin(2 * Math.PI * 5 * f0 * t);
    samples[i] = amplitude * syllable * carrier;
  }
  return samples;
}

function analysis(overrides: Partial<AudioFrameAnalysis> = {}): AudioFrameAnalysis {
  return {
    rms: 0.06,
    noiseFloor: 0.04,
    spectralFlatness: 0.6,
    noisy: true,
    level: 'moderate',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* analyzeAudioFrame                                                  */
/* ------------------------------------------------------------------ */

test('silence: no RMS/flatness and no false positive', () => {
  const result = analyzeAudioFrame(silence(), SAMPLE_RATE);
  assert.equal(result.rms, 0);
  assert.equal(result.noiseFloor, 0);
  assert.equal(result.spectralFlatness, 0);
  assert.equal(result.noisy, false);
  assert.equal(result.level, 'quiet');
});

test('white noise: broadband frame is detected as noisy', () => {
  const result = analyzeAudioFrame(whiteNoise(2048, 0.12), SAMPLE_RATE);
  assert.ok(result.rms > DEFAULT_NOISE_THRESHOLDS.rms, `rms=${result.rms}`);
  assert.ok(result.noiseFloor > DEFAULT_NOISE_THRESHOLDS.noiseFloor, `floor=${result.noiseFloor}`);
  assert.ok(
    result.spectralFlatness > DEFAULT_NOISE_THRESHOLDS.spectralFlatness,
    `flatness=${result.spectralFlatness}`,
  );
  assert.equal(result.noisy, true);
  assert.ok(result.level === 'moderate' || result.level === 'high', `level=${result.level}`);
});

test('speech-like harmonics: loud but not classified as noise', () => {
  const result = analyzeAudioFrame(speechLike(2048, 0.3), SAMPLE_RATE);
  assert.ok(result.rms > DEFAULT_NOISE_THRESHOLDS.rms, `rms=${result.rms}`);
  assert.ok(
    result.spectralFlatness < DEFAULT_NOISE_THRESHOLDS.spectralFlatness,
    `flatness=${result.spectralFlatness}`,
  );
  assert.equal(result.noisy, false);
});

test('quiet broadband hiss below the RMS threshold is not noisy', () => {
  const result = analyzeAudioFrame(whiteNoise(2048, 0.02), SAMPLE_RATE);
  assert.ok(result.rms < DEFAULT_NOISE_THRESHOLDS.rms, `rms=${result.rms}`);
  assert.equal(result.noisy, false);
});

test('tone below the speech band does not flatten the spectrum', () => {
  const samples = new Float32Array(2048);
  for (let i = 0; i < samples.length; i += 1) samples[i] = 0.2 * Math.sin((2 * Math.PI * 50 * i) / SAMPLE_RATE);
  const result = analyzeAudioFrame(samples, SAMPLE_RATE);
  assert.ok(result.rms > DEFAULT_NOISE_THRESHOLDS.rms);
  assert.ok(result.spectralFlatness < DEFAULT_NOISE_THRESHOLDS.spectralFlatness);
  assert.equal(result.noisy, false);
});

test('analysis is pure: input samples are not modified', () => {
  const samples = whiteNoise(1024, 0.1);
  const copy = samples.slice();
  analyzeAudioFrame(samples, SAMPLE_RATE);
  assert.deepEqual(samples, copy);
});

test('degenerate buffers never throw and stay quiet', () => {
  for (const samples of [new Float32Array(0), new Float32Array(1)]) {
    const result = analyzeAudioFrame(samples, SAMPLE_RATE);
    assert.equal(result.noisy, false);
    assert.equal(result.level, 'quiet');
  }
  const invalid = new Float32Array([NaN, Infinity, -Infinity, 0.1, 0.2]);
  const result = analyzeAudioFrame(invalid, SAMPLE_RATE);
  assert.ok(Number.isFinite(result.rms));
  assert.equal(result.noisy, false);
  assert.equal(analyzeAudioFrame(whiteNoise(), 0).noisy, false);
});

/* ------------------------------------------------------------------ */
/* NoiseGate: hysteresis + cooldown + mute                            */
/* ------------------------------------------------------------------ */

test('hysteresis: needs 3 noisy frames to alert and 8 clean frames to release', () => {
  const gate = new NoiseGate({ cooldownMs: NOISE_COOLDOWN_MIN_MS, now: () => 1_000 });
  assert.equal(gate.push(analysis(), 1_000), null);
  assert.equal(gate.push(analysis(), 1_100), null);
  assert.equal(gate.isAlerting, false);
  const event = gate.push(analysis(), 1_200);
  assert.ok(event);
  assert.equal(event?.level, 'moderate');
  assert.equal(event?.rms, 0.06);
  assert.equal(event?.at, 1_200);
  assert.equal(gate.isAlerting, true);

  for (let i = 0; i < 7; i += 1) gate.push(analysis({ noisy: false }), 1_300 + i * 100);
  assert.equal(gate.isAlerting, true, '7 clean frames must not release the alert');
  gate.push(analysis({ noisy: false }), 2_100);
  assert.equal(gate.isAlerting, false, '8th clean frame releases the alert');
});

test('cooldown: one warning per window while the noise persists', () => {
  const now = 1_000;
  const gate = new NoiseGate({ cooldownMs: NOISE_COOLDOWN_MIN_MS, now: () => now });
  let emitted: NoiseDetectedEvent | null = null;
  for (let i = 0; i < 3; i += 1) emitted = gate.push(analysis(), now);
  assert.ok(emitted);

  assert.equal(gate.push(analysis(), now + NOISE_COOLDOWN_MIN_MS - 1), null);
  const second = gate.push(analysis(), now + NOISE_COOLDOWN_MIN_MS);
  assert.ok(second);
  assert.equal(second?.at, now + NOISE_COOLDOWN_MIN_MS);
});

test('cooldown configuration is clamped to 30–60 s', () => {
  assert.equal(resolveNoiseCooldownMs(undefined), 45_000);
  assert.equal(resolveNoiseCooldownMs(Number.NaN), 45_000);
  assert.equal(resolveNoiseCooldownMs(1), NOISE_COOLDOWN_MIN_MS);
  assert.equal(resolveNoiseCooldownMs(90_000), NOISE_COOLDOWN_MAX_MS);
  assert.equal(resolveNoiseCooldownMs(40_000), 40_000);
});

test('reset() clears the alert and the cooldown clock for a new device', () => {
  let now = 10_000;
  const gate = new NoiseGate({ cooldownMs: NOISE_COOLDOWN_MIN_MS, now: () => now });
  for (let i = 0; i < 3; i += 1) gate.push(analysis(), now);
  assert.equal(gate.isAlerting, true);
  assert.equal(gate.push(analysis(), now + 1_000), null, 'still inside the cooldown');

  gate.reset();
  assert.equal(gate.isAlerting, false);
  now += 1_000;
  assert.equal(gate.push(analysis(), now), null);
  assert.equal(gate.push(analysis(), now), null);
  assert.ok(
    gate.push(analysis(), now),
    'a replacement track/device is not blocked by the previous cooldown',
  );
});

test('muted gate ignores noisy frames and resets hysteresis', () => {
  const gate = new NoiseGate({ cooldownMs: NOISE_COOLDOWN_MIN_MS, now: () => 5_000 });
  gate.setMuted(true);
  for (let i = 0; i < 10; i += 1) assert.equal(gate.push(analysis(), 5_000 + i * 100), null);
  assert.equal(gate.isAlerting, false);

  gate.setMuted(false);
  assert.equal(gate.push(analysis(), 6_000), null);
  assert.equal(gate.push(analysis(), 6_100), null);
  assert.ok(gate.push(analysis(), 6_200));
});

/* ------------------------------------------------------------------ */
/* NoiseMonitor lifecycle                                             */
/* ------------------------------------------------------------------ */

interface FakeTrack {
  readyState: MediaStreamTrackState;
  enabled: boolean;
  muted: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  emit(type: string): void;
}

function fakeTrack(overrides: Partial<Pick<FakeTrack, 'readyState' | 'enabled' | 'muted'>> = {}): FakeTrack {
  const listeners = new Map<string, Set<() => void>>();
  return {
    readyState: 'live',
    enabled: true,
    muted: false,
    ...overrides,
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
  };
}

class FakeTimers implements NoiseTimerApi {
  callback: (() => void) | null = null;
  cleared = 0;

  setInterval(callback: () => void): unknown {
    this.callback = callback;
    return 1;
  }

  clearInterval(): void {
    this.cleared += 1;
    this.callback = null;
  }

  tick(times = 1): void {
    for (let i = 0; i < times; i += 1) this.callback?.();
  }
}

function whiteNoiseTap(disconnect: () => void): NoiseTap {
  return {
    read(target: Float32Array<ArrayBuffer>): void {
      let state = 0x0badf00d;
      for (let i = 0; i < target.length; i += 1) {
        state = (state * 1664525 + 1013904223) >>> 0;
        target[i] = ((state / 0x1_0000_0000) * 2 - 1) * 0.12;
      }
    },
    disconnect,
  };
}

test('monitor emits only after hysteresis and respects the cooldown', () => {
  const track = fakeTrack();
  const timers = new FakeTimers();
  const events: NoiseDetectedEvent[] = [];
  let reads = 0;
  const monitor = new NoiseMonitor({
    track: track as unknown as MediaStreamTrack,
    onNoise: (event) => events.push(event),
    timers,
    sampleRate: SAMPLE_RATE,
    fftSize: 1024,
    now: () => 10_000,
    tapFactory: () => ({
      read(target) {
        reads += 1;
        assert.equal(target.length, 1024);
        let state = 0x0badf00d;
        for (let i = 0; i < target.length; i += 1) {
          state = (state * 1664525 + 1013904223) >>> 0;
          target[i] = ((state / 0x1_0000_0000) * 2 - 1) * 0.12;
        }
      },
      disconnect() {
        /* no graph in the fake tap */
      },
    }),
  });
  assert.equal(monitor.start(), true);
  assert.equal(monitor.isRunning, true);

  timers.tick(2);
  assert.equal(events.length, 0);
  timers.tick(1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.level, 'moderate');

  timers.tick(100);
  assert.equal(events.length, 1, 'cooldown suppresses repeated warnings');
  assert.ok(reads > 3);
  monitor.dispose();
});

test('monitor ignores a muted/disabled track and resumes after unmute', () => {
  const track = fakeTrack({ enabled: false });
  const timers = new FakeTimers();
  const events: NoiseDetectedEvent[] = [];
  const monitor = new NoiseMonitor({
    track: track as unknown as MediaStreamTrack,
    onNoise: (event) => events.push(event),
    timers,
    sampleRate: SAMPLE_RATE,
    fftSize: 1024,
    tapFactory: () => whiteNoiseTap(() => undefined),
  });
  assert.equal(monitor.start(), true);

  timers.tick(10);
  assert.equal(events.length, 0);
  assert.equal(monitor.isAlerting, false);

  track.enabled = true;
  timers.tick(2);
  assert.equal(events.length, 0);
  timers.tick(1);
  assert.equal(events.length, 1);
  monitor.dispose();
});

test('monitor honours explicit setMuted() and track.muted', () => {
  const track = fakeTrack();
  const timers = new FakeTimers();
  const events: NoiseDetectedEvent[] = [];
  const monitor = new NoiseMonitor({
    track: track as unknown as MediaStreamTrack,
    onNoise: (event) => events.push(event),
    timers,
    sampleRate: SAMPLE_RATE,
    tapFactory: () => whiteNoiseTap(() => undefined),
  });
  monitor.start();

  monitor.setMuted(true);
  timers.tick(10);
  assert.equal(events.length, 0);
  monitor.setMuted(false);
  timers.tick(3);
  assert.equal(events.length, 1);

  track.muted = true;
  timers.tick(4);
  assert.equal(events.length, 1, 'platform-muted track is ignored');
  monitor.dispose();
});

test('dispose clears the timer, disconnects the tap and stops callbacks', () => {
  const track = fakeTrack();
  const timers = new FakeTimers();
  const events: NoiseDetectedEvent[] = [];
  let disconnected = false;
  const monitor = new NoiseMonitor({
    track: track as unknown as MediaStreamTrack,
    onNoise: (event) => events.push(event),
    timers,
    sampleRate: SAMPLE_RATE,
    tapFactory: () => whiteNoiseTap(() => {
      disconnected = true;
    }),
  });
  assert.equal(monitor.start(), true);
  const lateCallback = timers.callback;
  monitor.dispose();
  assert.equal(monitor.isRunning, false);
  assert.equal(disconnected, true);
  assert.equal(timers.cleared, 1);

  lateCallback?.();
  assert.equal(events.length, 0, 'a stale timer callback must not emit after dispose');
  monitor.dispose();
  assert.equal(timers.cleared, 1, 'dispose is idempotent');
});

test('monitor disposes itself when the track ends; dead tracks do not start', () => {
  const track = fakeTrack();
  const timers = new FakeTimers();
  let disconnected = false;
  const monitor = new NoiseMonitor({
    track: track as unknown as MediaStreamTrack,
    onNoise: () => undefined,
    timers,
    sampleRate: SAMPLE_RATE,
    tapFactory: () => whiteNoiseTap(() => {
      disconnected = true;
    }),
  });
  assert.equal(monitor.start(), true);
  track.emit('ended');
  assert.equal(monitor.isRunning, false);
  assert.equal(disconnected, true);

  const dead = fakeTrack({ readyState: 'ended' });
  const deadMonitor = new NoiseMonitor({
    track: dead as unknown as MediaStreamTrack,
    onNoise: () => undefined,
    timers: new FakeTimers(),
    sampleRate: SAMPLE_RATE,
    tapFactory: () => whiteNoiseTap(() => undefined),
  });
  assert.equal(deadMonitor.start(), false);
});
