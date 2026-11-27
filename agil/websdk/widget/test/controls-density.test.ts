/**
 * Toolbar density policy tests.
 *
 * These lock the rules that keep the call screen stable and uncluttered:
 *  - 2 / 4 / 8+ thresholds are explicit;
 *  - the participant list never appears twice;
 *  - the primary bar set is unique, and `leave` is always the rightmost item;
 *  - `bar` collapses into `island` only below 640 px.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAR_CENTER,
  HEADER_OWNED_CONTROLS,
  compactControlKeys,
  fillQuickAccess,
  controlDensity,
  groupOverflowControls,
  isNarrowControlsViewport,
  isPrimaryBarControl,
  overflowBarControls,
  overflowGroupOf,
  primaryBarControls,
  resolveControlsStyle,
  type ControlButtonId,
} from '../src/ui/controls-density.js';

test('compact toolbar keeps the device buttons and moves lower-priority actions to overflow as the host shrinks', () => {
  assert.deepEqual(compactControlKeys(390), ['mic', 'camera', 'screen', 'chat', 'assistant']);
  assert.deepEqual(compactControlKeys(389), ['mic', 'camera', 'chat', 'assistant']);
  assert.deepEqual(compactControlKeys(329), ['mic', 'camera', 'assistant']);
  assert.deepEqual(compactControlKeys(279), ['mic', 'camera']);
});

test('density buckets are 1–2 / 3–4 / 5–8 / 9+', () => {
  assert.equal(controlDensity(1), 'solo');
  assert.equal(controlDensity(2), 'solo');
  assert.equal(controlDensity(3), 'duo');
  assert.equal(controlDensity(4), 'duo');
  assert.equal(controlDensity(5), 'group');
  assert.equal(controlDensity(8), 'group');
  assert.equal(controlDensity(9), 'large');
  assert.equal(controlDensity(200), 'large');
});

test('unavailable toolbar actions make space for working actions in configured order', () => {
  const preferred = ['mic', 'camera', 'screen', 'chat', 'assistant'] as const;
  const available = (id: ControlButtonId) => id !== 'chat' && id !== 'assistant';
  assert.deepEqual(fillQuickAccess(preferred, ['pip', 'polls', 'hand', 'settings'], available),
    ['mic', 'camera', 'screen', 'polls', 'hand']);
  assert.deepEqual(fillQuickAccess(preferred, ['pip', 'polls'], () => true), [...preferred]);
});

test('density is defensive about missing or invalid counts', () => {
  assert.equal(controlDensity(Number.NaN), 'solo');
  assert.equal(controlDensity(-4), 'solo');
  assert.equal(controlDensity(2.9), 'solo');
  assert.equal(controlDensity(3.1), 'duo');
});

test('bar grows only in the centre zone: left/right never change', () => {
  const solo = primaryBarControls('solo');
  const duo = primaryBarControls('duo');
  const group = primaryBarControls('group');
  const large = primaryBarControls('large');

  for (const ids of [solo, duo, group, large]) {
    // Left zone is always mic + camera; destructive action is always last.
    assert.deepEqual(ids.slice(0, 2), ['mic', 'camera']);
    assert.equal(ids.at(-1), 'leave');
  }
  // The centre grows by appending, so mic/camera and leave never move.
  const soloCentre = BAR_CENTER.solo;
  const duoCentre = BAR_CENTER.duo;
  const groupCentre = BAR_CENTER.group;
  const largeCentre = BAR_CENTER.large;
  assert.deepEqual(duoCentre.slice(0, soloCentre.length), soloCentre);
  assert.deepEqual(groupCentre.slice(0, duoCentre.length), duoCentre);
  assert.deepEqual(largeCentre.slice(0, groupCentre.length), groupCentre);
});

test('primary controls are unique (no duplicate buttons)', () => {
  for (const density of ['solo', 'duo', 'group', 'large'] as const) {
    const ids = primaryBarControls(density);
    assert.equal(new Set(ids).size, ids.length, `${density} has duplicates`);
  }
});

test('panel entry points are header-owned, never toolbar items', () => {
  for (const density of ['solo', 'duo', 'group', 'large'] as const) {
    for (const id of HEADER_OWNED_CONTROLS) {
      assert.equal(isPrimaryBarControl(id, density), false, `${id} is primary in ${density}`);
    }
  }
});

test('overflow excludes primary, header-owned and leave buttons', () => {
  const order: ControlButtonId[] = [
    'mic',
    'camera',
    'video-menu',
    'screen',
    'chat',
    'hand',
    'reactions',
    'participants',
    'polls',
    'notes',
    'transcript',
    'assistant',
    'recording',
    'captions',
    'fullscreen',
    'settings',
    'leave',
  ];
  const overflow = overflowBarControls(order, 'solo', () => true);
  assert.deepEqual(overflow, ['polls', 'notes', 'transcript', 'recording', 'captions', 'settings']);
  for (const hidden of HEADER_OWNED_CONTROLS) assert.equal(overflow.includes(hidden), false);
  assert.equal(overflow.includes('leave'), false);
  assert.equal(overflow.includes('video-menu'), false);
  assert.equal(overflow.includes('camera'), false);
});

test('overflow respects visibility and de-duplicates the order', () => {
  const order: ControlButtonId[] = ['polls', 'polls', 'whiteboard', 'assistant', 'participants'];
  const overflow = overflowBarControls(order, 'group', (id) => id !== 'whiteboard');
  assert.deepEqual(overflow, ['polls']);
});

test('the centre zone never contains the destructive action', () => {
  for (const density of ['solo', 'duo', 'group', 'large'] as const) {
    assert.equal(BAR_CENTER[density].includes('leave'), false);
  }
});

test('classic bar collapses into an island at 640 px and below', () => {
  assert.equal(isNarrowControlsViewport(390), true);
  assert.equal(isNarrowControlsViewport(640), true);
  assert.equal(isNarrowControlsViewport(641), false);
  assert.equal(isNarrowControlsViewport(1440), false);
  assert.equal(resolveControlsStyle('bar', true), 'island');
  assert.equal(resolveControlsStyle('bar', false), 'bar');
  assert.equal(resolveControlsStyle('island', false), 'island');
  assert.equal(resolveControlsStyle('minimal', true), 'minimal');
  assert.equal(resolveControlsStyle(undefined, true), 'island');
});

test('hand and reactions are available in the centre at every density', () => {
  for (const density of ['solo', 'duo', 'group', 'large'] as const) {
    assert.ok(BAR_CENTER[density].includes('hand'));
    assert.ok(BAR_CENTER[density].includes('reactions'));
  }
});

/* ------------------------------------------------------------------ */
/* C-08: overflow is grouped and labelled                             */
/* ------------------------------------------------------------------ */

