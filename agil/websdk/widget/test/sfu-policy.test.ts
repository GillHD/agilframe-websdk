/**
 * White-box SFU subscription policy checks with a fake LiveKit room.
 *
 * The gallery budget lives in the widget controller/plan, but the engine must
 * still apply it correctly: only the planned video ids are subscribed, audio is
 * never touched by the video policy, and leaving a page releases its videos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig } from '@agil/protocol';
import { SfuEngine, type SfuEngineCallbacks } from '../src/call/sfu-engine.js';
import { planVideoSubscriptions } from '../src/call/large-room.js';
import { preferredVideoCodecs, prepareVideoCodecPreferences } from '../src/call/encoding.js';

test('WebRTC capability hints prioritize hardware encode and decode over encode alone', async () => {
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  const config = defaultConfig({ tenantId: 'demo' });
  config.video.encoding = { ...config.video.encoding, strategy: 'prefer-hardware', preferredCodecs: ['av1', 'vp9', 'h264', 'vp8'] };
  const codecs = config.video.encoding.preferredCodecs.map((codec) => ({ mimeType: `video/${codec}` }));
  Object.defineProperty(globalThis, 'RTCRtpSender', { configurable: true, value: { getCapabilities: () => ({ codecs }) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaCapabilities: {
    encodingInfo: async ({ video }: MediaEncodingConfiguration) => ({ supported: true, powerEfficient: video?.contentType !== 'video/av1' }),
    decodingInfo: async ({ video }: MediaDecodingConfiguration) => ({ supported: true, powerEfficient: video?.contentType === 'video/h264' }),
  } } });
  try {
    assert.deepEqual(preferredVideoCodecs(config), ['av1', 'vp9', 'h264', 'vp8']);
    await prepareVideoCodecPreferences(config);
    assert.deepEqual(preferredVideoCodecs(config), ['h264', 'vp9', 'vp8', 'av1']);
    config.video.encoding.strategy = 'auto';
    assert.deepEqual(preferredVideoCodecs(config), ['av1', 'vp9', 'h264', 'vp8']);
    config.video.encoding.strategy = 'prefer-hardware';
    config.video.maxResolution = '360p';
    assert.deepEqual(preferredVideoCodecs(config), ['av1', 'vp9', 'h264', 'vp8']);
  } finally {
    for (const name of ['RTCRtpSender', 'navigator'] as const) {
      const original = originals[name];
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

class FakePublication {
  isSubscribed = false;
  isDesired = false;
  readyOnSubscribe = true;
  onRequest?: (desired: boolean) => void;
  isEnabled = false;
  isMuted = false;
  permissionStatus = 'allowed';
  track?: { mediaStreamTrack: MediaStreamTrack };
  dimensions: unknown = null;
  quality: unknown = null;
  readonly subscribedCalls: boolean[] = [];
  readonly enabledCalls: boolean[] = [];
  readonly qualityCalls: unknown[] = [];
  readonly dimensionCalls: unknown[] = [];
  constructor(
    readonly participantId: string,
    readonly source: string,
    readonly kind = 'video',
    readonly trackSid = '',
  ) {}
  setSubscribed(value: boolean): void {
    this.subscribedCalls.push(value);
    this.isDesired = value;
    this.isSubscribed = value && this.readyOnSubscribe;
    this.onRequest?.(value);
  }
  setEnabled(value: boolean): void {
    this.enabledCalls.push(value);
    this.isEnabled = value;
  }
  setVideoDimensions(value: unknown): void {
    this.dimensions = value;
    this.dimensionCalls.push(value);
  }
  setVideoQuality(value: unknown): void {
    this.quality = value;
    this.qualityCalls.push(value);
  }
}

class FakeParticipant {
  readonly videoTrackPublications = new Map<string, FakePublication>();
  readonly audioTrackPublications = new Map<string, FakePublication>();
  constructor(readonly identity: string) {}
  addVideo(sid: string, source: string): FakePublication {
    const publication = new FakePublication(this.identity, source, 'video', sid);
    this.videoTrackPublications.set(sid, publication);
    return publication;
  }
  getTrackPublication(source: string): FakePublication | undefined {
    return [...this.videoTrackPublications.values()].find((publication) => publication.source === source);
  }
  addAudio(sid: string): FakePublication {
    const publication = new FakePublication(this.identity, 'microphone', 'audio');
    this.audioTrackPublications.set(sid, publication);
    return publication;
  }
}

function makeEngine(overrides: Partial<SfuEngineCallbacks> = {}): { engine: SfuEngine; participants: Map<string, FakeParticipant> } {
  const config = defaultConfig({ tenantId: 'qa' });
  const engine = new SfuEngine({
    session: {
      mode: 'sfu',
      url: 'wss://sfu.invalid',
      token: 'token-value',
      room: 'qa__room',
      canPublish: true,
      expiresAt: Date.now() + 60_000,
    },
    selfId: 'self',
    config,
    callbacks: new Proxy(overrides, { get: (callbacks, key) => Reflect.get(callbacks, key) ?? (() => undefined) }) as SfuEngineCallbacks,
  });
  const participants = new Map<string, FakeParticipant>();
  (engine as unknown as { room: { remoteParticipants: Map<string, FakeParticipant> } }).room = {
    remoteParticipants: participants,
  };
  return { engine, participants };
}

test('SFU updates speaking indicators independently and follows only the leading remote speaker', () => {
  const changes: Array<[string, boolean]> = [];
  const followed: string[] = [];
  const { engine } = makeEngine({ onSpeaking: (id, active) => changes.push([id, active]),
    onActiveSpeaker: (id) => followed.push(id) });
  const handlers = new Map<string, (speakers: FakeParticipant[]) => void>();
  const room = { on(event: string, callback: (speakers: FakeParticipant[]) => void) {
    handlers.set(event, callback);
    return room;
  } };
  const livekit = { RoomEvent: new Proxy({}, { get: (_, key) => key }) };
  (engine as unknown as { wireRoom(room: unknown, livekit: unknown): void }).wireRoom(room, livekit);
  const emit = handlers.get('ActiveSpeakersChanged');
  assert.ok(emit);
  const self = new FakeParticipant('self');
  const first = new FakeParticipant('first');
  const second = new FakeParticipant('second');

  emit([self, first, second]);
  emit([self, first, second]);
  emit([second, first]);
  emit([first]);
  assert.deepEqual(changes, [['self', true], ['first', true], ['second', true], ['self', false], ['second', false]]);
  assert.deepEqual(followed, ['first', 'second', 'first']);
});

function addParticipants(participants: Map<string, FakeParticipant>, count: number): FakeParticipant[] {
  const list: FakeParticipant[] = [];
  for (let index = 0; index < count; index += 1) {
    const participant = new FakeParticipant(`p-${index}`);
    participant.addVideo(`cam-${index}`, 'camera');
    participant.addAudio(`mic-${index}`);
    participants.set(participant.identity, participant);
    list.push(participant);
  }
  return list;
}

function subscribedIds(participants: Map<string, FakeParticipant>): string[] {
  return [...participants.values()]
    .filter((participant) =>
      [...participant.videoTrackPublications.values()].some((publication) => publication.isSubscribed),
    )
    .map((participant) => participant.identity);
}

test('the gallery can only cache an allowed camera publication, excluding screen shares', () => {
  const { engine, participants } = makeEngine();
  Object.assign(engine, {
    connected: true,
    module: {
      Track: { Source: { Camera: 'camera', ScreenShare: 'screen_share' } },
      TrackPublication: { PermissionStatus: { Allowed: 'allowed' } },
    },
  });
  const [participant] = addParticipants(participants, 1);
  const camera = participant!.videoTrackPublications.get('cam-0')!;
  const track = {} as MediaStreamTrack;
  camera.track = { mediaStreamTrack: track };
  assert.deepEqual(engine.galleryCamera('p-0'), { publicationId: 'cam-0', track });
  camera.track = undefined;
  assert.deepEqual(engine.galleryCamera('p-0'), { publicationId: 'cam-0', track: undefined });
  camera.permissionStatus = 'not_allowed';
  assert.equal(engine.galleryCamera('p-0'), null);
  camera.permissionStatus = 'allowed';
  participant!.addVideo('screen', 'screen_share');
  assert.equal(engine.galleryCamera('p-0'), null);
  participant!.videoTrackPublications.delete('screen');
  camera.isMuted = true;
  assert.equal(engine.galleryCamera('p-0'), null);
});

test('page changes release even pending subscriptions before starting new requests', () => {
  const { engine, participants } = makeEngine();
  const people = addParticipants(participants, 4);
  const requests: string[] = [];
  const videos = people.map((participant, index) => participant.videoTrackPublications.get(`cam-${index}`)!);
  let peakSubscriptions = 0;
  for (const video of videos) {
    video.readyOnSubscribe = false;
    video.onRequest = (enabled) => {
      requests.push(`${video.participantId} ${enabled}`);
      peakSubscriptions = Math.max(peakSubscriptions, videos.filter((item) => item.isDesired).length);
    };
  }
  engine.setVideoSubscriptionPolicy({ visibleIds: ['p-2', 'p-3'], maxSubscriptions: 2 });
  engine.setVideoSubscriptionPolicy({ visibleIds: ['p-2', 'p-3'], maxSubscriptions: 2 });
  engine.setVideoSubscriptionPolicy({ visibleIds: ['p-0', 'p-1'], maxSubscriptions: 2 });
  assert.deepEqual(requests, ['p-2 true', 'p-3 true', 'p-2 false', 'p-3 false', 'p-0 true', 'p-1 true']);
  assert.equal(peakSubscriptions, 2);
});

test('a smaller room limit releases existing SFU subscriptions and caps later policies', () => {
  const { engine, participants } = makeEngine();
  const [first, second] = addParticipants(participants, 2);
  const firstCamera = first!.videoTrackPublications.get('cam-0')!;
  const secondCamera = second!.videoTrackPublications.get('cam-1')!;
  engine.setVideoSubscriptionPolicy({ visibleIds: ['p-0', 'p-1'], maxSubscriptions: 2 });
  assert.equal(firstCamera.isDesired && secondCamera.isDesired, true);

  const config = defaultConfig();
  config.limits.maxVideoSubscriptions = 1;
  engine.setConfig(config);
  assert.equal(firstCamera.isDesired, true);
  assert.equal(secondCamera.isDesired, false);
  engine.setVideoSubscriptionPolicy({ visibleIds: ['p-1', 'p-0'], maxSubscriptions: 2 });
  assert.equal(firstCamera.isDesired, false);
  assert.equal(secondCamera.isDesired, true);
});

test('large gallery paces camera requests, drops obsolete work and applies explicit priorities immediately', async () => {
  const { engine, participants } = makeEngine();
  const people = addParticipants(participants, 6);
  const screen = people[4]!.addVideo('screen-4', 'screen_share');
  const pending = people[2]!.videoTrackPublications.get('cam-2')!;
  try {
    engine.setVideoSubscriptionPolicy({ visibleIds: ['p-0', 'p-1', 'p-2'], maxSubscriptions: 3, pace: true });
    assert.deepEqual(subscribedIds(participants), ['p-0']);
    await delay(170);
    assert.deepEqual(subscribedIds(participants), ['p-0', 'p-1']);
    engine.setVideoSubscriptionPolicy({
      visibleIds: ['p-3', 'p-4', 'p-5'], maxSubscriptions: 3, pace: true, immediateVideoIds: ['p-5'],
    });
    assert.deepEqual(subscribedIds(participants), ['p-4', 'p-5']);
    assert.equal(screen.isDesired, true);
    await delay(170);
    assert.deepEqual(subscribedIds(participants), ['p-3', 'p-4', 'p-5']);
    assert.deepEqual(pending.subscribedCalls, []);
    engine.setVideoSubscriptionPolicy({ visibleIds: ['p-0'], maxSubscriptions: 1, pace: true });
  } finally {
    engine.dispose();
  }
  await delay(170);
  assert.deepEqual(people[0]!.videoTrackPublications.get('cam-0')?.subscribedCalls, [true, false]);
});

test('manual quality requests LiveKit layers only for subscribed videos and auto restores adaptive dimensions', () => {
  const { engine, participants } = makeEngine();
  const [visible, offPage] = addParticipants(participants, 2);
  const camera = visible!.videoTrackPublications.get('cam-0')!;
  const microphone = visible!.audioTrackPublications.get('mic-0')!;
  const offPageCamera = offPage!.videoTrackPublications.get('cam-1')!;
  (engine as unknown as { module: { VideoQuality: Record<string, number> } }).module = {
    VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 },
  };
  engine.setVideoSubscriptionPolicy({ visibleIds: ['p-0'], maxSubscriptions: 1 });
  for (const [preference, requestedLayer] of [['low', 0], ['medium', 1], ['high', 2]] as const) {
    engine.setVideoQuality(preference);
    assert.equal(camera.quality, requestedLayer);
  }
  camera.dimensions = null;
  engine.setVideoQuality('auto');
  assert.deepEqual(camera.dimensions, { width: 480, height: 270 });
  engine.setVideoSubscriptionPolicy({
    visibleIds: ['p-0'], maxSubscriptions: 1, tileDimensions: new Map([['p-0', { width: 190, height: 107 }]]),
  });
  assert.deepEqual(camera.dimensions, { width: 190, height: 107 });
  engine.setVideoQuality('high');
  assert.equal(camera.quality, 2);
  engine.setVideoQuality('auto');
  assert.deepEqual(camera.dimensions, { width: 190, height: 107 });
  assert.equal(microphone.quality, null);
  assert.equal(offPageCamera.quality, null);
});

/**
 * A02 regression: manual "high" is a standing request. LiveKit only forwards the
 * high simulcast layer after its layer lock succeeds, and the SFU retries that
 * lock for a while (measured 0.6-13 s on a loaded host). If a room/policy update
 * re-applied the automatic tile dimensions instead, the SFU could sit on a low
 * layer even though the user picked high. The engine must keep re-asserting the
 * manual layer on every subscription/quality update.
 */
