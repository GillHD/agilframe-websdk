/**
 * Headless widget tests for the whiteboard/annotation stroke model.
 *
 * No DOM is involved: `call/whiteboard.ts` owns geometry, optimistic strokes,
 * server reconciliation and the memory caps. Canvas rendering is exercised via
 * `strokeGeometry` (normalized → pixels) so the mapping itself is covered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ANNOTATION_STROKES,
  MAX_WHITEBOARD_POINTS_PER_STROKE,
  MAX_WHITEBOARD_TOTAL_POINTS,
  WHITEBOARD_DEFAULT_COLOR,
  WHITEBOARD_DEFAULT_WIDTH,
  type AnnotationSnapshot,
  type AnnotationStroke,
  type WhiteboardSnapshot,
  type WhiteboardStroke,
} from '@agil/protocol';
import { createStrokeLayer, strokeGeometry } from '../src/call/whiteboard.js';

const SELF = { id: 'self', name: 'Вы' };

function draw(
  layer: ReturnType<typeof createStrokeLayer>,
  points: Array<[number, number]>,
  tool: 'pen' | 'eraser' = 'pen',
): ReturnType<typeof layer.finish> {
  const stroke = layer.begin(tool, WHITEBOARD_DEFAULT_COLOR, WHITEBOARD_DEFAULT_WIDTH, SELF);
  for (const [x, y] of points) layer.addPoint(stroke, x, y);
  return layer.finish(stroke);
}

function serverStroke(partial: Partial<WhiteboardStroke> = {}): WhiteboardStroke {
  return {
    id: 'srv-1',
    seq: 1,
    tool: 'pen',
    color: '#22c55e',
    width: 0.012,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.2 },
    ],
    authorId: 'peer',
    authorName: 'Гость',
    ts: 1000,
    ...partial,
  };
}

function snapshot(overrides: Partial<WhiteboardSnapshot> = {}): WhiteboardSnapshot {
  return {
    roomId: 'room-1',
    open: true,
    locked: false,
    strokes: [serverStroke()],
    revision: 3,
    updatedAt: 1000,
    ts: 1000,
    ...overrides,
  };
}

test('widget whiteboard: draw → normalized stroke frame → server echo dedupe', () => {
  const layer = createStrokeLayer('whiteboard');
  const message = draw(layer, [
    [0.1, 0.2],
    [0.15, 0.25],
    [0.15, 0.25], // duplicate sample is dropped
  ]);
  assert.ok(message);
  assert.equal(message.type, 'whiteboard.stroke');
  if (message.type !== 'whiteboard.stroke') return;
  assert.equal(message.tool, 'pen');
  assert.equal(message.color, WHITEBOARD_DEFAULT_COLOR);
  assert.equal(message.width, WHITEBOARD_DEFAULT_WIDTH);
  assert.equal(message.points?.length, 2, 'duplicate consecutive samples are dropped');
  assert.equal(layer.length, 1);
  assert.equal(layer.items[0]?.pending, true, 'unacknowledged until the server echoes the same id');

  // Server echoes the stroke with the same client id: it must not duplicate.
  layer.ingest({
    ...serverStroke({
      id: message.id ?? 'missing',
      authorId: SELF.id,
      authorName: SELF.name,
      points: message.points ?? [],
    }),
  });
  assert.equal(layer.length, 1);
  assert.equal(layer.items[0]?.pending, false);
  assert.equal(layer.items[0]?.authorId, SELF.id);
});

test('widget whiteboard: points are clamped to 0..1 and local caps hold', () => {
  const layer = createStrokeLayer('whiteboard');
  const message = draw(layer, [
    [-1, 2],
    [0.5, 0.5],
  ]);
  assert.ok(message);
  if (message.type !== 'whiteboard.stroke') return;
  assert.deepEqual(message.points?.[0], { x: 0, y: 1 });

  const stroke = layer.begin('pen', WHITEBOARD_DEFAULT_COLOR, WHITEBOARD_DEFAULT_WIDTH, SELF);
  for (let index = 0; index < MAX_WHITEBOARD_POINTS_PER_STROKE + 50; index += 1) {
    layer.addPoint(stroke, 0.001 * (index % 900), 0.5);
  }
  assert.equal(stroke.points.length, MAX_WHITEBOARD_POINTS_PER_STROKE);
  layer.finish(stroke);
  // Total points cap evicts the oldest confirmed strokes.
  for (let index = 0; index < 25; index += 1) {
    const dense = layer.begin('pen', '#ef4444', 0.006, SELF);
    for (let point = 0; point < 900; point += 1) layer.addPoint(dense, point / 900, 0.4);
    layer.finish(dense);
  }
  assert.ok(layer.totalPoints <= MAX_WHITEBOARD_TOTAL_POINTS, `total=${layer.totalPoints}`);
  assert.ok(layer.length < 26);
});

test('widget whiteboard: remote strokes ingest in order, snapshots replay and keep in-flight strokes', () => {
  const layer = createStrokeLayer('whiteboard');
  layer.ingest(serverStroke({ id: 'a', seq: 1 }));
  layer.ingest(serverStroke({ id: 'b', seq: 2, authorName: 'Анна', tool: 'eraser' }));
  assert.equal(layer.length, 2);
  assert.equal(layer.items[1]?.tool, 'eraser');

  // Local stroke still in flight while a snapshot arrives.
  const pending = layer.begin('pen', '#3b82f6', 0.02, SELF);
  layer.addPoint(pending, 0.7, 0.7);
  layer.finish(pending);
  layer.applySnapshot(snapshot({ strokes: [serverStroke({ id: 'a', seq: 1 }), serverStroke({ id: 'c', seq: 3 })], revision: 9 }));
  assert.equal(layer.revision, 9);
  assert.equal(layer.open, true);
  const ids = layer.items.map((stroke) => stroke.id);
  assert.deepEqual(ids.filter((id) => id !== pending.id), ['a', 'c']);
  assert.ok(ids.includes(pending.id), 'in-flight local stroke is kept');

  // A moderator clear drops anything that was still in flight.
  layer.applySnapshot(snapshot({ strokes: [], revision: 10 }), { dropPending: true });
  assert.equal(layer.length, 0);
  assert.equal(layer.revision, 10);
});

test('widget whiteboard: closed board state and destructive commands', () => {
  const layer = createStrokeLayer('whiteboard');
  layer.applySnapshot(snapshot({ open: false, locked: true, strokes: [] }), {});
  assert.equal(layer.open, false);
  assert.equal(layer.locked, true);
  assert.equal(layer.command('clear').type, 'whiteboard.stroke');
  const clear = layer.command('clear');
  assert.equal(clear.type === 'whiteboard.stroke' ? clear.tool : '', 'clear');
  const undo = layer.command('undo');
  assert.equal(undo.type === 'whiteboard.stroke' ? undo.tool : '', 'undo');
  assert.equal(draw(layer, [[0.3, 0.3]], 'eraser')?.type, 'whiteboard.stroke');
  assert.equal(layer.items[0]?.tool, 'eraser');
});

test('widget annotations: frames, clear command, presenter snapshot and caps', () => {
  const layer = createStrokeLayer('annotation');
  assert.equal(layer.surface, 'annotation');
  const message = draw(layer, [
    [0.2, 0.2],
    [0.8, 0.8],
  ]);
  assert.ok(message);
  assert.equal(message.type, 'annotation.stroke');
  assert.equal(layer.command('clear').type, 'annotation.clear');

  const stroke: AnnotationStroke = {
    id: 'anno-1',
    seq: 1,
    tool: 'pen',
    color: '#a855f7',
    width: 0.006,
    points: [{ x: 0.4, y: 0.6 }],
    authorId: 'peer',
    authorName: 'Гость',
    ts: 5,
  };
  const annotationSnapshot: AnnotationSnapshot = {
    roomId: 'room-1',
    presenterId: 'peer',
    strokes: [stroke],
    revision: 2,
    updatedAt: 5,
    ts: 5,
  };
  layer.applySnapshot(annotationSnapshot);
  assert.equal(layer.presenterId, 'peer');
  assert.equal(layer.length, 2, 'server snapshot replaces confirmed strokes, local stroke stays pending');
  assert.equal(layer.items.filter((item) => item.id === 'anno-1').length, 1);

  // Many strokes: the local layer never exceeds the annotation cap.
  for (let index = 0; index < MAX_ANNOTATION_STROKES + 10; index += 1) {
    layer.ingest({ ...stroke, id: `bulk-${index}`, seq: index + 2 });
  }
  assert.ok(layer.length <= MAX_ANNOTATION_STROKES);
});

test('widget canvas geometry: normalized points map to pixels with a visible minimum width', () => {
  const geometry = strokeGeometry(
    { points: [{ x: 0, y: 0 }, { x: 0.5, y: 1 }], width: 0.004 },
    800,
    400,
  );
  assert.deepEqual(geometry.points, [
    { x: 0, y: 0 },
    { x: 400, y: 400 },
  ]);
  assert.equal(geometry.lineWidth, 1.6);
  const tiny = strokeGeometry({ points: [{ x: 0, y: 0 }], width: 0.001 }, 200, 100);
  assert.equal(tiny.lineWidth, 1, 'hairlines stay visible on phones');
  const huge = strokeGeometry({ points: [{ x: 0, y: 0 }], width: 0.1 }, 200, 100);
  assert.equal(huge.lineWidth, 10);
});
