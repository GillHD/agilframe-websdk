/**
 * Client reconnect state machine (docs/call-continuity.md).
 *
 * These tests pin the decision matrix that keeps a resumed call free of
 * duplicate peers and camera re-acquisition:
 *   - a healthy SFU session is never rejoined on a signaling blip;
 *   - mesh peers are rebuilt only for a resumed mesh room;
 *   - an unconfirmed resume (welcome.resumed=false) is never reported as
 *     "restored" and falls back to a fresh media join;
 *   - local tracks are preserved on every path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResumeStateMachine } from '../src/call/resume-state.js';
import {
  SignalingClient,
  buildSocketProtocols,
  WS_RESUME_PROTOCOL_PREFIX,
} from '../src/call/signaling-client.js';

const healthySfu = { resumed: true, hasSfuSession: true, sfuConnected: true, sameSfuRoom: true };

test('initial join: idle, media untouched, no reconnect plan', () => {
  const machine = new ResumeStateMachine();
  const decision = machine.applyWelcome({
    resumed: false,
    hasSfuSession: true,
    sfuConnected: false,
    sameSfuRoom: false,
  });
  assert.equal(decision.status, 'idle');
  assert.equal(decision.reason, 'initial-join');
  assert.equal(decision.keepLocalTracks, true);
  assert.equal(decision.rejoinSfu, false);
  assert.equal(decision.rebuildPeers, false);
  assert.equal(machine.interrupted, false);
});

test('drop → open → restored: healthy SFU is kept, no rejoin and no peer rebuild', () => {
  const machine = new ResumeStateMachine();
  assert.equal(machine.beginAttempt('socket-closed', 1000), 'reconnecting');
  assert.equal(machine.markSocketOpen(1100), 'restoring');
  const decision = machine.applyWelcome(healthySfu, 1200);
  assert.equal(decision.status, 'restored');
  assert.equal(decision.resumed, true);
  assert.equal(decision.keepMedia, true);
  assert.equal(decision.rejoinSfu, false, 'a healthy SFU session must not be torn down');
  assert.equal(decision.rebuildPeers, false, 'no duplicate peer/tile after resume');
  assert.equal(decision.keepLocalTracks, true);
  assert.equal(decision.reason, 'resume-media-healthy');
  assert.equal(machine.restoredAtMs, 1200);
});

test('restored expiring SFU token or changed room triggers a rejoin of the same room', () => {
  const expired = new ResumeStateMachine();
  expired.beginAttempt();
  const decision = expired.applyWelcome({ ...healthySfu, sameSfuRoom: false });
  assert.equal(decision.status, 'restored');
  assert.equal(decision.rejoinSfu, true);
  assert.equal(decision.rebuildPeers, false);

  const unhealthy = new ResumeStateMachine();
  unhealthy.beginAttempt();
  const down = unhealthy.applyWelcome({ ...healthySfu, sfuConnected: false });
  assert.equal(down.rejoinSfu, true);

  const noSession = new ResumeStateMachine();
  noSession.beginAttempt();
  const lost = noSession.applyWelcome({ resumed: true, hasSfuSession: false, sfuConnected: false, sameSfuRoom: false });
  assert.equal(lost.rejoinSfu, false);
  assert.equal(lost.rebuildPeers, true, 'SFU loss falls back to rebuilding the mesh plane');
});

test('resumed mesh room: peers are rebuilt from the welcome, local tracks survive', () => {
  const machine = new ResumeStateMachine();
  machine.beginAttempt();
  machine.markSocketOpen();
  const decision = machine.applyWelcome({ resumed: true, hasSfuSession: false, sfuConnected: false, sameSfuRoom: false });
  assert.equal(decision.status, 'restored');
  assert.equal(decision.keepMedia, false);
  assert.equal(decision.rebuildPeers, true);
  assert.equal(decision.keepLocalTracks, true);
  assert.equal(decision.reason, 'resume-needs-peers');
});

test('a signaling-only disconnect preserves live mesh peer connections', () => {
  const machine = new ResumeStateMachine();
  machine.beginAttempt();
  const decision = machine.applyWelcome({
    resumed: true, hasSfuSession: false, sfuConnected: false, sameSfuRoom: false, meshConnected: true,
  });
  assert.equal(decision.keepMedia, true);
  assert.equal(decision.rebuildPeers, false);
  assert.equal(decision.reason, 'resume-media-healthy');
});

test('rejected resume is reported as failed and never as restored', () => {
  const machine = new ResumeStateMachine();
  machine.beginAttempt();
  machine.markSocketOpen();
  const decision = machine.applyWelcome({ resumed: false, hasSfuSession: true, sfuConnected: true, sameSfuRoom: true });
  assert.equal(decision.status, 'failed');
  assert.equal(decision.resumed, false);
  assert.equal(decision.rejoinSfu, true, 'fresh join still brings up the media plane');
  assert.equal(decision.rebuildPeers, true);
  assert.equal(machine.failure, 'resume_rejected');
});

test('retry budget exhaustion and settle/reset lifecycle', () => {
  const machine = new ResumeStateMachine();
  machine.beginAttempt();
  machine.beginAttempt();
  assert.equal(machine.attempts, 2);
  assert.equal(machine.fail('exhausted'), 'failed');
  assert.equal(machine.failure, 'exhausted');
  // `settle()` only clears the success badge, never a failure.
  assert.equal(machine.settle(), 'failed');
  machine.beginAttempt();
  machine.markSocketOpen();
  machine.applyWelcome(healthySfu);
  assert.equal(machine.status, 'restored');
  assert.equal(machine.settle(), 'idle');
  assert.equal(machine.attempts, 3, 'attempts stay observable for diagnostics');
  machine.reset();
  assert.equal(machine.status, 'idle');
  assert.equal(machine.attempts, 0);
  assert.equal(machine.interrupted, false);
});

test('a deliberate fresh join is not treated as an interruption', () => {
  const machine = new ResumeStateMachine();
  // Room switch / SFU retry: no `beginAttempt()` happened.
  const decision = machine.applyWelcome({ resumed: false, hasSfuSession: true, sfuConnected: false, sameSfuRoom: false });
  assert.equal(decision.status, 'idle');
  assert.equal(decision.reason, 'initial-join');
});

test('resume token is offered as a subprotocol, never duplicated in the list', () => {
  const base = ['agil-calls.v1', 'agil-token.abc'];
  const withResume = buildSocketProtocols(base, 'r1.payload.signature');
  assert.equal(withResume[0], 'agil-calls.v1');
  assert.equal(withResume[1], 'agil-token.abc');
  assert.equal(withResume[2], `${WS_RESUME_PROTOCOL_PREFIX}r1.payload.signature`);
  // Reconnect rebuilds the list: the previous resume entry is replaced, not stacked.
  const rotated = buildSocketProtocols(withResume, 'r1.new.sig');
  assert.equal(rotated.filter((protocol) => protocol.startsWith(WS_RESUME_PROTOCOL_PREFIX)).length, 1);
  assert.ok(rotated.some((protocol) => protocol.endsWith('r1.new.sig')));
  // No resume token → the stale candidate is dropped.
  assert.deepEqual(buildSocketProtocols(withResume, null), base);
  // Characters are percent-encoded for the header.
  assert.ok(buildSocketProtocols([], 'a+b/c=').at(0)?.endsWith('a%2Bb%2Fc%3D'));
});

test('recovery client re-offers the previous resume token (no fresh join after a token refresh)', async () => {
  interface FakeSocket {
    protocols: string[];
    emit: (type: string, event: unknown) => void;
  }
  const sockets: FakeSocket[] = [];
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = FakeWebSocket.CONNECTING;
    readonly protocols: string[];
    private readonly handlers = new Map<string, Array<(event: unknown) => void>>();

    constructor(_url: string, protocols?: string[]) {
      this.protocols = protocols ?? [];
      const socket: FakeSocket = {
        protocols: this.protocols,
        emit: (type, event) => {
          for (const handler of this.handlers.get(type) ?? []) handler(event);
        },
      };
      sockets.push(socket);
    }

    addEventListener(type: string, handler: (event: unknown) => void): void {
      const list = this.handlers.get(type) ?? [];
      list.push(handler);
      this.handlers.set(type, list);
    }

    removeEventListener(): void {
      /* no-op */
    }

    send(): void {
      /* no-op */
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
      for (const handler of this.handlers.get('close') ?? []) {
        handler({ code: 1000, reason: '', wasClean: true });
      }
    }
  }

  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  try {
    const reconnect = { enabled: false, attempts: 0, backoffMs: 10, maxBackoffMs: 10 };
    const baseProtocols = ['agil-calls.v1', 'agil-token.abc'];
    // The client that is about to exhaust its backoff already knows the token.
    const previous = new SignalingClient({ url: 'ws://test/ws', protocols: baseProtocols, reconnect });
    previous.setResumeToken('r1.old.signature');
    assert.equal(previous.hasResumeToken, true);
    assert.equal(previous.resumeTokenValue, 'r1.old.signature');

    // `recoverSession()` builds a replacement client and must carry the token.
    const replacement = new SignalingClient({
      url: 'ws://test/ws',
      protocols: baseProtocols,
      reconnect,
      resumeToken: previous.resumeTokenValue,
    });
    const connected = replacement.connect();
    const socket = sockets.at(-1);
    assert.ok(socket, 'a socket was opened');
    assert.deepEqual(
      socket.protocols.filter((protocol) => protocol.startsWith(WS_RESUME_PROTOCOL_PREFIX)),
      [`${WS_RESUME_PROTOCOL_PREFIX}${encodeURIComponent('r1.old.signature')}`],
      'the recovered socket offers the held resume capability',
    );

    socket.emit('open', {});
    socket.emit('message', {
      data: JSON.stringify({
        type: 'welcome',
        self: { id: 'u-1', name: 'Alisa', role: 'guest' },
        room: { id: 'r-1' },
        participants: [],
        config: {},
        iceServers: [],
        serverTime: 0,
        history: [],
      }),
    });
    await connected;
    replacement.close('test done');
  } finally {
    if (original) Object.defineProperty(globalThis, 'WebSocket', original);
    else delete (globalThis as Record<string, unknown>).WebSocket;
  }
});