test('manual high keeps being requested across later room and policy updates', () => {
  const { engine, participants } = makeEngine();
  const [visible] = addParticipants(participants, 1);
  const camera = visible!.videoTrackPublications.get('cam-0')!;
  (engine as unknown as { module: { VideoQuality: Record<string, number> } }).module = {
    VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 },
  };
  engine.setVideoSubscriptionPolicy({
    visibleIds: ['p-0'], maxSubscriptions: 1, tileDimensions: new Map([['p-0', { width: 320, height: 180 }]]),
  });
  assert.deepEqual(camera.dimensions, { width: 320, height: 180 }, 'auto mode starts from the tile size');
  engine.setVideoQuality('high');
  assert.deepEqual(camera.qualityCalls, [2]);
  // A later policy/room update (gallery resize, pin, page change) re-applies the
  // subscription; it must keep asking for the high layer, not restore auto dims.
  engine.setVideoSubscriptionPolicy({
    visibleIds: ['p-0'], maxSubscriptions: 1, tileDimensions: new Map([['p-0', { width: 190, height: 107 }]]),
  });
  assert.deepEqual(camera.qualityCalls, [2, 2]);
  assert.deepEqual(camera.dimensionCalls, [{ width: 320, height: 180 }], 'high never falls back to tile dimensions');
  // Returning to auto restores explicit dimensions.
  engine.setVideoQuality('auto');
  assert.deepEqual(camera.dimensions, { width: 190, height: 107 });
  assert.equal(engine.quality, 'auto');
});

