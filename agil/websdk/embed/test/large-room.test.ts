import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseWidgetMessage } from '../src/bridge.js';
import {
  ConnectionDigest,
  LARGE_ROOM_MAX_PARTICIPANTS,
  ParticipantDigest,
  compactCallState,
  extractParticipantIds,
  normalizeConnectionState,
  normalizeLargeRoomLimits,
  readConnectionFields,
} from '../src/large-room.js';

function ids(count: number, prefix = 'p'): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

test('embed large-room limits default to the 200-participant profile', () => {
  const limits = normalizeLargeRoomLimits();
  assert.equal(limits.maxParticipants, LARGE_ROOM_MAX_PARTICIPANTS);
  assert.equal(limits.maxParticipants, 200);
  assert.equal(normalizeLargeRoomLimits({ maxParticipants: 5_000 }).maxParticipants, 200);
  assert.equal(normalizeLargeRoomLimits({ maxParticipants: 1 }).maxParticipants, 2);
});

test('embed participant digest sends one snapshot then deltas', () => {
  const digest = new ParticipantDigest();
  const first = digest.apply({ participantIds: ids(200), count: 200 });
  assert.ok(first);
  assert.equal(first.kind, 'snapshot');
  assert.equal(first.ids?.length, 200);

  const delta = digest.apply({ participantIds: [...ids(199), 'newcomer'], count: 200 });
  assert.ok(delta);
  assert.equal(delta.kind, 'delta');
  assert.deepEqual(delta.added, ['newcomer']);
  assert.deepEqual(delta.removed, ['p-199']);

  assert.equal(
    digest.apply({ participantIds: [...ids(199), 'newcomer'], count: 200 }),
    null,
  );
});

test('embed digest resynchronises on large churn and truncates above 200', () => {
  const digest = new ParticipantDigest();
  digest.apply({ participantIds: ids(40), count: 40 });
  const snapshot = digest.apply({ participantIds: [...ids(20), ...ids(20, 'q')], count: 40 });
  assert.ok(snapshot);
  assert.equal(snapshot.kind, 'snapshot');
  assert.equal(snapshot.ids?.length, 40);

  const oversized = new ParticipantDigest().apply({ participantIds: ids(260), count: 260 });
  assert.ok(oversized);
  assert.equal(oversized.ids?.length, 200);
  assert.equal(oversized.truncated, true);
});

test('embed compact state drops the 200-id array', () => {
  const digest = new ParticipantDigest();
  const update = digest.apply({ participantIds: ids(200), count: 200 });
  assert.ok(update);
  const state = compactCallState(
    { phase: 'joined', participants: 200, participantIds: ids(200), connectionState: 'connected' },
    update,
  );
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'participantIds'), false);
  assert.equal(state['participantCount'], 200);
  assert.equal(state['participantRevision'], 1);
  assert.ok(JSON.stringify(state).length < 300);
});

test('embed parseWidgetMessage extracts and bounds participantIds', () => {
  const message = parseWidgetMessage({
    type: 'agil:state',
    state: { phase: 'joined', participants: 200, participantIds: ids(210) },
  });
  assert.ok(message);
  assert.equal(message.type, 'agil:state');
  if (message.type !== 'agil:state') return;
  // Profile cap + 1: the extra id lets the digest flag an oversized widget.
  assert.equal(message.participantIds?.length, 201);
  assert.equal(Object.prototype.hasOwnProperty.call(message.state, 'participantIds'), false);

  const noIds = parseWidgetMessage({
    type: 'agil:state',
    state: { phase: 'joined', participants: 3 },
  });
  assert.ok(noIds && noIds.type === 'agil:state' && noIds.participantIds === undefined);
});

test('embed parse path flags a >200-id widget state as truncated', () => {
  const message = parseWidgetMessage({
    type: 'agil:state',
    state: { phase: 'joined', participants: 260, participantIds: ids(260) },
  });
  assert.ok(message && message.type === 'agil:state');
  if (!message || message.type !== 'agil:state') return;

  const update = new ParticipantDigest().apply({
    participantIds: message.participantIds,
    count: message.state.participants,
  });
  assert.ok(update);
  assert.equal(update.kind, 'snapshot');
  assert.equal(update.ids?.length, 200);
  assert.equal(update.truncated, true);

  const lowCap = new ParticipantDigest({ maxParticipants: 50 }).apply({
    participantIds: message.participantIds,
    count: message.state.participants,
  });
  assert.ok(lowCap);
  assert.equal(lowCap.ids?.length, 50);
  assert.equal(lowCap.truncated, true);
});

test('embed empty participantIds are an empty snapshot; absent ids are a summary', () => {
  const empty = parseWidgetMessage({
    type: 'agil:state',
    state: { phase: 'joined', participants: 0, participantIds: [] },
  });
  assert.ok(empty && empty.type === 'agil:state');
  if (!empty || empty.type !== 'agil:state') return;
  assert.deepEqual(empty.participantIds, []);
  const emptyUpdate = new ParticipantDigest().apply({
    participantIds: empty.participantIds,
    count: empty.state.participants,
  });
  assert.ok(emptyUpdate);
  assert.equal(emptyUpdate.kind, 'snapshot');
  assert.deepEqual(emptyUpdate.ids, []);

  const absent = parseWidgetMessage({
    type: 'agil:state',
    state: { phase: 'joined', participants: 0 },
  });
  assert.ok(absent && absent.type === 'agil:state');
  if (!absent || absent.type !== 'agil:state') return;
  assert.equal(absent.participantIds, undefined);
  assert.equal(
    new ParticipantDigest().apply({
      participantIds: absent.participantIds,
      count: absent.state.participants,
    })?.kind,
    'summary',
  );
});

test('embed connection digest deduplicates reconnect transitions', () => {
  const digest = new ConnectionDigest();
  assert.equal(digest.apply({ state: 'reconnecting', attempt: 1, delayMs: 500 })?.reconnecting, true);
  assert.equal(digest.apply({ state: 'reconnecting', attempt: 1, delayMs: 500 }), null);
  const next = digest.apply({ state: 'reconnecting', attempt: 2, delayMs: 1_000 });
  assert.ok(next);
  assert.equal(next.attempt, 2);
  const connected = digest.apply({ state: 'connected' });
  assert.ok(connected);
  assert.equal(connected.previous, 'reconnecting');
  assert.equal(normalizeConnectionState('OPEN'), 'connected');
  assert.deepEqual(readConnectionFields({ payload: { connection: 'offline' } }), {
    state: 'offline',
  });
  assert.equal(extractParticipantIds({ participantIds: [...ids(205), 'p-0'] }).length, 201);
});
