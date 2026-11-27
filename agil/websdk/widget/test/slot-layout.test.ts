/**
 * Fixed slot matrix tests (call gallery layout shift fix).
 *
 * Two contracts are locked here:
 *  - buckets reserve a constant number of 2×2 / 3×3 / 4×4 / 5×5 / 6×6 slots, so
 *    joining within a bucket can never resize an existing tile;
 *  - unused slots become neutral DOM cells (never fake participants), and the
 *    16:9 fit never overflows the stage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_BUCKETS,
  SLOT_MAX_TILES,
  compactSlotLayout,
  embeddedSlotLayout,
  emptySlotCount,
  fitSlotMatrix,
  normalizeTileCount,
  resolveSlotLayout,
  slotBucketFor,
  slotLayout,
  type SlotKind,
} from '../src/ui/slot-layout.js';

const BOUNDARIES: ReadonlyArray<readonly [number, number, number, number]> = [
  // count, columns, rows, capacity
  // 1–2 are pair/solo compositions, not bucket squares (C-15).
  [1, 1, 1, 1],
  [2, 2, 1, 2],
  [3, 2, 2, 4],
  [4, 2, 2, 4],
  [5, 3, 3, 9],
  [8, 3, 3, 9],
  [9, 3, 3, 9],
  [10, 4, 4, 16],
  [16, 4, 4, 16],
  [17, 5, 5, 25],
  [25, 5, 5, 25],
  [26, 6, 6, 36],
  [36, 6, 6, 36],
];

test('participant buckets reserve 2×2 / 3×3 / 4×4 / 5×5 / 6×6 slots', () => {
  assert.deepEqual(
    SLOT_BUCKETS.map((bucket) => [bucket.min, bucket.max, bucket.columns, bucket.rows, bucket.capacity]),
    [
      [1, 4, 2, 2, 4],
      [5, 9, 3, 3, 9],
      [10, 16, 4, 4, 16],
      [17, 25, 5, 5, 25],
      [26, 36, 6, 6, 36],
    ],
  );
  for (const [count, columns, rows, capacity] of BOUNDARIES) {
    const layout = slotLayout(count);
    assert.equal(layout.columns, columns, `${count} columns`);
    assert.equal(layout.rows, rows, `${count} rows`);
    assert.equal(layout.capacity, capacity, `${count} capacity`);
  }
});

test('every count in a bucket keeps the same geometry (no resize when someone joins)', () => {
  for (const bucket of SLOT_BUCKETS) {
    // 1–2 are the documented pair/solo exception to the square buckets.
    const first = Math.max(bucket.min, 3);
    if (first > bucket.max) continue;
    const reference = slotLayout(first);
    for (let count = first + 1; count <= bucket.max; count += 1) {
      const layout = slotLayout(count);
      assert.equal(layout.columns, reference.columns, `${count} columns stable in ${bucket.min}-${bucket.max}`);
      assert.equal(layout.rows, reference.rows, `${count} rows stable in ${bucket.min}-${bucket.max}`);
      assert.equal(layout.capacity, reference.capacity, `${count} capacity stable in ${bucket.min}-${bucket.max}`);
      // The tile count grows, but the matrix (and therefore every existing tile
      // box) does not change.
      assert.equal(layout.slots.length, reference.capacity);
    }
  }
});

test('unused slots are neutral placeholders: real tiles first, then empties', () => {
  for (const [count, , , capacity] of BOUNDARIES) {
    const layout = slotLayout(count);
    assert.equal(layout.tiles, count);
    assert.equal(layout.empty, capacity - count);
    assert.equal(layout.slots.length, capacity, `${count}: matrix always full`);
    assert.deepEqual(layout.slots.slice(0, count), Array<SlotKind>(count).fill('tile'));
    assert.deepEqual(layout.slots.slice(count), Array<SlotKind>(capacity - count).fill('empty'));
    if (count > 2) assert.equal(emptySlotCount(count), capacity - count);
  }
});

test('a 2-person desktop call is a centred 16:9 pair, not a 2×2 with an empty row', () => {
  const layout = slotLayout(2);
  assert.equal(layout.columns, 2);
  assert.equal(layout.rows, 1);
  assert.equal(layout.capacity, 2);
  assert.equal(layout.empty, 0, 'no 636×358 empty cells under a 2-up pair (C-15)');
  assert.equal(layout.fill, false, 'the pair keeps the documented 16:9 boxes');
  assert.deepEqual(layout.slots, ['tile', 'tile']);
});

test('a solo call fills the stage instead of a 16:9 card in empty cells', () => {
  const solo = slotLayout(1);
  assert.equal(solo.columns, 1);
  assert.equal(solo.rows, 1);
  assert.equal(solo.capacity, 1);
  assert.equal(solo.empty, 0);
  assert.equal(solo.fill, true);
  assert.deepEqual(solo.slots, ['tile']);
});

test('three participants still use the 2×2 matrix with one neutral cell', () => {
  const layout = slotLayout(3);
  assert.equal(layout.columns, 2);
  assert.equal(layout.rows, 2);
  assert.equal(layout.empty, 1);
});

test('defensive counts clamp to the supported matrix', () => {
  assert.equal(normalizeTileCount(Number.NaN), 0);
  assert.equal(normalizeTileCount(-5), 0);
  assert.equal(normalizeTileCount(12.9), 12);
  assert.equal(normalizeTileCount(500), SLOT_MAX_TILES);
  assert.equal(slotBucketFor(0).capacity, 4);
  assert.equal(slotBucketFor(500).capacity, 36);
  assert.equal(slotLayout(500).tiles, 36);
  assert.equal(slotLayout(500).empty, 0);
});

test('16:9 fit is exact and the block never overflows the available box', () => {
  const cases = [
    { columns: 2, rows: 2, width: 1420, height: 776, gap: 8 },
    { columns: 3, rows: 3, width: 1420, height: 776, gap: 8 },
    { columns: 4, rows: 4, width: 1420, height: 776, gap: 8 },
    { columns: 5, rows: 5, width: 1420, height: 776, gap: 8 },
    { columns: 6, rows: 6, width: 1420, height: 776, gap: 8 },
    { columns: 5, rows: 5, width: 378, height: 676, gap: 6 },
    { columns: 2, rows: 2, width: 378, height: 676, gap: 6 },
  ];
  for (const input of cases) {
    const fit = fitSlotMatrix(input);
    assert.ok(fit.tileWidth > 0 && fit.tileHeight > 0);
    assert.ok(
      Math.abs(fit.tileWidth / fit.tileHeight - 16 / 9) < 1e-9,
      `${input.columns}×${input.rows}: tile is exactly 16:9 (${fit.tileWidth}×${fit.tileHeight})`,
    );
    assert.ok(fit.blockWidth <= input.width + 1e-9, `${input.columns}×${input.rows}: no horizontal overflow`);
    assert.ok(fit.blockHeight <= input.height + 1e-9, `${input.columns}×${input.rows}: no vertical overflow`);
  }
});

test('the fit is width-limited on landscape and height-limited on square stages', () => {
  const landscape = fitSlotMatrix({ columns: 6, rows: 6, width: 1420, height: 776, gap: 8 });
  const tall = fitSlotMatrix({ columns: 2, rows: 2, width: 378, height: 676, gap: 6 });
  // 6×6 on a 16:9 stage: height is the limiting axis.
  assert.ok(landscape.tileWidth < (1420 - 5 * 8) / 6 - 1e-9);
  // 2×2 on a tall phone: width is the limiting axis.
  assert.ok(tall.tileWidth > 0);
  assert.ok(Math.abs(tall.tileWidth - (378 - 6) / 2) < 1e-9, 'phone 2×2 fills the width');
});

test('a zero/unknown box degrades to zero without NaN', () => {
  const fit = fitSlotMatrix({ columns: 4, rows: 4, width: 0, height: 0, gap: 8 });
  assert.equal(fit.tileWidth, 0);
  assert.equal(fit.tileHeight, 0);
  assert.equal(fit.blockWidth, 24);
  assert.ok(Number.isFinite(fit.blockHeight));
});

/* ------------------------------------------------------------------ */
/* C-01: narrow stages use a readable, fill-based compact matrix       */
/* ------------------------------------------------------------------ */