test('weak SFU links cap the remote layer and restore the manual preference after recovery', async () => {
  const { engine, participants } = makeEngine();
  const [visible] = addParticipants(participants, 1);
  const camera = visible!.videoTrackPublications.get('cam-0')!;
  const fakeLocal = { connectionQuality: 'good', trackPublications: new Map() };
  Object.assign(visible!, { trackPublications: new Map() });
  Object.assign(engine, {
    connected: true, connectionState: 'connected',
    room: { remoteParticipants: participants, localParticipant: fakeLocal },
    module: { VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 } },
  });
  const config = defaultConfig({ tenantId: 'qa' });
  config.fallback.lowBandwidth.enabled = true;
  engine.setConfig(config);
  engine.setVideoSubscriptionPolicy({ visibleIds: ['p-0'], maxSubscriptions: 1 });
  engine.setVideoQuality('high');
  assert.equal(camera.quality, 2);
  const sample = () => (engine as unknown as { sampleStats(emit: boolean): Promise<unknown> }).sampleStats(true);
  fakeLocal.connectionQuality = 'poor';
  await sample();
  assert.deepEqual(camera.dimensions, { width: 320, height: 180 });
  fakeLocal.connectionQuality = 'lost';
  await sample();
  assert.equal(camera.quality, 0);
  fakeLocal.connectionQuality = 'good';
  await sample();
  await sample();
  assert.equal(engine.quality, 'high');
  assert.equal(camera.quality, 2);
});

