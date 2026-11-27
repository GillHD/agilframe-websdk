/** Media badge: P2P direct 1:1 vs SFU group (docs/p2p.md). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDirectOneToOne, resolveMediaBadge } from '../src/ui/media-badge.js';

test('direct 1:1 mesh room shows P2P, keeping the mesh media mode for tests', () => {
  const view = resolveMediaBadge({ mediaMode: 'mesh', roomMode: 'direct', maxParticipants: 2 });
  assert.equal(view.text, 'P2P');
  assert.notEqual(view.text, 'mesh');
  assert.equal(view.transport, 'p2p');
  assert.equal(view.titleKey, 'mediaModeP2p');
  assert.equal(view.hidden, false);
});

test('direct 1:1 without an explicit cap is still P2P', () => {
  assert.equal(isDirectOneToOne({ roomMode: 'direct' }), true);
  assert.equal(resolveMediaBadge({ mediaMode: 'mesh', roomMode: 'direct' }).text, 'P2P');
});

test('grouped mesh call never claims P2P: badge is hidden, transport stays mesh', () => {
  const view = resolveMediaBadge({ mediaMode: 'mesh', roomMode: 'group', maxParticipants: 8 });
  assert.equal(view.hidden, true);
  assert.equal(view.text, '');
  assert.equal(view.transport, 'mesh');
  assert.equal(view.titleKey, 'mediaModeMesh');
});

test('a direct room above the 1:1 cap is not presented as P2P', () => {
  assert.equal(isDirectOneToOne({ roomMode: 'direct', maxParticipants: 3 }), false);
  assert.equal(resolveMediaBadge({ mediaMode: 'mesh', roomMode: 'direct', maxParticipants: 3 }).hidden, true);
});

test('SFU group stays SFU; direct SFU also stays SFU', () => {
  const group = resolveMediaBadge({ mediaMode: 'sfu', roomMode: 'group', maxParticipants: 50 });
  assert.deepEqual([group.text, group.transport, group.titleKey, group.hidden], ['SFU', 'sfu', 'mediaModeSfu', false]);
  const direct = resolveMediaBadge({ mediaMode: 'sfu', roomMode: 'direct', maxParticipants: 2 });
  assert.deepEqual([direct.text, direct.transport], ['SFU', 'sfu']);
});

test('broadcast keeps its own label and transport', () => {
  const view = resolveMediaBadge({ mediaMode: 'broadcast', roomMode: 'group' });
  assert.deepEqual([view.text, view.transport, view.titleKey], ['Broadcast', 'broadcast', 'mediaModeBroadcast']);
});
