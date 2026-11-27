/** Whiteboard/annotation protocol: schemas, semantic stroke validation, caps. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ANNOTATION_POINTS_PER_STROKE,
  MAX_WHITEBOARD_POINTS_PER_STROKE,
  MAX_WHITEBOARD_STROKE_BYTES,
  WHITEBOARD_DEFAULT_COLOR,
  WHITEBOARD_DEFAULT_WIDTH,
  normalizeWhiteboardPoint,
  parseClientMessage,
  strokePointsBytes,
  whiteboardStrokeProblem,
} from '../src/index.js';

test('protocol: whiteboard stroke semantics (pen requires points, clear/undo forbid them)', () => {
  assert.equal(whiteboardStrokeProblem({ tool: 'pen', points: [{ x: 0.1, y: 0.2 }] }), null);
  assert.equal(whiteboardStrokeProblem({ tool: 'pen', points: [] }), 'points_required');
  assert.equal(whiteboardStrokeProblem({ tool: 'eraser' }), 'points_required');
  assert.equal(whiteboardStrokeProblem({ tool: 'clear' }), null);
  assert.equal(whiteboardStrokeProblem({ tool: 'undo' }), null);
  assert.equal(whiteboardStrokeProblem({ tool: 'clear', points: [{ x: 0, y: 0 }] }), 'points_not_allowed_for_command');
  assert.equal(whiteboardStrokeProblem({ tool: 'pen', color: 'red', points: [{ x: 0, y: 0 }] }), 'invalid_color');
  assert.equal(whiteboardStrokeProblem({ tool: 'pen', color: '#12ab34', points: [{ x: 0, y: 0 }] }), null);
  assert.equal(whiteboardStrokeProblem({ tool: 'pen', width: 0, points: [{ x: 0, y: 0 }] }), 'invalid_width');
  assert.equal(whiteboardStrokeProblem({ tool: 'pen', width: 0.5, points: [{ x: 0, y: 0 }] }), 'invalid_width');
  const tooMany = Array.from({ length: MAX_WHITEBOARD_POINTS_PER_STROKE + 1 }, () => ({ x: 0, y: 0 }));
  assert.equal(whiteboardStrokeProblem({ tool: 'pen', points: tooMany }), 'too_many_points');
});

test('protocol: parse whiteboard.open/close/stroke/sync frames', () => {
  const open = parseClientMessage(JSON.stringify({ type: 'whiteboard.open' }));
  assert.equal(open.ok, true);
  const close = parseClientMessage(JSON.stringify({ type: 'whiteboard.close', reason: 'done' }));
  assert.equal(close.ok, true);
  const stroke = parseClientMessage(
    JSON.stringify({
      type: 'whiteboard.stroke',
      id: 's1',
      tool: 'pen',
      color: WHITEBOARD_DEFAULT_COLOR,
      width: WHITEBOARD_DEFAULT_WIDTH,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    }),
  );
  assert.equal(stroke.ok, true);
  if (stroke.ok) {
    assert.equal(stroke.message.type, 'whiteboard.stroke');
    if (stroke.message.type === 'whiteboard.stroke') {
      assert.equal(stroke.message.tool, 'pen');
      assert.equal(stroke.message.points?.length, 2);
    }
  }
  const clear = parseClientMessage(JSON.stringify({ type: 'whiteboard.stroke', tool: 'clear' }));
  assert.equal(clear.ok, true);
  const sync = parseClientMessage(JSON.stringify({ type: 'whiteboard.sync' }));
  assert.equal(sync.ok, true);

  // Rejections: unknown tool, bad color, point out of range, invalid command type.
  for (const bad of [
    { type: 'whiteboard.stroke', tool: 'spray', points: [{ x: 0, y: 0 }] },
    { type: 'whiteboard.stroke', tool: 'pen', color: 'javascript:alert(1)', points: [{ x: 0, y: 0 }] },
    { type: 'whiteboard.stroke', tool: 'pen', points: [{ x: 1.5, y: 0 }] },
    { type: 'whiteboard.stroke', tool: 'pen', points: [{ x: -0.1, y: 0 }] },
    { type: 'whiteboard.stroke', tool: 'pen', points: [{ x: 0, y: 0 }], width: 0 },
    { type: 'whiteboard.unknown' },
  ]) {
    assert.equal(parseClientMessage(JSON.stringify(bad)).ok, false, JSON.stringify(bad));
  }
});

test('protocol: annotation frames use normalized points and a pen/eraser tool', () => {
  const ok = parseClientMessage(
    JSON.stringify({ type: 'annotation.stroke', id: 'a1', tool: 'eraser', points: [{ x: 0.25, y: 0.75 }] }),
  );
  assert.equal(ok.ok, true);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'annotation.stroke', tool: 'pen', points: [] })).ok, false);
  assert.equal(
    parseClientMessage(JSON.stringify({ type: 'annotation.stroke', tool: 'clear', points: [{ x: 0, y: 0 }] })).ok,
    false,
  );
  assert.equal(parseClientMessage(JSON.stringify({ type: 'annotation.clear' })).ok, true);
  const tooMany = Array.from({ length: MAX_ANNOTATION_POINTS_PER_STROKE + 1 }, () => ({ x: 0, y: 0 }));
  assert.equal(parseClientMessage(JSON.stringify({ type: 'annotation.stroke', tool: 'pen', points: tooMany })).ok, false);
});

test('protocol: point normalization clamps into 0..1 and rejects non-finite input', () => {
  assert.deepEqual(normalizeWhiteboardPoint(-2, 3), { x: 0, y: 1 });
  assert.deepEqual(normalizeWhiteboardPoint(0.4, 0.6), { x: 0.4, y: 0.6 });
  assert.equal(normalizeWhiteboardPoint(Number.NaN, 0.5), null);
  assert.equal(normalizeWhiteboardPoint(0.5, Number.POSITIVE_INFINITY), null);
});

test('protocol: stroke byte cap actually bounds a maximum-size stroke', () => {
  const points = Array.from({ length: MAX_WHITEBOARD_POINTS_PER_STROKE }, (_, index) => ({
    x: Math.min(1, index / MAX_WHITEBOARD_POINTS_PER_STROKE),
    y: 0.123456789012345,
  }));
  const bytes = strokePointsBytes(points);
  // A maximum-length stroke with high-precision coordinates is over the
  // server byte budget on purpose: the server rejects it with `too_large`
  // instead of buffering it, and the docs state the limit.
  assert.ok(bytes > MAX_WHITEBOARD_STROKE_BYTES, `expected > ${MAX_WHITEBOARD_STROKE_BYTES}, got ${bytes}`);
  assert.ok(strokePointsBytes([{ x: 0.5, y: 0.5 }]) < 100);
});
