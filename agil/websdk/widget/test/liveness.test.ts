/**
 * Widget-side liveness integration with the server-issued challenge.
 *
 * MediaPipe is loaded from a CDN at runtime; under Node the dynamic import
 * always fails, which is exactly the degraded path a browser without CDN access
 * hits. The client must then report `modelAvailable:false` to the server and
 * never fabricate a pass — these tests pin that behaviour with a fake API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LivenessChallengeResponse, LivenessSignals, TenantConfig } from '@agil/protocol';
import { IntegrityChecker } from '../src/call/integrity.js';

interface CapturedCall {
  method: string;
  args: unknown[];
}

/** Minimal tenant config: only the two security blocks are read by the checker. */
function tenantConfig(options: { serverLiveness: boolean; mediaIntegrity?: boolean; legacyChallenge?: boolean }): TenantConfig {
  return {
    security: {
      liveness: { enabled: options.serverLiveness, onEngineError: 'fail-open' },
      mediaIntegrity: {
        enabled: options.mediaIntegrity ?? false,
        livenessChallenge: options.legacyChallenge ?? false,
        frameHeuristics: false,
        externalProvider: '',
        flagThreshold: 0.7,
        autoMuteOnHighRisk: false,
      },
    },
  } as unknown as TenantConfig;
}

const CHALLENGE: LivenessChallengeResponse = {
  sessionId: '8a3f7c1e-0000-4000-8000-000000000001',
  task: 'blink',
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_180_000,
  ttlSec: 180,
  engine: 'challenge',
  advisory: true,
};

function harness(config: TenantConfig, api: Record<string, unknown>) {
  const calls: CapturedCall[] = [];
  const notes: string[] = [];
  const challenges: Array<{ task: string | null; state: string }> = [];
  const results: Array<{ status: string; score: number; flags: string[] }> = [];
  const sent: Array<Record<string, unknown>> = [];
  const wrapped = new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args });
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const checker = new IntegrityChecker({
    config,
    signaling: { send: (message: Record<string, unknown>) => sent.push(message) } as never,
    getVideoTrack: () => ({}) as MediaStreamTrack,
    getVideoElement: () => ({}) as HTMLVideoElement,
    api: wrapped as never,
    roomId: 'room-1',
    onResult: (status, score, flags) => results.push({ status, score, flags }),
    onChallenge: (task, state) => challenges.push({ task, state }),
    onNote: (text) => notes.push(text),
  });
  return { checker, calls, notes, challenges, results, sent };
}

/** MediaPipe logs a warning when the CDN cannot be loaded; keep the test output clean. */
async function withoutConsoleWarn<T>(run: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => undefined;
  try {
    return await run();
  } finally {
    console.warn = original;
  }
}

test('disabled liveness: no challenge request, no local check, no signaling message', async () => {
  const api = {
    createLivenessChallenge: async () => CHALLENGE,
    verifyLiveness: async () => ({ status: 'verified' }),
  };
  const harnessed = harness(tenantConfig({ serverLiveness: false }), api);
  const passed = await harnessed.checker.runLivenessChallenge();
  assert.equal(passed, false);
  assert.equal(harnessed.calls.length, 0);
  assert.deepEqual(harnessed.challenges, []);
  assert.deepEqual(harnessed.sent, []);
});

test('server challenge + unavailable model: reports modelAvailable=false instead of a fake verdict', async () => {
  const api = {
    createLivenessChallenge: async () => CHALLENGE,
    verifyLiveness: async (_roomId: string, _sessionId: string, _signals: LivenessSignals) => ({
      sessionId: CHALLENGE.sessionId,
      passed: false,
      status: 'unavailable',
      score: 0.4,
      flags: ['liveness_model_unavailable'],
      engine: 'challenge',
      attempts: 1,
      maxAttempts: 2,
      advisory: true,
    }),
  };
  const harnessed = harness(tenantConfig({ serverLiveness: true }), api);
  const passed = await withoutConsoleWarn(() => harnessed.checker.runLivenessChallenge());

  assert.equal(passed, false);
  assert.equal(harnessed.calls[0]?.method, 'createLivenessChallenge');
  assert.deepEqual(harnessed.calls[0]?.args, ['room-1']);
  assert.equal(harnessed.calls[1]?.method, 'verifyLiveness');
  assert.deepEqual(harnessed.calls[1]?.args.slice(0, 2), ['room-1', CHALLENGE.sessionId]);
  const signals = harnessed.calls[1]?.args[2] as LivenessSignals;
  assert.equal(signals.modelAvailable, false);
  assert.equal(signals.faceDetected, false);
  assert.equal(signals.blinkDetected, undefined, 'no fabricated signal');

  assert.deepEqual(harnessed.notes, ['livenessUnavailable']);
  assert.deepEqual(harnessed.challenges, [{ task: null, state: 'unavailable' }]);
  assert.deepEqual(harnessed.results, [{ status: 'unknown', score: 0.5, flags: ['liveness_model_unavailable'] }]);
  assert.equal(harnessed.sent[0]?.type, 'integrity');
  assert.equal(harnessed.sent[0]?.status, 'unknown');
});

test('server unreachable: degrades to the local path with an explicit note (call stays usable)', async () => {
  const api = {
    createLivenessChallenge: async () => {
      throw new Error('501 liveness_not_configured');
    },
    verifyLiveness: async () => {
      throw new Error('must not be called without a challenge');
    },
  };
  const harnessed = harness(tenantConfig({ serverLiveness: true }), api);
  const passed = await withoutConsoleWarn(() => harnessed.checker.runLivenessChallenge());

  assert.equal(passed, false);
  assert.deepEqual(harnessed.calls.map((call) => call.method), ['createLivenessChallenge']);
  assert.deepEqual(harnessed.notes, ['livenessServerUnavailable', 'livenessUnavailable']);
  assert.deepEqual(harnessed.challenges, [{ task: null, state: 'unavailable' }]);
});
