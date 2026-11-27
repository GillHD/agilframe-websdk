import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GalleryFrameCache } from '../src/ui/gallery-frame-cache.js';

function frame(): HTMLCanvasElement {
  return { width: 192, height: 108, remove() {} } as unknown as HTMLCanvasElement;
}

test('camera snapshots expire 30 seconds after capture and release their buffers', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let updates = 0;
  const cache = new GalleryFrameCache(() => { updates += 1; });
  const first = frame();
  const second = frame();
  cache.save('first', 'camera-a', first);
  t.mock.timers.tick(1000);
  cache.save('second', 'camera-b', second);
  t.mock.timers.tick(29_000);
  assert.equal(cache.get('first'), undefined);
  assert.equal(first.width, 0);
  assert.equal(cache.get('second'), second);
  t.mock.timers.tick(1000);
  assert.equal(cache.get('second'), undefined);
  assert.equal(second.height, 0);
  assert.equal(updates, 2);
});

test('keeps up to 48 recently used frames and removes revoked and replaced cameras', () => {
  const cache = new GalleryFrameCache(() => {});
  const first = frame();
  const replaced = frame();
  const valid = frame();
  const recentlyUsed = frame();
  try {
    cache.save('recently-used', 'camera', recentlyUsed);
    cache.save('oldest', 'camera-old', first);
    for (let i = 0; i < 46; i += 1) cache.save(`participant-${i}`, 'camera', frame());
    assert.equal(cache.get('recently-used'), recentlyUsed);
    cache.save('replaced', 'camera-before-switch', replaced);
    cache.save('valid', 'camera-current', valid);
    assert.equal(cache.get('oldest'), undefined);
    assert.equal(first.width, 0);
    assert.equal(cache.get('recently-used'), recentlyUsed);
    cache.retain((id, publicationId) => id === 'valid' && publicationId === 'camera-current');
    assert.equal(cache.get('replaced'), undefined);
    assert.equal(replaced.width, 0);
    assert.equal(cache.get('valid'), valid);
  } finally {
    cache.clear();
  }
  assert.equal(valid.height, 0);
});
