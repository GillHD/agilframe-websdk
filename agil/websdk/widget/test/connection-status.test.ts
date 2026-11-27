/**
 * C-02 regression tests: the connection pill has exactly one source of truth.
 *
 * The bug these lock down: `connectionLabel()` printed “Нет соединения” for an
 * offline server while the pill was painted success-green from `state.connection
 * === 'connected'`. The contract is now a single enum (`offline | connecting |
 * reconnecting | connected`) that drives both the text key and the colour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionInput,
  connectionTone,
  resolveConnectionStatus,
  type ConnectionInput,
  type ConnectionStatus,
} from '../src/ui/connection-status.js';
import type { CallState } from '../src/types.js';

function input(patch: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    serverOnline: true,
    connection: 'connected',
    wsState: 'open',
    resumeStatus: 'idle',
    phase: 'joined',
    degraded: false,
    remoteCount: 3,
    ...patch,
  };
}

test('serverOnline=false is always offline, even with a stale connected peer state', () => {
  const view = resolveConnectionStatus(input({ serverOnline: false, connection: 'connected', wsState: 'open' }));
  assert.equal(view.status, 'offline');
  assert.equal(view.labelKey, 'offline');
  assert.equal(connectionTone(view), 'danger', 'an offline server must never render success green');
});

test('an offline server wins over every other signal', () => {
  for (const connection of ['connected', 'connecting', 'reconnecting', 'offline', 'closed', 'idle'] as const) {
    for (const wsState of ['open', 'connecting', 'reconnecting', 'closed', 'idle'] as const) {
      const view = resolveConnectionStatus(input({ serverOnline: false, connection, wsState }));
      assert.equal(view.status, 'offline', `serverOnline=false + ${connection}/${wsState}`);
    }
  }
});

test('a healthy joined call is connected and green', () => {
  const view = resolveConnectionStatus(input());
  assert.equal(view.status, 'connected');
  assert.equal(view.labelKey, 'connected');
  assert.equal(connectionTone(view), 'success');
});

test('weak media changes the connected indicator to amber and clears after recovery', () => {
  const weak = resolveConnectionStatus(input({ degraded: true }));
  assert.equal(weak.labelKey, 'weak');
  assert.equal(weak.status, 'weak');
  assert.equal(connectionTone(weak), 'warning');
  assert.equal(resolveConnectionStatus(input()).labelKey, 'connected');
  assert.equal(resolveConnectionStatus(input({ degraded: true, wsState: 'reconnecting' })).labelKey, 'reconnecting');
  assert.equal(resolveConnectionStatus(input({ degraded: true, wsState: 'closed' })).labelKey, 'offline');
});

test('the initial handshake and a reconnect are amber, never green', () => {
  const connecting = resolveConnectionStatus(input({ connection: 'connecting', wsState: 'connecting' }));
  assert.equal(connecting.status, 'connecting');
  assert.equal(connectionTone(connecting), 'warning');

  const reconnecting = resolveConnectionStatus(input({ connection: 'reconnecting', wsState: 'reconnecting' }));
  assert.equal(reconnecting.status, 'reconnecting');
  assert.equal(reconnecting.labelKey, 'reconnecting');
  assert.equal(connectionTone(reconnecting), 'warning');

  const resume = resolveConnectionStatus(input({ resumeStatus: 'reconnecting' }));
  assert.equal(resume.status, 'reconnecting');
  const restoring = resolveConnectionStatus(input({ resumeStatus: 'restoring' }));
  assert.equal(restoring.status, 'reconnecting');
});

test('a restored continuity lease reads “restored” but is still green/connected', () => {
  const view = resolveConnectionStatus(input({ resumeStatus: 'restored' }));
  assert.equal(view.status, 'connected');
  assert.equal(view.labelKey, 'restored');
  assert.equal(connectionTone(view), 'success');
});

test('a solo joined call is connected once the socket is open (no peers to connect to)', () => {
  const view = resolveConnectionStatus(
    input({ phase: 'joined', wsState: 'open', connection: 'connecting', remoteCount: 0 }),
  );
  assert.equal(view.status, 'connected');
  // Without the solo exception the same peer state is “connecting”.
  assert.equal(resolveConnectionStatus(input({ connection: 'connecting', wsState: 'open', remoteCount: 2 })).status, 'connecting');
});

test('a closed socket without serverOnline=false still degrades to offline', () => {
  const view = resolveConnectionStatus(input({ connection: 'closed', wsState: 'closed' }));
  assert.equal(view.status, 'offline');
  assert.equal(connectionTone(view), 'danger');
});

test('label and colour can never disagree (exhaustive over the transport matrix)', () => {
  const statuses: ConnectionStatus[] = ['offline', 'connecting', 'reconnecting', 'connected', 'weak'];
  for (const serverOnline of [true, false]) {
    for (const connection of ['idle', 'connecting', 'connected', 'reconnecting', 'offline', 'closed'] as const) {
      for (const wsState of ['idle', 'connecting', 'open', 'reconnecting', 'closed'] as const) {
        for (const resumeStatus of ['idle', 'reconnecting', 'restoring', 'restored', 'failed'] as const) {
          const view = resolveConnectionStatus({ serverOnline, connection, wsState, resumeStatus, phase: 'joined', remoteCount: 2, degraded: false });
          const tone = connectionTone(view);
          assert.ok(statuses.includes(view.status), `unknown status ${view.status}`);
          if (tone === 'success') {
            assert.equal(view.status, 'connected');
            assert.ok(view.labelKey === 'connected' || view.labelKey === 'restored', `green with label ${view.labelKey}`);
          }
          if (tone === 'danger') {
            assert.equal(view.labelKey, 'offline');
          }
          if (view.labelKey === 'offline') assert.equal(view.status, 'offline');
          if (view.labelKey === 'connected') assert.equal(view.status, 'connected');
          // The exact reported bug: “Нет соединения” in success green.
          assert.ok(!(view.labelKey === 'offline' && tone === 'success'));
        }
      }
    }
  }
});

test('connectionInput projects only the fields the pill depends on', () => {
  const state = {
    serverOnline: false,
    connection: 'connected',
    wsState: 'open',
    resumeStatus: 'idle',
    phase: 'joined',
    settings: { degraded: true },
    participants: [{ id: 'a' }, { id: 'b' }],
  } as unknown as CallState;
  assert.deepEqual(connectionInput(state), {
    serverOnline: false,
    connection: 'connected',
    wsState: 'open',
    resumeStatus: 'idle',
    phase: 'joined',
    degraded: true,
    remoteCount: 2,
  });
});
