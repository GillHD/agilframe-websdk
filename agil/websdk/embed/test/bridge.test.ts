import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Bridge,
  parseWidgetMessage,
  sanitizeBridgePayload,
  type BridgeOptions,
  type BridgeReadyPayload,
  type BridgeWindow,
  type WidgetMessage,
} from '../src/bridge.js';

const TARGET = 'https://calls.example.com';

interface Sent {
  data: unknown;
  targetOrigin: string;
}

interface Harness {
  bridge: Bridge;
  sent: Sent[];
  contentWindow: { postMessage(message: unknown, targetOrigin: string): void };
  emit(origin: string, data: unknown, source?: unknown): void;
  listenerCount(): number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function harness(overrides: Partial<BridgeOptions> = {}): Harness {
  const listeners = new Set<(event: MessageEvent) => void>();
  const sent: Sent[] = [];
  const contentWindow = {
    postMessage(message: unknown, targetOrigin: string): void {
      sent.push({ data: message, targetOrigin });
    },
  };
  const fakeWindow = {
    addEventListener(type: string, listener: (event: MessageEvent) => void): void {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
      if (type === 'message') listeners.delete(listener);
    },
  };
  const bridge = new Bridge({
    iframe: { contentWindow },
    targetOrigin: TARGET,
    allowedOrigins: [TARGET],
    window: fakeWindow as unknown as BridgeWindow,
    pingIntervalMs: 1000,
    readyTimeoutMs: 1000,
    ...overrides,
  });
  return {
    bridge,
    sent,
    contentWindow,
    emit(origin: string, data: unknown, source: unknown = contentWindow): void {
      for (const listener of [...listeners]) {
        listener({ source, origin, data } as unknown as MessageEvent);
      }
    },
    listenerCount: () => listeners.size,
  };
}

function lastSent(sent: Sent[]): Sent {
  const last = sent[sent.length - 1];
  assert.ok(last, 'expected at least one postMessage');
  return last;
}

test('bridge: start pings with the exact targetOrigin, never "*"', () => {
  const h = harness();
  h.bridge.start();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0]?.data, { type: 'agil:ping' });
  assert.equal(h.sent[0]?.targetOrigin, TARGET);
  assert.ok(h.sent.every((message) => message.targetOrigin === TARGET));
  h.bridge.stop();
});

test('bridge: commands queue until pong, then flush with exact targetOrigin', async () => {
  const h = harness();
  h.bridge.start();
  const joined = h.bridge.send({ type: 'agil:action', action: 'join' });
  assert.equal(
    h.sent.some((message) => (message.data as { type?: string }).type === 'agil:action'),
    false,
  );
  h.emit(TARGET, { type: 'agil:pong' });
  await joined;
  assert.equal(h.bridge.isReady, true);
  const action = h.sent.find(
    (message) => (message.data as { type?: string }).type === 'agil:action',
  );
  assert.ok(action);
  assert.deepEqual(action.data, { type: 'agil:action', action: 'join' });
  assert.equal(action.targetOrigin, TARGET);
  assert.ok(h.sent.every((message) => message.targetOrigin !== '*'));
  h.bridge.stop();
});

test('bridge: video consent is bound to a specific request', async () => {
  const h = harness();
  h.bridge.start();
  h.emit(TARGET, { type: 'agil:pong' });
  const requestId = 'e111a11d-d55e-42a2-8dc2-d5800b84093e';
  const command = { type: 'agil:video-upgrade-response', requestId, accept: true } as const;
  await assert.rejects(h.bridge.send({ ...command, requestId: 'invalid' }));
  await assert.rejects(h.bridge.send({ ...command, accept: 'yes' } as never));
  await h.bridge.send(command);
  assert.deepEqual(h.sent.at(-1), { data: command, targetOrigin: TARGET });
  h.bridge.stop();
});

test('bridge: whenReady resolves on agil:ready and reports capabilities', async () => {
  const readyPayloads: BridgeReadyPayload[] = [];
  const h = harness({ onReady: (payload) => readyPayloads.push(payload) });
  h.bridge.start();
  const ready = h.bridge.whenReady();
  h.emit(TARGET, {
    type: 'agil:ready',
    capabilities: { media: true, blur: true, screenShare: false, captions: true, recording: false, videoUpgrade: true },
    room: 'team-sync',
    server: TARGET,
  });
  await ready;
  assert.equal(h.bridge.isReady, true);
  assert.equal(readyPayloads.length, 1);
  assert.equal(readyPayloads[0]?.capabilities.media, true);
  assert.equal(readyPayloads[0]?.capabilities.screenShare, false);
  assert.equal(readyPayloads[0]?.capabilities.videoUpgrade, true);
  assert.equal(readyPayloads[0]?.room, 'team-sync');
  h.bridge.stop();
});