const PHONE = { width: 378, height: 663, gap: 6 };
const TABLET = { width: 756, height: 978, gap: 6 };

test('25 tiles on a 390 px phone use four readable columns, never five 70 px ones', () => {
  const layout = compactSlotLayout(25, PHONE);
  assert.equal(layout.columns, 4, 'four columns at 390 px');
  assert.equal(layout.rows, 7);
  assert.equal(layout.tiles, 25);
  assert.equal(layout.capacity, 28);
  assert.equal(layout.empty, 3, 'the last row has three unused cells (no placeholder is rendered in fill mode)');
  assert.equal(layout.fill, true);
  const fit = fitSlotMatrix({ columns: layout.columns, rows: layout.rows, ...PHONE, fill: true });
  assert.ok(fit.tileWidth >= 88, `tile width ${fit.tileWidth} must stay readable (was 70.8 with 5 columns)`);
  assert.ok(fit.tileWidth >= 88 && fit.tileHeight >= 88, 'a fill matrix uses the stage height too');
  assert.ok(fit.blockWidth <= PHONE.width + 1e-9 && fit.blockHeight <= PHONE.height + 1e-9);
});

test('the compact matrix never produces a five-column 390 px gallery', () => {
  for (let count = 1; count <= SLOT_MAX_TILES; count += 1) {
    const layout = compactSlotLayout(count, PHONE);
    assert.ok(layout.columns <= 4, `${count} tiles: ${layout.columns} columns on a phone`);
    const fit = fitSlotMatrix({ columns: layout.columns, rows: layout.rows, ...PHONE, fill: true });
    assert.ok(fit.tileWidth >= 80, `${count} tiles: ${fit.tileWidth.toFixed(1)} px tile is too narrow for a name`);
  }
});

