import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, parseClientMessage, clientMessageSchema, PROTOCOL_VERSION } from '../src/signaling.js';

test('parses every client message type', () => {
  const messages = [
    { type: 'hello', name: 'Аня', locale: 'ru' },
    { type: 'sdp', to: 'p2', description: { type: 'offer', sdp: 'v=0' } },
    { type: 'ice', to: 'p2', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' } },
    { type: 'chat', id: 'm1', text: 'привет' },
    { type: 'state', state: { mic: 'off', handRaised: true } },
    { type: 'reaction', emoji: '👍' },
    { type: 'ping', ts: 1 },
    { type: 'bye' },
    { type: 'history', limit: 50 },
  ];
  for (const message of messages) {
    const parsed = parseClientMessage(JSON.stringify(message));
    assert.equal(parsed.ok, true, `failed: ${message.type}`);
  }
});

test('rejects malformed payloads without throwing', () => {
  assert.deepEqual(parseClientMessage('{not json'), { ok: false, error: 'invalid_json' });
  const bad = parseClientMessage(JSON.stringify({ type: 'sdp', to: '', description: { type: 'offer', sdp: '' } }));
  assert.equal(bad.ok, false);
  const unknown = parseClientMessage(JSON.stringify({ type: 'nope' }));
  assert.equal(unknown.ok, false);
});

test('chat message limits', () => {
  assert.equal(clientMessageSchema.safeParse({ type: 'chat', id: 'a', text: '' }).success, false);
  assert.equal(clientMessageSchema.safeParse({ type: 'chat', id: 'a', text: 'x'.repeat(4001) }).success, false);
  assert.equal(clientMessageSchema.safeParse({ type: 'chat', id: 'a', text: 'x' }).success, true);
});

test('participant state carries recording start/stop flags', () => {
  const start = parseClientMessage(JSON.stringify({ type: 'state', state: { recording: true, recordingStartedAt: 1_700_000_000_000 } }));
  assert.equal(start.ok, true);
  if (start.ok && start.message.type === 'state') {
    assert.equal(start.message.state.recording, true);
    assert.equal(start.message.state.recordingStartedAt, 1_700_000_000_000);
  }
  const stop = parseClientMessage(JSON.stringify({ type: 'state', state: { recording: false, recordingStartedAt: null } }));
  assert.equal(stop.ok, true);
  if (stop.ok && stop.message.type === 'state') {
    assert.equal(stop.message.state.recording, false);
    assert.equal(stop.message.state.recordingStartedAt, null);
  }
  // The field is a millisecond timestamp: negative/fractional values are invalid.
  assert.equal(
    parseClientMessage(JSON.stringify({ type: 'state', state: { recordingStartedAt: -1 } })).ok,
    false,
  );
  assert.equal(
    parseClientMessage(JSON.stringify({ type: 'state', state: { recordingStartedAt: 1.5 } })).ok,
    false,
  );
});

test('encodeMessage produces JSON with type', () => {
  const encoded = encodeMessage({ type: 'peer-left', participantId: 'p1' });
  assert.equal(JSON.parse(encoded).type, 'peer-left');
});

test('protocol version is exported', () => {
  assert.equal(PROTOCOL_VERSION, 1);
});