test('the 25-person standard plan subscribes 6 videos and leaves every audio publication alone', () => {
  const { engine, participants } = makeEngine();
  addParticipants(participants, 24);
  const plan = planVideoSubscriptions({
    participants: [...participants.keys()].map((id) => ({ id })),
    page: 0,
    pageSize: 36,
    hasSelf: true,
    maxVideoSubscriptions: 36,
  });
  assert.equal(plan.budget, 6, 'default standard capacity profile');
  assert.equal(plan.submit.length, 6);
  engine.setVideoSubscriptionPolicy({ visibleIds: plan.submit, maxSubscriptions: plan.maxSubscriptions });

  assert.deepEqual(subscribedIds(participants).sort(), plan.submit.slice().sort());
  assert.equal(engine.subscriptionStats.desiredVideo, 6);
  for (const participant of participants.values()) {
    for (const publication of participant.audioTrackPublications.values()) {
      assert.deepEqual(publication.subscribedCalls, [], 'the video policy never changes audio');
      assert.deepEqual(publication.enabledCalls, []);
    }
  }
});

test('the low pilot profile still subscribes 2 videos in a 25-person room', () => {
  const { engine, participants } = makeEngine();
  addParticipants(participants, 24);
  const plan = planVideoSubscriptions({
    participants: [...participants.keys()].map((id) => ({ id })),
    page: 0,
    pageSize: 36,
    hasSelf: true,
    maxVideoSubscriptions: 36,
    capacityProfile: 'low',
  });
  assert.equal(plan.budget, 2);
  assert.equal(plan.submit.length, 2);
  engine.setVideoSubscriptionPolicy({ visibleIds: plan.submit, maxSubscriptions: plan.maxSubscriptions });
  assert.deepEqual(subscribedIds(participants).sort(), plan.submit.slice().sort());
  assert.equal(engine.subscriptionStats.desiredVideo, 2);
});