test('overflow groups are media / meeting / admin, preserving order', () => {
  assert.equal(overflowGroupOf('pip'), 'media');
  assert.equal(overflowGroupOf('fullscreen'), 'media');
  assert.equal(overflowGroupOf('newtab'), 'media');
  assert.equal(overflowGroupOf('minimize'), 'media');
  assert.equal(overflowGroupOf('settings'), 'admin');
  assert.equal(overflowGroupOf('polls'), 'meeting');
  assert.equal(overflowGroupOf('assistant'), 'meeting');

  const groups = groupOverflowControls([
    'polls',
    'assistant',
    'pip',
    'fullscreen',
    'newtab',
    'minimize',
    'settings',
  ]);
  assert.deepEqual(
    groups.map((entry) => entry.group),
    ['media', 'meeting', 'admin'],
  );
  assert.deepEqual(groups[0]?.ids, ['pip', 'fullscreen', 'newtab', 'minimize']);
  assert.deepEqual(groups[1]?.ids, ['polls', 'assistant']);
  assert.deepEqual(groups[2]?.ids, ['settings']);
  // Every id appears exactly once.
  const flat = groups.flatMap((entry) => entry.ids);
  assert.equal(new Set(flat).size, flat.length);
});

test('empty overflow groups are dropped (no dangling headings)', () => {
  const groups = groupOverflowControls(['polls']);
  assert.deepEqual(groups, [{ group: 'meeting', ids: ['polls'] }]);
  assert.deepEqual(groupOverflowControls([]), []);
});

test('every overflow action carries a group, so none can render unlabeled', () => {
  const all: ControlButtonId[] = [
    'pip',
    'fullscreen',
    'newtab',
    'minimize',
    'settings',
    'polls',
    'assistant',
    'recording',
    'captions',
    'whiteboard',
    'annotate',
  ];
  for (const id of all) {
    const group = overflowGroupOf(id);
    assert.ok(['media', 'meeting', 'admin'].includes(group), `${id} has no group`);
  }
});