test('small phone calls stack instead of letterboxing into a tiny 16:9 row', () => {
  assert.equal(compactSlotLayout(2, PHONE).columns, 1, '2-up stacks on a phone');
  assert.equal(compactSlotLayout(4, PHONE).columns, 2, '4-up is a 2×2 grid on a phone');
  assert.equal(compactSlotLayout(8, PHONE).columns, 2, '8-up is a 2×4 grid on a phone');
  assert.equal(compactSlotLayout(25, PHONE).columns, 4, '25-up is four columns on a phone');
  // A tablet may use five columns, but every cell stays wide enough for a name.
  const tablet25 = compactSlotLayout(25, TABLET);
  assert.ok(tablet25.columns >= 4 && tablet25.columns <= 5, `tablet 25-up: ${tablet25.columns} columns`);
  const fit = fitSlotMatrix({ columns: tablet25.columns, rows: tablet25.rows, ...TABLET, fill: true });
  assert.ok(fit.tileWidth >= 140, `tablet 25-up tile ${fit.tileWidth.toFixed(1)} px`);
});

test('compact layout never overflows its box for any count', () => {
  for (const box of [PHONE, TABLET, { width: 1024, height: 640, gap: 8 }]) {
    for (let count = 1; count <= SLOT_MAX_TILES; count += 1) {
      const layout = compactSlotLayout(count, box);
      const fit = fitSlotMatrix({ columns: layout.columns, rows: layout.rows, ...box, fill: layout.fill });
      assert.ok(fit.blockWidth <= box.width + 1e-9, `${count} @ ${box.width}: horizontal overflow`);
      assert.ok(fit.blockHeight <= box.height + 1e-9, `${count} @ ${box.width}: vertical overflow`);
      assert.equal(layout.slots.length, layout.capacity);
      assert.equal(layout.empty, layout.capacity - count);
    }
  }
});

test('desktop keeps the 16:9 bucket matrix (36 stays a 6×6 page)', () => {
  const desktop25 = resolveSlotLayout(25, 1440, { width: 1420, height: 776, gap: 8 });
  assert.equal(desktop25.columns, 5);
  assert.equal(desktop25.rows, 5);
  assert.equal(desktop25.fill, false);
  const desktop36 = resolveSlotLayout(36, 1440, { width: 1420, height: 776, gap: 8 });
  assert.equal(desktop36.columns, 6);
  assert.equal(desktop36.rows, 6);
  assert.equal(desktop36.fill, false);
  // A tablet/phone viewport picks the compact matrix instead.
  assert.equal(resolveSlotLayout(25, 390, PHONE).fill, true);
  assert.equal(resolveSlotLayout(25, 768, TABLET).fill, true);
});

test('fit with fill=true uses the whole cell (no 16:9 letterbox)', () => {
  const box = { columns: 4, rows: 7, width: 378, height: 663, gap: 6 };
  const fill = fitSlotMatrix({ ...box, fill: true });
  assert.ok(Math.abs(fill.tileWidth - (378 - 3 * 6) / 4) < 1e-9);
  assert.ok(Math.abs(fill.tileHeight - (663 - 6 * 6) / 7) < 1e-9);
  assert.ok(Math.abs(fill.blockWidth - 378) < 1e-9, 'a fill matrix spans the full width');
  assert.ok(Math.abs(fill.blockHeight - 663) < 1e-9, 'a fill matrix spans the full height');
  const letterbox = fitSlotMatrix(box);
  assert.ok(letterbox.tileHeight < fill.tileHeight, '16:9 keeps the letterboxed box');
});

test('embedded desktop: 16:9 cards keep exact tiles, other host aspects fill', () => {
  // The real embedded call card is a 16:9 video surface: 2×2 exact 16:9 tiles.
  const card = embeddedSlotLayout(4, { width: 646, height: 363, gap: 8 });
  assert.equal(card.fill, false, '16:9 stage keeps the documented bucket matrix');
  const fit = fitSlotMatrix({
    columns: card.columns,
    rows: card.rows,
    width: 646,
    height: 363,
    gap: 8,
    fill: card.fill,
  });
  assert.ok(Math.abs(fit.tileWidth / fit.tileHeight - 16 / 9) < 0.02, 'tiles stay 16:9');

  // 1440×900 edge-to-edge / 680×760 host: fill the card, no letterbox band.
  for (const box of [
    { width: 1440, height: 856, gap: 8 },
    { width: 680, height: 716, gap: 8 },
    { width: 1024, height: 756, gap: 8 },
  ]) {
    const layout = embeddedSlotLayout(4, box);
    assert.equal(layout.fill, true, `${box.width}×${box.height} fills the host`);
    const filled = fitSlotMatrix({ columns: layout.columns, rows: layout.rows, ...box, fill: true });
    assert.ok(Math.abs(filled.blockWidth - box.width) < 1e-9);
    assert.ok(Math.abs(filled.blockHeight - box.height) < 1e-9);
  }

  // 1–2 participants keep the documented full-bleed solo and 16:9 pair.
  assert.equal(embeddedSlotLayout(1, { width: 680, height: 716, gap: 8 }).fill, true);
  assert.equal(embeddedSlotLayout(2, { width: 680, height: 716, gap: 8 }).fill, false);
});