test('bridge: forwards state/chat/event messages from the iframe', async () => {
  const messages: WidgetMessage[] = [];
  const h = harness({ onMessage: (message) => messages.push(message) });
  h.bridge.start();
  h.emit(TARGET, { type: 'agil:pong' });
  h.emit(TARGET, { type: 'agil:event', event: 'joined', payload: { id: 'p1' } });
  h.emit(TARGET, { type: 'agil:chat', message: { id: 'm1', text: 'hello', ts: 1 } });
  h.emit(TARGET, { type: 'agil:state', state: { phase: 'joined', participants: 2 } });
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], { type: 'agil:event', event: 'joined', payload: { id: 'p1' } });
  assert.equal(messages[1]?.type, 'agil:chat');
  if (messages[1]?.type === 'agil:chat') {
    assert.equal(messages[1].message.text, 'hello');
    assert.equal(messages[1].message.id, 'm1');
  }
  assert.equal(messages[2]?.type, 'agil:state');
  if (messages[2]?.type === 'agil:state') {
    assert.equal(messages[2].state.phase, 'joined');
    assert.equal(messages[2].state.participants, 2);
  }
  h.bridge.stop();
});

test('bridge: ignores messages from a foreign origin', async () => {
  let ready = 0;
  let received = 0;
  const h = harness({
    onReady: () => {
      ready += 1;
    },
    onMessage: () => {
      received += 1;
    },
  });
  h.bridge.start();
  h.emit('https://evil.example', { type: 'agil:ready', capabilities: {} });
  h.emit('https://evil.example', { type: 'agil:event', event: 'joined' });
  await delay(20);
  assert.equal(ready, 0);
  assert.equal(received, 0);
  assert.equal(h.bridge.isReady, false);
  h.bridge.stop();
});

test('bridge: ignores messages from another window at the right origin', async () => {
  let received = 0;
  const h = harness({ onMessage: () => (received += 1) });
  h.bridge.start();
  h.emit(TARGET, { type: 'agil:event', event: 'joined' }, { postMessage() {} });
  h.emit(TARGET, { type: 'agil:ready', capabilities: {} }, { postMessage() {} });
  await delay(10);
  assert.equal(received, 0);
  assert.equal(h.bridge.isReady, false);
  h.bridge.stop();
});

test('bridge: handshake timeout rejects queued work and can recover on a late pong', async () => {
  let timeouts = 0;
  const h = harness({
    readyTimeoutMs: 60,
    onTimeout: () => {
      timeouts += 1;
    },
  });
  const pending = h.bridge.send({ type: 'agil:chat-send', text: 'hi' });
  h.bridge.start();
  await assert.rejects(pending, /timed out/i);
  assert.equal(timeouts, 1);
  assert.equal(h.bridge.isReady, false);
  h.emit(TARGET, { type: 'agil:pong' });
  assert.equal(h.bridge.isReady, true);
  h.bridge.stop();
});

test('bridge: stop detaches, rejects pending work and is final', async () => {
  const h = harness();
  h.bridge.start();
  const pending = h.bridge.send({ type: 'agil:action', action: 'leave' });
  const ready = h.bridge.whenReady();
  h.bridge.stop();
  await assert.rejects(pending, /stopped/i);
  await assert.rejects(ready, /stopped/i);
  assert.equal(h.listenerCount(), 0);
  await assert.rejects(h.bridge.send({ type: 'agil:ping' }), /stopped/i);
  assert.throws(() => h.bridge.start(), /stopped/i);
});

test('bridge: constructor enforces explicit, non-wildcard origins', () => {
  const contentWindow = { postMessage() {} };
  assert.throws(
    () =>
      new Bridge({
        iframe: { contentWindow },
        targetOrigin: '*',
        allowedOrigins: ['*'],
        window: null,
      }),
    /wildcards are not allowed/,
  );
  assert.throws(
    () =>
      new Bridge({
        iframe: { contentWindow },
        targetOrigin: TARGET,
        allowedOrigins: [],
        window: null,
      }),
    /at least the iframe origin/,
  );
  assert.throws(
    () =>
      new Bridge({
        iframe: { contentWindow },
        targetOrigin: TARGET,
        allowedOrigins: ['https://alt.example.com'],
        window: null,
      }),
    /must include the iframe origin/,
  );
  assert.throws(
    () =>
      new Bridge({
        iframe: { contentWindow },
        targetOrigin: TARGET,
        allowedOrigins: ['*'],
        window: null,
      }),
    /wildcards are not allowed/,
  );

  const bridge = new Bridge({
    iframe: { contentWindow },
    targetOrigin: 'http://localhost:8787',
    allowedOrigins: ['http://localhost:8787'],
    window: null,
  });
  assert.equal(bridge.targetOrigin, 'http://localhost:8787');
});

test('bridge: rejects unsupported outbound commands', async () => {
  const h = harness();
  h.bridge.start();
  await assert.rejects(
    h.bridge.send({ type: 'agil:evil', payload: 'x' } as never),
    /Unsupported bridge command/,
  );
  await assert.rejects(
    h.bridge.send({ type: 'agil:action', action: 'drop-tables' } as never),
    /Unsupported bridge command/,
  );
  h.bridge.stop();
});

