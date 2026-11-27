/**
 * Routing contract: rule validation, deep-partial patches, priority selection
 * and secret-safe redaction. Pure protocol tests (no server).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTING_DEFAULTS,
  compareRoutingRules,
  edgeEnrollmentCreateRequestSchema,
  edgeJoinRequestSchema,
  expandRoutingTemplate,
  matchesRoutingSource,
  mergeRoutingRule,
  normalizeRoutingDestination,
  normalizeRoutingRule,
  routingDestinationSchema,
  routingRuleCreateSchema,
  routingRulePatchSchema,
  routingRuleSchema,
  routingRuleView,
  routingTestRequestSchema,
  routingUrlHost,
  selectRoutingRule,
  validateRoutingTemplate,
  type RoutingRule,
} from '../src/routing.js';

const RTMP = 'rtmp://live.example/app/super-secret-stream-key';
const SECRET_REF = 'AGIL_ROUTE_SECRET_ACME_MAIN';

function baseRule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: 'rt_main',
    tenantId: 'acme',
    name: 'Main route',
    enabled: true,
    priority: 100,
    source: { type: 'edge', edgeId: 'edge-1' },
    destinations: [
      { type: 'room', roomId: 'hall', role: 'host', publish: ['audio', 'video'] },
      { type: 'stream', provider: 'rtmp', url: RTMP, layout: 'grid', latency: 'standard' },
    ],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

test('rule create: validates a full edge→room+stream rule and applies defaults', () => {
  const parsed = routingRuleCreateSchema.safeParse({
    name: '  Broadcast hall  ',
    source: { type: 'edge', edgeId: 'edge-1' },
    destinations: [
      { type: 'room', roomId: 'hall' },
      { type: 'stream', provider: 'rtmp', url: RTMP },
      { type: 'stream', provider: 'hls' },
    ],
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
  if (!parsed.success) return;
  assert.equal(parsed.data.name, '  Broadcast hall  ', 'schema does not trim; server normalises');
  assert.equal(parsed.data.enabled, undefined, 'defaults are materialised by normalizeRoutingRule');
  const normalized = normalizeRoutingDestination(parsed.data.destinations[0]!);
  assert.equal(normalized.type, 'room');
  assert.equal(normalized.role, ROUTING_DEFAULTS.roomRole);
  assert.deepEqual(normalized.publish, ['audio', 'video']);
  const stream = normalizeRoutingDestination(parsed.data.destinations[1]!);
  assert.equal(stream.type, 'stream');
  assert.equal(stream.layout, 'grid');
  assert.equal(stream.latency, 'standard');
});

test('rule create: rejects invalid sources and destinations', () => {
  const invalid = [
    // room source without roomId
    { source: { type: 'room' }, destinations: [{ type: 'room', roomId: 'r' }] },
    // edge source with a roomId
    { source: { type: 'edge', roomId: 'r' }, destinations: [{ type: 'room', roomId: 'r' }] },
    // participant source without any selector
    { source: { type: 'participant' }, destinations: [{ type: 'room', roomId: 'r' }] },
    // room destination with both roomId and template
    {
      source: { type: 'room', roomId: 'r' },
      destinations: [{ type: 'room', roomId: 'r', template: 'x-{edgeId}' }],
    },
    // stream without provider
    { source: { type: 'room', roomId: 'r' }, destinations: [{ type: 'stream' }] },
    // rtmp without url/secretRef
    { source: { type: 'room', roomId: 'r' }, destinations: [{ type: 'stream', provider: 'rtmp' }] },
    // rtmp with both url and secretRef
    {
      source: { type: 'room', roomId: 'r' },
      destinations: [{ type: 'stream', provider: 'rtmp', url: RTMP, secretRef: SECRET_REF }],
    },
    // hls must not carry url/secretRef
    {
      source: { type: 'room', roomId: 'r' },
      destinations: [{ type: 'stream', provider: 'hls', url: 'https://cdn.example/live' }],
    },
    // secretRef outside the route namespace
    {
      source: { type: 'room', roomId: 'r' },
      destinations: [{ type: 'stream', provider: 'rtmp', secretRef: 'AGIL_WEBHOOK_SECRET' }],
    },
    // unknown top-level field
    {
      source: { type: 'room', roomId: 'r' },
      destinations: [{ type: 'room', roomId: 'r' }],
      sneaky: true,
    },
  ];
  for (const [index, body] of invalid.entries()) {
    const parsed = routingRuleCreateSchema.safeParse(body);
    assert.equal(parsed.success, false, `invalid rule #${index} was accepted: ${JSON.stringify(body)}`);
  }
});

test('destinations: secretRef namespace and template placeholders', () => {
  assert.equal(
    routingDestinationSchema.safeParse({ type: 'stream', provider: 'rtmp', secretRef: SECRET_REF }).success,
    true,
  );
  assert.equal(
    routingDestinationSchema.safeParse({ type: 'stream', provider: 'rtmp', secretRef: 'AGIL_INTEGRATION_X' }).success,
    false,
  );
  assert.equal(validateRoutingTemplate('edge-{edgeId}'), null);
  assert.equal(validateRoutingTemplate('{tenantId}-{tag}-{routeId}'), null);
  assert.equal(expandRoutingTemplate('edge-{edgeId}', { edgeId: 'cam1' }), 'edge-cam1');
  assert.match(String(validateRoutingTemplate('edge-{nope}')), /unknown template variable/);
  assert.match(String(validateRoutingTemplate('edge-{edgeId')), /unbalanced/);
  assert.match(String(validateRoutingTemplate('edge/$bad')), /may contain/);
});

test('PATCH: deep-partial merge keeps untouched fields, merges source and destinations by position', () => {
  const current = baseRule();
  const patch = routingRulePatchSchema.parse({
    priority: 5,
    name: null,
    source: { tag: 'hall-cam' },
    destinations: [
      { role: 'moderator' },
      { layout: 'speaker', latency: 'low' },
    ],
    recording: { enabled: true },
  });
  const merged = mergeRoutingRule(current, patch, 2000);
  assert.equal(merged.priority, 5);
  assert.equal(merged.name, undefined, 'null clears an optional field');
  assert.deepEqual(merged.source, { type: 'edge', edgeId: 'edge-1', tag: 'hall-cam' });
  assert.equal(merged.destinations.length, 2);
  assert.equal(merged.destinations[0]!.type, 'room');
  assert.equal(merged.destinations[0]!.role, 'moderator');
  assert.equal(merged.destinations[0]!.roomId, 'hall', 'positional merge keeps the untouched room');
  assert.equal(merged.destinations[1]!.type, 'stream');
  assert.equal(merged.destinations[1]!.layout, 'speaker');
  assert.equal(merged.destinations[1]!.latency, 'low');
  assert.equal(merged.destinations[1]!.url, RTMP, 'untouched url is kept internally');
  assert.deepEqual(merged.recording, { enabled: true, layout: 'grid', audioOnly: false });
  assert.equal(merged.updatedAt, 2000);
  assert.equal(merged.createdAt, 1000);
  assert.equal(merged.id, current.id);
  // The merged rule must still satisfy the full schema.
  assert.equal(routingRuleSchema.safeParse(merged).success, true);
});

test('PATCH: changing source type drops stale selectors; shorter destination list truncates', () => {
  const merged = mergeRoutingRule(
    baseRule(),
    routingRulePatchSchema.parse({ source: { type: 'room', roomId: 'hall' }, destinations: [{ type: 'room', roomId: 'hall' }] }),
    3000,
  );
  assert.deepEqual(merged.source, { type: 'room', roomId: 'hall' });
  assert.equal(merged.destinations.length, 1);
  assert.equal(merged.destinations[0]!.type, 'room');
  const parsed = routingRuleSchema.safeParse(merged);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
});

test('PATCH: switching an RTMP destination to HLS drops the credential fields', () => {
  const merged = mergeRoutingRule(
    baseRule(),
    routingRulePatchSchema.parse({ destinations: [{ type: 'room', roomId: 'hall' }, { type: 'stream', provider: 'hls' }] }),
    4000,
  );
  assert.equal(merged.destinations[1]!.provider, 'hls');
  assert.equal(merged.destinations[1]!.url, undefined);
  assert.equal(merged.destinations[1]!.secretRef, undefined);
  const parsed = routingRuleSchema.safeParse(merged);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
});

test('priority: lowest number wins; disabled and mismatching rules are skipped', () => {
  const rules = [
    baseRule({ id: 'rt_low', priority: 500 }),
    baseRule({ id: 'rt_high', priority: 10, enabled: false }),
    baseRule({ id: 'rt_mid', priority: 50 }),
  ];
  const selected = selectRoutingRule(rules, { type: 'edge', edgeId: 'edge-1' });
  assert.equal(selected?.id, 'rt_mid');
  const allDisabled = selectRoutingRule(
    rules.map((rule) => ({ ...rule, enabled: false })),
    { type: 'edge', edgeId: 'edge-1' },
  );
  assert.equal(allDisabled, null);
});

test('priority: wildcard edge rule matches any edge; tag selectors must match', () => {
  const wildcard = baseRule({ id: 'rt_any', priority: 100, source: { type: 'edge' } });
  assert.equal(matchesRoutingSource(wildcard.source, { type: 'edge', edgeId: 'edge-9' }), true);
  assert.equal(selectRoutingRule([wildcard], { type: 'edge', edgeId: 'edge-9' })?.id, 'rt_any');

  const tagged = baseRule({ id: 'rt_tag', priority: 10, source: { type: 'edge', tag: 'hall' } });
  assert.equal(selectRoutingRule([wildcard, tagged], { type: 'edge', edgeId: 'edge-9' })?.id, 'rt_any');
  assert.equal(selectRoutingRule([wildcard, tagged], { type: 'edge', edgeId: 'edge-9', tag: 'hall' })?.id, 'rt_tag');

  const roomRule = baseRule({ id: 'rt_room', source: { type: 'room', roomId: 'hall' } });
  assert.equal(matchesRoutingSource(roomRule.source, { type: 'room', roomId: 'hall' }), true);
  assert.equal(matchesRoutingSource(roomRule.source, { type: 'room', roomId: 'other' }), false);
  assert.equal(matchesRoutingSource(roomRule.source, { type: 'edge', roomId: 'hall' }), false);
});

test('priority: equal priorities fall back to createdAt then id', () => {
  const older = baseRule({ id: 'rt_b', priority: 10, createdAt: 100 });
  const newer = baseRule({ id: 'rt_a', priority: 10, createdAt: 200 });
  const sameTimeA = baseRule({ id: 'rt_a', priority: 10, createdAt: 100 });
  const sameTimeB = baseRule({ id: 'rt_b', priority: 10, createdAt: 100 });
  assert.ok(compareRoutingRules(older, newer) < 0);
  assert.ok(compareRoutingRules(sameTimeA, sameTimeB) < 0);
});

test('redaction: admin/Edge views never expose an RTMP URL, only its host', () => {
  const view = routingRuleView(baseRule());
  const stream = view.destinations.find((destination) => destination.type === 'stream');
  assert.ok(stream && stream.type === 'stream');
  assert.equal(stream.urlHost, 'rtmp://live.example/…');
  assert.equal(stream.hasSecret, true);
  assert.equal('url' in stream, false);
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('super-secret-stream-key'), 'stream key never appears in the view');

  assert.equal(routingUrlHost(RTMP), 'rtmp://live.example/…');
  assert.equal(routingUrlHost('rtmp://user:pass@live.example/app/key'), 'rtmp://live.example/…');
  assert.equal(routingUrlHost('not a url'), '…');
  assert.equal(routingUrlHost(undefined), '');
});

test('recording accepts boolean shorthand on create and patch', () => {
  const created = routingRuleCreateSchema.safeParse({
    source: { type: 'room', roomId: 'r' },
    destinations: [{ type: 'stream', provider: 'hls' }],
    recording: true,
  });
  assert.equal(created.success, true);
  if (created.success) assert.equal(created.data.recording, true);
  const normalized = normalizeRoutingRule(created.success ? created.data : ({} as never));
  assert.deepEqual(normalized.recording, { enabled: true, layout: 'grid', audioOnly: false });

  const merged = mergeRoutingRule(baseRule({ recording: { enabled: true, layout: 'grid', audioOnly: false } }), routingRulePatchSchema.parse({ recording: false }), 5000);
  assert.deepEqual(merged.recording, { enabled: false, layout: 'grid', audioOnly: false });
  const removed = mergeRoutingRule(baseRule({ recording: { enabled: true } }), routingRulePatchSchema.parse({ recording: null }), 6000);
  assert.equal(removed.recording, undefined);
});

test('edge enrollment / join / test request schemas', () => {
  assert.equal(edgeEnrollmentCreateRequestSchema.safeParse({ tag: 'hall', uses: 3, ttlSec: 600 }).success, true);
  assert.equal(edgeEnrollmentCreateRequestSchema.safeParse({ tag: 'UPPER' }).success, false);
  assert.equal(edgeJoinRequestSchema.safeParse({ token: 'x'.repeat(24), edgeId: 'cam-1' }).success, true);
  assert.equal(edgeJoinRequestSchema.safeParse({ token: 'short' }).success, false);
  assert.equal(routingTestRequestSchema.safeParse({ apply: false, roomId: 'hall' }).success, true);
  assert.equal(routingTestRequestSchema.safeParse({ arbitrary: true }).success, false);
});
