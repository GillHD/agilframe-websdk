/**
 * Stage-1 large-room maths: pagination for 200 participants and the video
 * subscription budget. Pure functions — no DOM, no LiveKit, no timers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '@agil/protocol';
import {
  clampGalleryPage,
  clampVideoSubscriptions,
  formatParticipantCount,
  galleryPageCount,
  galleryPageInfo,
  LARGE_ROOM_MAX_PARTICIPANTS,
  normalizeVideoQuality,
  pageForParticipantId,
  pageParticipants,
  participantPageIndex,
  planVideoSubscriptions,
  resolvePageSize,
  videoQualityDimensions,
} from '../src/call/large-room.js';
import { createInitialState } from '../src/state.js';

const participants = Array.from({ length: LARGE_ROOM_MAX_PARTICIPANTS }, (_, index) => ({ id: `p-${index}` }));

test('scrolling plans video only for visible participants while keeping room-wide audio', () => {
  const plan = planVideoSubscriptions({
    participants,
    page: 0,
    pageSize: 36,
    hasSelf: true,
    viewportIds: ['p-50', 'p-51', 'p-52', 'p-53'],
    pinnedId: 'p-20',
    speakerId: 'p-51',
    promotedIds: ['p-70', 'p-53'],
    maxVideoSubscriptions: 2,
  });
  assert.deepEqual(new Set(plan.visible), new Set(['p-50', 'p-51', 'p-52', 'p-53']));
  assert.deepEqual(new Set(plan.submit), new Set(['p-51', 'p-53']));
  assert.equal(plan.audio.length, participants.length);
});

test('page size is 25 on phones and 36 on desktop', () => {
  assert.equal(resolvePageSize(390), 25);
  assert.equal(resolvePageSize(640), 25);
  assert.equal(resolvePageSize(641), 36);
  assert.equal(resolvePageSize(1920), 36);
});

test('200 participants with self fit into 6 desktop pages and 9 phone pages', () => {
  const desktop = galleryPageInfo(200, true, 36, 0);
  assert.equal(desktop.pageSize, 36);
  assert.equal(desktop.remotePageSize, 35, 'self occupies one of the 36 tile slots');
  assert.equal(desktop.pageCount, 6);
  assert.deepEqual([desktop.start, desktop.end], [0, 35]);
  assert.equal(galleryPageCount(200, true, 36), 6);

  const last = galleryPageInfo(200, true, 36, 99);
  assert.equal(last.page, 5, 'page is clamped');
  assert.deepEqual([last.start, last.end], [175, 200]);
  assert.equal(pageParticipants(participants, last).length, 25);

  const phone = galleryPageInfo(200, true, 25, 0);
  assert.equal(phone.remotePageSize, 24);
  assert.equal(phone.pageCount, 9);
  assert.equal(galleryPageCount(200, true, 25), 9);
});

test('an empty or small room never yields zero pages', () => {
  assert.equal(galleryPageCount(0, true, 36), 1);
  assert.equal(galleryPageCount(1, true, 36), 1);
  assert.equal(clampGalleryPage(-3, 1), 0);
  assert.equal(clampGalleryPage(7, 3), 2);
});

test('participant index maps to the page that contains it', () => {
  assert.equal(participantPageIndex(0, true, 36), 0);
  assert.equal(participantPageIndex(34, true, 36), 0);
  assert.equal(participantPageIndex(35, true, 36), 1);
  assert.equal(participantPageIndex(69, true, 36), 1);
  assert.equal(participantPageIndex(70, true, 36), 2);
  assert.equal(pageForParticipantId(participants, 'p-199', true, 36), 5);
  assert.equal(pageForParticipantId(participants, 'missing', true, 36), null);
});

test('UI badge switches to 200+ at the stage-1 limit', () => {
  assert.equal(formatParticipantCount(0), '0');
  assert.equal(formatParticipantCount(199), '199');
  assert.equal(formatParticipantCount(200), '200+');
  assert.equal(formatParticipantCount(250), '200+');
});

test('video plan never exceeds the profile budget and protects pin/speaker', () => {
  const plan = planVideoSubscriptions({
    participants,
    page: 5,
    pageSize: 36,
    hasSelf: true,
    pinnedId: 'p-0',
    speakerId: 'p-100',
    maxVideoSubscriptions: 36,
  });
  assert.equal(plan.page.pageCount, 6);
  assert.equal(plan.budget, 6, 'default standard profile: 6 remote videos above 8 participants');
  assert.ok(plan.submit.includes('p-0'), 'pinned off-page participant is subscribed');
  assert.ok(plan.submit.includes('p-100'), 'active speaker is subscribed');
  assert.equal(plan.submit.length, 6, 'pinned + speaker + four page tiles');
  assert.ok(plan.submit.every((id) => id.startsWith('p-')));
  assert.equal(plan.dropped.length, 200 - plan.submit.length);

  const low = planVideoSubscriptions({
    participants,
    page: 5,
    pageSize: 36,
    hasSelf: true,
    pinnedId: 'p-0',
    speakerId: 'p-100',
    maxVideoSubscriptions: 36,
    capacityProfile: 'low',
  });
  assert.equal(low.budget, 2, 'the current pilot profile keeps the 2-video active-speaker budget');
  assert.equal(low.submit.length, 2, 'pinned + active speaker');

  const tight = planVideoSubscriptions({
    participants,
    page: 0,
    pageSize: 36,
    hasSelf: true,
    pinnedId: 'p-0',
    speakerId: 'p-100',
    maxVideoSubscriptions: 1,
  });
  assert.equal(tight.budget, 1, 'scale.maxVideoSubscriptions can only lower the budget');
  assert.equal(tight.submit.length, 1);
  assert.ok(tight.submit.includes('p-0'), 'the pin is selected first when the cap is 1');
  assert.ok(!tight.submit.includes('p-100'), 'the speaker cannot exceed the cap');
  assert.equal(tight.maxSubscriptions, 1);
});

test('a full page with an off-page pin keeps the pin in the video budget', () => {
  const plan = planVideoSubscriptions({
    participants,
    page: 0,
    pageSize: 36,
    hasSelf: true,
    pinnedId: 'p-100',
    maxVideoSubscriptions: 36,
  });
  assert.equal(plan.visible.length, 35, 'pager renders 35 remote tiles + self');
  assert.equal(plan.submit.length, 6, 'the standard-profile budget, not all 35 rendered tiles');
  assert.deepEqual(plan.submit, ['p-100', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5']);
  assert.ok(!plan.submit.includes('p-0'), 'the off-page pin evicts the first ordinary page tile');
  assert.equal(plan.visible.at(-1), 'p-33');
  assert.equal(plan.dropped.length, 200 - plan.submit.length);

  const phone = planVideoSubscriptions({
    participants,
    page: 0,
    pageSize: 25,
    hasSelf: true,
    pinnedId: 'p-100',
    maxVideoSubscriptions: 36,
  });
  assert.equal(phone.visible.length, 24, 'phone page has 24 remote slots');
  assert.equal(phone.submit.length, 6);
  assert.ok(!phone.submit.includes('p-23'));
});

test('an override budget never subscribes a page tile displaced by an off-page pin', () => {
  const plan = planVideoSubscriptions({
    participants,
    page: 0,
    pageSize: 36,
    hasSelf: true,
    pinnedId: 'p-100',
    maxVideoSubscriptions: 36,
    galleryVideoBudget: 36,
  });
  assert.equal(plan.budget, 36);
  assert.equal(plan.visible.length, 35);
  assert.equal(plan.submit.length, 35, '34 rendered page tiles + the pinned tile');
  assert.ok(plan.submit.includes('p-100'));
  assert.ok(!plan.submit.includes('p-34'), 'the displaced last page tile is not rendered and not subscribed');
  assert.equal(plan.visible.at(-1), 'p-33');
});

test('a small page subscribes every visible remote video, a large page only its budget', () => {
  const small = participants.slice(0, 7);
  const smallPlan = planVideoSubscriptions({
    participants: small,
    page: 0,
    pageSize: 36,
    hasSelf: true,
    maxVideoSubscriptions: 36,
  });
  assert.deepEqual(smallPlan.visible, small.map((participant) => participant.id));
  assert.equal(smallPlan.budget, 8, '8 participants total (7 remotes + self) → all visible videos');
  assert.deepEqual(smallPlan.submit, smallPlan.visible, 'self is not a remote subscription');

  const largePlan = planVideoSubscriptions({
    participants,
    page: 0,
    pageSize: 36,
    hasSelf: true,
    maxVideoSubscriptions: 36,
  });
  assert.deepEqual(largePlan.visible, participants.slice(0, 35).map((participant) => participant.id));
  assert.deepEqual(largePlan.submit, ['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5']);
  assert.equal(largePlan.budget, 6, 'the default standard profile above 8 participants');
});

test('quality helper values and clamping', () => {
  assert.equal(clampVideoSubscriptions(undefined), 36);
  assert.equal(clampVideoSubscriptions(0), 1);
  assert.equal(clampVideoSubscriptions(5000), 1000);
  assert.equal(normalizeVideoQuality('high'), 'high');
  assert.equal(normalizeVideoQuality('nope'), 'auto');
  assert.deepEqual(videoQualityDimensions('low'), { width: 320, height: 180 });
  assert.deepEqual(videoQualityDimensions('medium'), { width: 640, height: 360 });
  assert.deepEqual(videoQualityDimensions('high'), { width: 1280, height: 720 });
  assert.deepEqual(videoQualityDimensions('auto', 'grid'), { width: 480, height: 270 });
  assert.deepEqual(videoQualityDimensions('auto', 'spotlight'), { width: 1280, height: 720 });
});

test('initial state carries large-room defaults', () => {
  const config = defaultConfig();
  assert.equal(config.scale.maxParticipants, 200);
  assert.equal(config.scale.maxVideoSubscriptions, 36);
  assert.equal(config.scale.sfu.capacityProfile, 'standard');
  const state = createInitialState(config, 'ru');
  assert.equal(state.gallery.followSpeaker, true);
  assert.equal(state.gallery.maxVideoSubscriptions, 36);
  assert.equal(state.gallery.videoBudget, 6, 'the standard profile maps the configured 200-seat cap to 6 videos');
  assert.deepEqual(state.gallery.promotedVideoIds, []);
  assert.equal(state.gallery.page, 0);
  assert.equal(state.settings.videoQuality, 'auto');
});