test('bridge: reports a postMessage failure once without leaking details', async () => {
  let errors = 0;
  const h = harness({
    onError: () => {
      errors += 1;
    },
  });
  h.contentWindow.postMessage = () => {
    throw new Error('boom token=secret');
  };
  h.bridge.start();
  assert.equal(errors, 1);
  h.bridge.stop();
});

test('bridge: postMessage failure rejects with a generic, secret-free error', async () => {
  const h = harness();
  h.bridge.start();
  h.emit(TARGET, { type: 'agil:pong' });
  await h.bridge.whenReady();
  h.contentWindow.postMessage = () => {
    throw new Error('token=secret');
  };
  await assert.rejects(
    h.bridge.send({ type: 'agil:chat-send', text: 'hi' }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Failed to send bridge command' &&
      !error.message.includes('secret'),
  );
  h.bridge.stop();
});

test('sanitizeBridgePayload: drops prototype keys, functions and cycles, caps sizes', () => {
  const cyclic: Record<string, unknown> = { keep: 'yes' };
  cyclic['self'] = cyclic;
  const hostile = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"x":1},"ok":"long-value"}',
  ) as Record<string, unknown>;
  hostile['fn'] = () => 'nope';
  hostile['nested'] = { deep: [1, 2, 3] };
  hostile['cycle'] = cyclic;

  const out = sanitizeBridgePayload(hostile, { maxString: 5, maxDepth: 3 });
  assert.equal(typeof out, 'object');
  const record = out as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(record, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'constructor'), false);
  assert.equal(record['ok'], 'long…');
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'fn'), false);
  assert.ok(record['nested']);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  assert.ok(record['cycle']);
});

test('parseWidgetMessage: validates types, capabilities and bounds', () => {
  assert.deepEqual(parseWidgetMessage({ type: 'agil:pong' }), { type: 'agil:pong' });
  assert.equal(parseWidgetMessage(null), null);
  assert.equal(parseWidgetMessage('agil:ready'), null);
  assert.equal(parseWidgetMessage({ type: 'agil:evil' }), null);
  assert.equal(parseWidgetMessage({ type: 'agil:event', event: '' }), null);
  assert.equal(parseWidgetMessage({ type: 'agil:resize', height: 10 }), null);
  assert.equal(parseWidgetMessage({ type: 'agil:resize', height: '300' }), null);

  const ready = parseWidgetMessage({
    type: 'agil:ready',
    capabilities: { media: 1, blur: true, screenShare: 'yes', captions: true, recording: true },
    room: 'r1',
  });
  assert.equal(ready?.type, 'agil:ready');
  if (ready?.type === 'agil:ready') {
    assert.equal(ready.capabilities.media, false);
    assert.equal(ready.capabilities.blur, true);
    assert.equal(ready.capabilities.screenShare, false);
    assert.equal(ready.room, 'r1');
  }

  const event = parseWidgetMessage({
    type: 'agil:event',
    event: 'joined',
    payload: JSON.parse('{"__proto__":{"polluted":true},"id":"p1"}'),
  });
  assert.ok(event);
  if (event?.type === 'agil:event') {
    const payload = event.payload as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(payload, '__proto__'), false);
    assert.equal(payload['id'], 'p1');
  }

  const chat = parseWidgetMessage({ type: 'agil:chat', message: 'plain text' });
  assert.ok(chat);
  if (chat?.type === 'agil:chat') assert.equal(chat.message.text, 'plain text');

  const resize = parseWidgetMessage({ type: 'agil:resize', height: 480 });
  assert.deepEqual(resize, { type: 'agil:resize', height: 480 });

  assert.deepEqual(parseWidgetMessage({ type: 'agil:minimized', minimized: true }), {
    type: 'agil:minimized',
    minimized: true,
  });
  assert.deepEqual(parseWidgetMessage({ type: 'agil:fullscreen', fullscreen: false }), {
    type: 'agil:fullscreen',
    fullscreen: false,
  });
});

test('bridge: never writes to the console', async () => {
  const mutable = console as unknown as Record<string, (...args: unknown[]) => void>;
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = new Map<string, (...args: unknown[]) => void>();
  const calls: unknown[][] = [];
  for (const method of methods) {
    const original = mutable[method];
    if (original) originals.set(method, original);
    mutable[method] = (...args: unknown[]) => {
      calls.push(args);
    };
  }
  try {
    const h = harness();
    h.bridge.start();
    h.emit(TARGET, {
      type: 'agil:event',
      event: 'error',
      payload: { code: 'mount_failed', message: 'token=secret-token' },
    });
    h.emit(TARGET, { type: 'agil:pong' });
    h.bridge.stop();
  } finally {
    for (const [method, original] of originals) mutable[method] = original;
  }
  assert.deepEqual(calls, []);
});
