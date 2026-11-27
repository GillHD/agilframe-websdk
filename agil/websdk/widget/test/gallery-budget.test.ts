/**
 * Adaptive gallery video budget (2 / 8 / 25 / 200 participants).
 *
 * The page still renders every tile, but only `budget` remote videos are
 * subscribed: all visible videos up to 8 people, then the deployed capacity
 * profile budget — low 2, standard 6, high 12 — with pinned + active speaker
 * first. A manual “play video” promotion outranks the automatic speaker;
 * pinned and active-speaker videos are protected from page-order eviction.
 * Audio is not budgeted at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '@agil/protocol';
import {
  DEFAULT_GALLERY_CAPACITY_PROFILE,
  GALLERY_ALL_VIDEOS_MAX_PARTICIPANTS,
  GALLERY_VIDEO_BUDGET_BY_PROFILE,
  planVideoSubscriptions,
  resolveGalleryVideoBudget,
  resolveGalleryVideoBudgetForConfig,
  sfuProfileVideoBudget,
} from '../src/call/large-room.js';
import { createInitialState } from '../src/state.js';

const remotes = (count: number, prefix = 'p') =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` }));

function planFor(totalParticipants: number, extra: Partial<Parameters<typeof planVideoSubscriptions>[0]> = {}) {
  const participants = remotes(Math.max(0, totalParticipants - 1));
  return planVideoSubscriptions({
    participants,
    page: 0,
    pageSize: 36,
    hasSelf: true,
    maxVideoSubscriptions: 36,
    // The promotion/eviction tests model the current pilot node (low = 2);
    // profile-selection tests override this explicitly.
    capacityProfile: 'low',
    ...extra,
  });
}

test('capacity profiles select 2 / 6 / 12 remote videos; default is standard', () => {
  assert.equal(GALLERY_ALL_VIDEOS_MAX_PARTICIPANTS, 8);
  assert.deepEqual(GALLERY_VIDEO_BUDGET_BY_PROFILE, { low: 2, standard: 6, high: 12 });
  assert.equal(DEFAULT_GALLERY_CAPACITY_PROFILE, 'standard');
  assert.equal(sfuProfileVideoBudget(undefined), 6, 'unset profile = new-deployment default');
  assert.equal(sfuProfileVideoBudget('turbo'), 6, 'unknown profile falls back to standard');
  assert.equal(sfuProfileVideoBudget('low'), 2);
  assert.equal(sfuProfileVideoBudget('standard'), 6);
  assert.equal(sfuProfileVideoBudget('high'), 12);
});

test('adaptive budget: all visible up to 8, then the profile budget for 9/25/50/200', () => {
  assert.equal(resolveGalleryVideoBudget(0), 1, 'an empty room still reports a positive budget');
  assert.equal(resolveGalleryVideoBudget(2), 2);
  assert.equal(resolveGalleryVideoBudget(8), 8, 'a mesh-sized room keeps all visible videos');
  assert.equal(resolveGalleryVideoBudget(4, { capacityProfile: 'low' }), 4, 'small rooms ignore the profile budget');

  assert.equal(resolveGalleryVideoBudget(9), 6, 'default standard profile');
  assert.equal(resolveGalleryVideoBudget(25), 6);
  assert.equal(resolveGalleryVideoBudget(50), 6);
  assert.equal(resolveGalleryVideoBudget(51), 6);
  assert.equal(resolveGalleryVideoBudget(200), 6);

  assert.equal(resolveGalleryVideoBudget(25, { capacityProfile: 'low' }), 2, 'current pilot');
  assert.equal(resolveGalleryVideoBudget(200, { capacityProfile: 'low' }), 2);
  assert.equal(resolveGalleryVideoBudget(25, { capacityProfile: 'standard' }), 6);
  assert.equal(resolveGalleryVideoBudget(25, { capacityProfile: 'high' }), 12);
  assert.equal(resolveGalleryVideoBudget(200, { capacityProfile: 'high' }), 12);
});

test('config overrides: limits.galleryVideoBudget wins over scale.maxVisibleVideos and the profile, hard cap wins over all', () => {
  assert.equal(resolveGalleryVideoBudget(25, { galleryVideoBudget: 3 }), 3);
  assert.equal(resolveGalleryVideoBudget(25, { maxVisibleVideos: 5 }), 5);
  assert.equal(resolveGalleryVideoBudget(25, { galleryVideoBudget: 3, maxVisibleVideos: 5 }), 3);
  assert.equal(
    resolveGalleryVideoBudget(25, { capacityProfile: 'high', galleryVideoBudget: 3 }),
    3,
    'the explicit override wins over the profile budget',
  );
  assert.equal(
    resolveGalleryVideoBudget(25, { capacityProfile: 'low', galleryVideoBudget: 10 }),
    10,
    'an operator can raise the budget above the profile',
  );
  assert.equal(resolveGalleryVideoBudget(25, { galleryVideoBudget: 10, maxVideoSubscriptions: 4 }), 4);
  assert.equal(resolveGalleryVideoBudget(25, { galleryVideoBudget: 10 }), 10);
  assert.equal(resolveGalleryVideoBudget(25, { capacityProfile: 'high', maxVideoSubscriptions: 4 }), 4);
  assert.equal(resolveGalleryVideoBudget(2, { galleryVideoBudget: 1 }), 1);
  assert.equal(
    resolveGalleryVideoBudgetForConfig(
      { limits: { galleryVideoBudget: 3 }, scale: { maxVisibleVideos: 5, maxVideoSubscriptions: 36 } },
      25,
    ),
    3,
  );
  assert.equal(
    resolveGalleryVideoBudgetForConfig({ scale: { maxVisibleVideos: 5, maxVideoSubscriptions: 2 } }, 25),
    2,
  );
  assert.equal(
    resolveGalleryVideoBudgetForConfig({ scale: { maxVideoSubscriptions: 1 } }, 25),
    1,
    'the hard cap can lower the profile budget',
  );
  assert.equal(
    resolveGalleryVideoBudgetForConfig({ limits: { maxVideoSubscriptions: 1 }, scale: { maxVideoSubscriptions: 36 } }, 25),
    1,
  );
  assert.equal(
    resolveGalleryVideoBudgetForConfig({ scale: { sfu: { capacityProfile: 'high' } } }, 25),
    12,
    'a tenant can select the profile in scale.sfu.capacityProfile',
  );
  assert.equal(
    resolveGalleryVideoBudgetForConfig(
      { scale: { sfu: { capacityProfile: 'low' }, maxVideoSubscriptions: 36 } },
      200,
    ),
    2,
    'a low-profile tenant stays at 2 under the default 36-video ceiling',
  );
});

test('the default tenant config is standard: a 25-person room subscribes 6 videos', () => {
  const config = defaultConfig();
  assert.equal(config.scale.sfu.capacityProfile, 'standard');
  const plan = planFor(25, { capacityProfile: undefined });
  assert.equal(plan.budget, 6);
  assert.equal(plan.visible.length, 24, 'the grid still renders every remote tile on the page');
  assert.deepEqual(plan.submit, ['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5']);
  assert.equal(plan.dropped.length, 18);
});

test('high profile subscribes 12 videos and still caps at scale.maxVideoSubscriptions', () => {
  const high = planFor(200, { capacityProfile: 'high' });
  assert.equal(high.budget, 12);
  assert.equal(high.submit.length, 12);
  assert.equal(high.dropped.length, 187, '199 remotes minus 12 video slots');

  const capped = planFor(200, { capacityProfile: 'high', maxVideoSubscriptions: 8 });
  assert.equal(capped.budget, 8);
  assert.equal(capped.submit.length, 8);
});

test('standard profile keeps pin and speaker plus four ordinary page videos', () => {
  const plan = planFor(25, { capacityProfile: 'standard', pinnedId: 'p-20', speakerId: 'p-21' });
  assert.equal(plan.budget, 6);
  assert.equal(plan.submit.length, 6);
  assert.deepEqual(plan.submit, ['p-20', 'p-21', 'p-2', 'p-3', 'p-4', 'p-5']);
  assert.deepEqual(plan.evicted, ['p-0', 'p-1']);
});

test('click-to-play swaps an ordinary slot on a standard-profile client', () => {
  const promoted = planFor(25, { capacityProfile: 'standard', promotedIds: ['p-20'] });
  assert.equal(promoted.budget, 6);
  assert.equal(promoted.submit.length, 6);
  assert.ok(promoted.submit.includes('p-20'), 'the clicked tile gets a video');
  assert.ok(!promoted.submit.includes('p-0'), 'the first ordinary page tile is evicted');
  assert.deepEqual(promoted.evicted, ['p-0']);
});

test('2 participants: the single remote video is visible, self is not a subscription', () => {
  const plan = planFor(2);
  assert.equal(plan.budget, 2);
  assert.equal(plan.visible.length, 1);
  assert.deepEqual(plan.submit, ['p-0']);
  assert.deepEqual(plan.audio, ['p-0']);
  assert.deepEqual(plan.dropped, []);
});

test('8 participants: every visible remote video is subscribed', () => {
  const plan = planFor(8);
  assert.equal(plan.budget, 8, '8 total participants (7 remotes + self)');
  assert.equal(plan.visible.length, 7);
  assert.deepEqual(plan.submit, plan.visible);
  assert.equal(plan.dropped.length, 0);
  assert.equal(plan.audio.length, 7);
});

test('25 participants: 24 tiles render but only the pinned/active-speaker budget of 2 is subscribed', () => {
  const plan = planFor(25);
  assert.equal(plan.budget, 2);
  assert.equal(plan.visible.length, 24, 'the grid still renders the whole page');
  assert.equal(plan.submit.length, 2);
  assert.deepEqual(plan.submit, ['p-0', 'p-1']);
  assert.equal(plan.dropped.length, 22);
  assert.equal(plan.evicted.length, 0);
});

test('200 participants on the low profile: the same 2-video active-speaker budget applies above 50', () => {
  const plan = planFor(200);
  assert.equal(plan.budget, 2);
  assert.equal(plan.visible.length, 35, 'desktop page still renders 35 remotes + self');
  assert.equal(plan.submit.length, 2);
  assert.deepEqual(plan.submit, ['p-0', 'p-1']);
  assert.equal(plan.dropped.length, 197, '199 remotes in a 200-person room minus the 2 video slots');
});

test('pinned and active-speaker videos fill the low-profile 2-video budget in a 25-person room', () => {
  const plan = planFor(25, { pinnedId: 'p-20', speakerId: 'p-21' });
  assert.equal(plan.budget, 2);
  assert.equal(plan.submit.length, 2);
  assert.equal(plan.submit[0], 'p-20', 'pinned video is first');
  assert.equal(plan.submit[1], 'p-21', 'active speaker is selected next');
  assert.deepEqual(plan.evicted, ['p-0', 'p-1'], 'pinned + speaker displace the base page tiles');
});

test('a self pin/speaker does not consume a remote slot: both slots stay remote', () => {
  const pinnedSelf = planFor(25, { pinnedId: 'self', speakerId: 'p-11' });
  assert.equal(pinnedSelf.budget, 2);
  assert.equal(pinnedSelf.submit.length, 2);
  assert.deepEqual(pinnedSelf.submit, ['p-11', 'p-1'], 'speaker plus one extra remote video');

  const speakerSelf = planFor(25, { pinnedId: 'p-10', speakerId: 'self' });
  assert.equal(speakerSelf.budget, 2);
  assert.deepEqual(speakerSelf.submit, ['p-10', 'p-1'], 'pin plus one extra remote video');
});

test('promotion evicts the first ordinary page tile and keeps the budget', () => {
  const before = planFor(25);
  assert.ok(before.submit.includes('p-0'));
  const promoted = planFor(25, { promotedIds: ['p-20'] });
  assert.equal(promoted.budget, 2);
  assert.equal(promoted.submit.length, 2, 'the hard budget is respected');
  assert.ok(promoted.submit.includes('p-20'), 'the clicked tile gets a video');
  assert.ok(!promoted.submit.includes('p-0'), 'the first ordinary page tile is evicted');
  assert.deepEqual(promoted.evicted, ['p-0']);
  assert.deepEqual(promoted.submit, ['p-20', 'p-1']);
});

test('a promotion evicts the automatic speaker only when pinned + speaker fill the budget', () => {
  const promoted = planFor(25, { pinnedId: 'p-10', speakerId: 'p-11', promotedIds: ['p-20'] });
  assert.deepEqual(promoted.submit, ['p-10', 'p-20'], 'the pin stays, the clicked tile replaces the speaker');
  assert.deepEqual(promoted.evicted, ['p-0', 'p-1', 'p-11']);
});

test('the speaker is kept when an ordinary page tile can yield instead', () => {
  const promoted = planFor(25, { speakerId: 'p-11', promotedIds: ['p-20'] });
  assert.deepEqual(promoted.submit, ['p-11', 'p-20']);
  assert.deepEqual(promoted.evicted, ['p-0', 'p-1']);
});

test('multiple promotions grow newest-first and evict successive page tiles', () => {
  const promoted = planFor(25, { promotedIds: ['p-22', 'p-20'] });
  assert.deepEqual(promoted.submit, ['p-22', 'p-20']);
  assert.deepEqual(promoted.evicted, ['p-0', 'p-1']);
});

test('promotion respects a lower scale.maxVideoSubscriptions', () => {
  const promoted = planFor(25, { maxVideoSubscriptions: 1, promotedIds: ['p-20'] });
  assert.equal(promoted.budget, 1);
  assert.equal(promoted.maxSubscriptions, 1);
  assert.deepEqual(promoted.submit, ['p-20']);
  assert.deepEqual(promoted.evicted, ['p-0']);
});

test('a pin filling the only video slot cannot be displaced by a promotion', () => {
  const plan = planFor(25, { maxVideoSubscriptions: 1, pinnedId: 'p-10', promotedIds: ['p-20'] });
  assert.deepEqual(plan.submit, ['p-10']);
  assert.deepEqual(plan.evicted, ['p-0'], 'the pin itself displaces the base page tile');
});

test('a pin that is also in the promotion history is never evicted by a newer promotion', () => {
  const plan = planFor(25, {
    pinnedId: 'p-10',
    speakerId: 'p-11',
    promotedIds: ['p-10', 'p-20'],
  });
  assert.deepEqual(plan.submit, ['p-10', 'p-20'], 'the pin stays and the speaker yields');
  assert.ok(!plan.evicted.includes('p-10'), 'the pin is never in the eviction list');
});

test('a promotion for another page does not consume the current page budget', () => {
  const participants = remotes(60);
  const page0 = planVideoSubscriptions({
    participants,
    page: 0,
    pageSize: 36,
    hasSelf: true,
    promotedIds: ['p-40'],
    maxVideoSubscriptions: 36,
    capacityProfile: 'low',
  });
  assert.ok(!page0.submit.includes('p-40'), 'off-page promotion is inactive');
  assert.equal(page0.budget, 2);

  const page1 = planVideoSubscriptions({
    participants,
    page: 1,
    pageSize: 36,
    hasSelf: true,
    promotedIds: ['p-40'],
    maxVideoSubscriptions: 36,
    capacityProfile: 'low',
  });
  assert.equal(page1.submit[0], 'p-40', 'the promotion is restored on its own page');
  assert.equal(page1.submit.length, 2);
});

test('audio is never budgeted: every remote participant stays audible', () => {
  const plan = planFor(25);
  assert.equal(plan.audio.length, 24);
  assert.deepEqual(plan.audio, remotes(24).map((participant) => participant.id));
  for (const dropped of plan.dropped) {
    assert.ok(plan.audio.includes(dropped), `dropped video ${dropped} must keep audio`);
  }
  assert.ok(!plan.audio.includes('self'), 'the local self preview is not a remote audio track');
  // Video is the only budgeted set: 22 dropped videos, 24 audio entries.
  assert.equal(plan.submit.length + plan.dropped.length, plan.audio.length);
});

test('tenant config overrides are reflected in the initial gallery state', () => {
  const config = defaultConfig();
  (config.limits as { galleryVideoBudget?: number }).galleryVideoBudget = 3;
  const state = createInitialState(config, 'en');
  assert.equal(state.gallery.videoBudget, 3);
  assert.deepEqual(state.gallery.promotedVideoIds, []);
});