test('the audio helper subscribes all participants even when their video was budgeted out', () => {
  const { engine, participants } = makeEngine();
  addParticipants(participants, 24);
  const plan = planVideoSubscriptions({
    participants: [...participants.keys()].map((id) => ({ id })),
    page: 0,
    pageSize: 36,
    hasSelf: true,
    maxVideoSubscriptions: 36,
  });
  engine.setVideoSubscriptionPolicy({ visibleIds: plan.submit, maxSubscriptions: plan.maxSubscriptions });
  // The engine calls this private helper for every participant on connect and
  // for late audio publications; it must ignore the (much smaller) video set.
  const helper = (engine as unknown as { subscribeParticipantAudio: (p: FakeParticipant) => void })
    .subscribeParticipantAudio;
  for (const participant of participants.values()) helper.call(engine, participant);
  for (const participant of participants.values()) {
    for (const publication of participant.audioTrackPublications.values()) {
      assert.equal(publication.isSubscribed, true, `audio subscribed for ${participant.identity}`);
      assert.equal(publication.isEnabled, true);
    }
  }
  assert.ok(plan.dropped.length > 0);
});

test('changing page releases the old page videos', () => {
  const { engine, participants } = makeEngine();
  addParticipants(participants, 60);
  const page0 = planVideoSubscriptions({
    participants: [...participants.keys()].map((id) => ({ id })),
    page: 0,
    pageSize: 36,
    hasSelf: true,
    maxVideoSubscriptions: 36,
  });
  const page1 = planVideoSubscriptions({
    participants: [...participants.keys()].map((id) => ({ id })),
    page: 1,
    pageSize: 36,
    hasSelf: true,
    maxVideoSubscriptions: 36,
  });
  engine.setVideoSubscriptionPolicy({ visibleIds: page0.submit, maxSubscriptions: page0.maxSubscriptions });
  assert.equal(subscribedIds(participants).length, 6);
  engine.setVideoSubscriptionPolicy({ visibleIds: page1.submit, maxSubscriptions: page1.maxSubscriptions });
  assert.deepEqual(subscribedIds(participants).sort(), page1.submit.slice().sort());
  const oldVideo = participants.get(page0.submit[0])?.videoTrackPublications.values().next().value as
    | FakePublication
    | undefined;
  assert.equal(oldVideo?.isSubscribed, false, 'the previous page video is released');
  assert.equal(oldVideo?.isEnabled, false);
});

test('screen share wins over the camera and still counts as one video subscription', () => {
  const { engine, participants } = makeEngine();
  addParticipants(participants, 10);
  const shared = participants.get('p-3');
  assert.ok(shared);
  const screen = shared.addVideo('screen-3', 'screen_share');
  engine.setVideoSubscriptionPolicy({ visibleIds: ['p-3'], maxSubscriptions: 4 });
  assert.deepEqual(subscribedIds(participants), ['p-3']);
  assert.equal(screen.isSubscribed, true);
  assert.equal(shared.videoTrackPublications.get('cam-3')?.isSubscribed, false);
  assert.equal(engine.subscriptionStats.videoSubscribed, 1);
});
