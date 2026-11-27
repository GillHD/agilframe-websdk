/**
 * Flow contract (`docs/flows.md`): source/sink/processor validation, the adapter
 * capability plan, branching/fan-in shapes, priority/fallback selection, patch
 * semantics, schedule arithmetic and secret-safe views. Pure protocol tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOW_DEFAULTS,
  FLOW_LIMITATIONS,
  FLOW_MAX_FALLBACK_DEPTH,
  FLOW_ROOM_FORWARD_REASON,
  compareFlows,
  flowCreateSchema,
  flowFallbackChain,
  flowMatchesTrigger,
  flowPatchSchema,
  flowSchema,
  flowSinkView,
  flowSourceView,
  flowView,
  isFlowScheduleDue,
  mergeFlow,
  nextFlowRunAt,
  nextFlowScheduleAt,
  normalizeFlow,
  planFlowExecution,
  selectFlow,
  validateFlowFallback,
  type Flow,
  type FlowCreate,
} from '../src/flows.js';

const RTMP = 'rtmp://live.example/app/super-secret-stream-key';
const SRT = 'srt://srt.example:9000?streamid=secret-stream-id';
const SECRET_REF = 'AGIL_ROUTE_SECRET_ACME_MAIN';

function createInput(overrides: Partial<FlowCreate> = {}): FlowCreate {
  return {
    name: 'Hall broadcast',
    enabled: true,
    priority: 20,
    sources: [{ kind: 'room', roomId: 'hall' }],
    processors: [{ kind: 'layout', layout: 'speaker' }, { kind: 'audio_mix' }],
    sinks: [
      { kind: 'rtmp', url: RTMP, layout: 'grid' },
      { kind: 'hls', layout: 'speaker' },
      { kind: 'recording', layout: 'grid', audioOnly: false },
      { kind: 'webhook', url: 'https://hooks.example/agil', events: ['started', 'failed'] },
    ],
    triggers: [{ kind: 'manual' }, { kind: 'room_start' }],
    ...overrides,
  };
}

function storedFlow(overrides: Partial<Flow> = {}): Flow {
  const normalized = normalizeFlow(createInput());
  return {
    ...normalized,
    id: 'fl_main',
    tenantId: 'acme',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

test('create: branching room → rtmp + hls + recording + webhook with processors/triggers', () => {
  const parsed = flowCreateSchema.safeParse(createInput());
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
  if (!parsed.success) return;
  const normalized = normalizeFlow(parsed.data);
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.priority, 20);
  const recording = normalized.sinks.find((sink) => sink.kind === 'recording');
  assert.deepEqual(recording, {
    kind: 'recording',
    layout: 'grid',
    audioOnly: false,
    format: FLOW_DEFAULTS.recordingFormat,
  });
  const webhook = normalized.sinks.find((sink) => sink.kind === 'webhook');
  assert.deepEqual(webhook?.events, ['started', 'failed']);
  const rtmp = normalized.sinks.find((sink) => sink.kind === 'rtmp');
  assert.equal(rtmp?.layout, 'grid', 'a sink layout is kept');
  assert.equal(rtmp?.latency, FLOW_DEFAULTS.latency, 'latency defaults');
  const hls = normalized.sinks.find((sink) => sink.kind === 'hls');
  assert.equal(hls?.layout, 'speaker');
  // Defaults are materialised before storage; the schema itself does not add them.
  assert.deepEqual(normalizeFlow({ ...parse(createInput()), sinks: [{ kind: 'room', roomId: 'hall' }] }).sinks[0], {
    kind: 'room',
    roomId: 'hall',
    role: FLOW_DEFAULTS.role,
    publish: [...FLOW_DEFAULTS.publish],
  });
});

function parse(input: FlowCreate): FlowCreate {
  const parsed = flowCreateSchema.safeParse(input);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
  return parsed.success ? parsed.data : input;
}

test('create: adapter shapes and invalid combinations are rejected', () => {
  const invalid: Array<{ label: string; body: Record<string, unknown> }> = [
    // no room target: a media sink without any room-bound source/sink
    {
      label: 'file source to hls',
      body: { sources: [{ kind: 'file', assetId: 'asset-1' }], sinks: [{ kind: 'hls' }] },
    },
    // room_start without a room/participant source
    {
      label: 'room_start mismatch',
      body: {
        sources: [{ kind: 'edge', edgeId: 'cam-1' }],
        sinks: [{ kind: 'room', roomId: 'hall' }],
        triggers: [{ kind: 'room_start' }],
      },
    },
    // edge_online without an edge source
    {
      label: 'edge_online mismatch',
      body: {
        sources: [{ kind: 'room', roomId: 'hall' }],
        sinks: [{ kind: 'room', roomId: 'hall' }],
        triggers: [{ kind: 'edge_online' }],
      },
    },
    // schedule without a room-bound source
    {
      label: 'schedule without room source',
      body: {
        sources: [{ kind: 'file', assetId: 'asset-1' }],
        sinks: [{ kind: 'room', roomId: 'hall' }],
        triggers: [{ kind: 'schedule', everySec: 60 }],
      },
    },
    // schedule with both everySec and at
    {
      label: 'schedule both',
      body: {
        sources: [{ kind: 'room', roomId: 'hall' }],
        sinks: [{ kind: 'room', roomId: 'hall' }],
        triggers: [{ kind: 'schedule', everySec: 60, at: 1000 }],
      },
    },
    // duplicate triggers
    {
      label: 'duplicate triggers',
      body: {
        sources: [{ kind: 'room', roomId: 'hall' }],
        sinks: [{ kind: 'room', roomId: 'hall' }],
        triggers: [{ kind: 'manual' }, { kind: 'manual' }],
      },
    },
    // two layout processors
    {
      label: 'two layouts',
      body: {
        sources: [{ kind: 'room', roomId: 'hall' }],
        processors: [{ kind: 'layout', layout: 'grid' }, { kind: 'layout', layout: 'speaker' }],
        sinks: [{ kind: 'hls' }],
      },
    },
    // transcode without a profile
    {
      label: 'transcode profile',
      body: {
        sources: [{ kind: 'room', roomId: 'hall' }],
        processors: [{ kind: 'transcode' }],
        sinks: [{ kind: 'hls' }],
      },
    },
    // srt sink without url
    {
      label: 'srt without url',
      body: { sources: [{ kind: 'room', roomId: 'hall' }], sinks: [{ kind: 'srt' }] },
    },
    // webhook without url
    {
      label: 'webhook without url',
      body: { sources: [{ kind: 'room', roomId: 'hall' }], sinks: [{ kind: 'webhook' }] },
    },
    // secretRef outside the route namespace
    {
      label: 'secret namespace',
      body: {
        sources: [{ kind: 'room', roomId: 'hall' }],
        sinks: [{ kind: 'rtmp', secretRef: 'AGIL_WEBHOOK_SECRET' }],
      },
    },
    // ingest source with both url and secretRef
    {
      label: 'ingest both credentials',
      body: {
        sources: [{ kind: 'rtmp_ingest', url: 'rtmp://ingest.example/live/key', secretRef: SECRET_REF }],
        sinks: [{ kind: 'room', roomId: 'hall' }],
      },
    },
    // room sink with both roomId and template
    {
      label: 'room sink xor',
      body: {
        sources: [{ kind: 'room', roomId: 'hall' }],
        sinks: [{ kind: 'room', roomId: 'hall', template: 'room-{flowId}' }],
      },
    },
    // unknown field
    {
      label: 'unknown field',
      body: { sources: [{ kind: 'room', roomId: 'hall' }], sinks: [{ kind: 'hls' }], sneaky: true },
    },
  ];
  for (const entry of invalid) {
    const parsed = flowCreateSchema.safeParse(entry.body);
    assert.equal(parsed.success, false, `${entry.label} was accepted`);
  }
  // Every currently supported secretRef is accepted.
  assert.equal(
    flowCreateSchema.safeParse({
      sources: [{ kind: 'room', roomId: 'hall' }],
      sinks: [{ kind: 'rtmp', secretRef: SECRET_REF }],
    }).success,
    true,
  );
});

test('plan: branching is executable; pending adapters are reported, never hidden', () => {
  const supported = planFlowExecution(storedFlow());
  assert.equal(supported.executable, true);
  assert.deepEqual(supported.pending, []);
  assert.deepEqual(supported.executableSinkIndexes, [0, 1, 2, 3]);
  assert.deepEqual(supported.webhookSinkIndexes, [3]);
  assert.equal(supported.layout, 'speaker');
  assert.equal(supported.audioMix, true);
  assert.deepEqual(supported.transcodeProfiles, []);

  const pendingFlow = storedFlow({
    sources: [
      { kind: 'room', roomId: 'hall' },
      { kind: 'srt_ingest', url: SRT },
      { kind: 'sip', roomId: 'hall' },
    ],
    sinks: [
      { kind: 'rtmp', url: RTMP },
      { kind: 'srt', url: SRT },
      { kind: 'cdn', provider: 's3', bucket: 'videos' },
      { kind: 'room', roomId: 'hall' },
      { kind: 'room', roomId: 'second-hall' },
    ],
    processors: [{ kind: 'layout', layout: 'grid' }, { kind: 'transcode', profile: 'h264_720p30' }],
  });
  const pending = planFlowExecution(pendingFlow);
  assert.equal(pending.executable, false, 'a pending source/processor blocks execution');
  const kinds = pending.pending.map((entry) => entry.kind);
  assert.deepEqual(
    kinds.sort(),
    ['cdn', 'room', 'sip', 'srt', 'srt_ingest', 'transcode'].sort(),
  );
  assert.ok(pending.pending.some((entry) => entry.kind === 'room' && entry.reason === FLOW_ROOM_FORWARD_REASON));
  // A pending sink alone does not block the supported branch.
  const branch = storedFlow({
    sinks: [
      { kind: 'rtmp', url: RTMP },
      { kind: 'srt', url: SRT },
      { kind: 'recording', format: 'webm' },
    ],
  });
  const branchPlan = planFlowExecution(branch);
  assert.equal(branchPlan.executable, true, 'a pending branch does not block the executable branch');
  assert.deepEqual(branchPlan.executableSinkIndexes, [0]);
  assert.equal(branchPlan.sinks[1]?.state, 'pending');
  assert.equal(branchPlan.sinks[2]?.state, 'pending');
});

test('selection: priority, disabled flows, trigger-aware matching and shadowing inputs', () => {
  const roomSource = { kind: 'room' as const, roomId: 'hall' };
  const high = storedFlow({ id: 'fl_high', priority: 10, sources: [roomSource] });
  const mid = storedFlow({ id: 'fl_mid', priority: 50, sources: [roomSource] });
  const disabled = storedFlow({ id: 'fl_disabled', priority: 1, enabled: false, sources: [roomSource] });
  const edge = storedFlow({
    id: 'fl_edge',
    priority: 5,
    sources: [{ kind: 'edge', tag: 'hall' }],
    triggers: [{ kind: 'manual' }, { kind: 'edge_online' }],
  });
  const flows = [mid, disabled, high, edge];
  const selected = selectFlow(flows, { trigger: 'room_start', identity: { type: 'room', roomId: 'hall' } });
  assert.equal(selected?.id, 'fl_high');
  assert.equal(
    selectFlow(flows.map((flow) => ({ ...flow, enabled: false })), {
      trigger: 'room_start',
      identity: { type: 'room', roomId: 'hall' },
    }),
    null,
  );
  assert.equal(
    flowMatchesTrigger(high, 'room_start', { type: 'room', roomId: 'other' }),
    false,
  );
  assert.equal(flowMatchesTrigger(edge, 'edge_online', { type: 'edge', edgeId: 'cam-1', tag: 'hall' }), true);
  assert.equal(flowMatchesTrigger(edge, 'edge_online', { type: 'edge', edgeId: 'cam-1', tag: 'other' }), false);
  assert.equal(flowMatchesTrigger(high, 'edge_online', { type: 'edge', edgeId: 'cam-1' }), false, 'no edge_online trigger');
  assert.equal(flowMatchesTrigger(high, 'manual'), true);
  // Ordering is deterministic.
  const a = storedFlow({ id: 'fl_a', priority: 10, createdAt: 100 });
  const b = storedFlow({ id: 'fl_b', priority: 10, createdAt: 200 });
  const c = storedFlow({ id: 'fl_c', priority: 10, createdAt: 200 });
  assert.ok(compareFlows(a, b) < 0);
  assert.ok(compareFlows(b, c) < 0);
});

test('fan-in: a flow may declare several sources; only same-room sources mix', () => {
  const parsed = flowCreateSchema.safeParse({
    sources: [
      { kind: 'room', roomId: 'hall' },
      { kind: 'edge', edgeId: 'cam-hall' },
      { kind: 'participant', roomId: 'hall', tag: 'panel' },
    ],
    processors: [{ kind: 'layout', layout: 'grid' }, { kind: 'audio_mix' }],
    sinks: [{ kind: 'hls' }, { kind: 'recording' }],
    triggers: [{ kind: 'manual' }, { kind: 'room_start' }, { kind: 'edge_online' }],
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
  if (!parsed.success) return;
  const flow = storedFlow({ ...normalizeFlow(parsed.data), sources: parsed.data.sources });
  const plan = planFlowExecution(flow);
  assert.equal(plan.sources.length, 3);
  assert.equal(plan.executable, false, 'participant sources are a pending adapter');
  // room + edge mix (same room) is executable when no participant source is declared.
  const roomEdge = storedFlow({
    sources: [{ kind: 'room', roomId: 'hall' }, { kind: 'edge', edgeId: 'cam-hall' }],
    triggers: [{ kind: 'manual' }, { kind: 'room_start' }, { kind: 'edge_online' }],
  });
  assert.equal(planFlowExecution(roomEdge).executable, true);
});

test('fallback: chain is depth-limited, cycle-safe and validated on write', () => {
  const primary = storedFlow({ id: 'fl_primary', priority: 10, fallbackFlowId: 'fl_backup' });
  const backup = storedFlow({ id: 'fl_backup', priority: 500 });
  const flows = [primary, backup];
  assert.deepEqual(
    flowFallbackChain(flows, primary).map((flow) => flow.id),
    ['fl_primary', 'fl_backup'],
  );
  // Disabled fallback is skipped.
  const disabledBackup = { ...backup, enabled: false };
  assert.deepEqual(
    flowFallbackChain([primary, disabledBackup], primary).map((flow) => flow.id),
    ['fl_primary'],
  );
  // Missing/self/cycle.
  assert.deepEqual(validateFlowFallback({ id: 'fl_x', fallbackFlowId: 'fl_x' }, []), [
    { path: 'fallbackFlowId', message: 'a flow cannot fall back to itself' },
  ]);
  assert.match(
    String(validateFlowFallback({ id: 'fl_x', fallbackFlowId: 'fl_missing' }, [primary, backup])[0]?.message),
    /does not exist/,
  );
  const loopA = storedFlow({ id: 'fl_a' , fallbackFlowId: 'fl_b' });
  const loopB = storedFlow({ id: 'fl_b', fallbackFlowId: 'fl_a' });
  assert.match(String(validateFlowFallback(loopA, [loopA, loopB])[0]?.message), /cycle/);
  // Deep chain beyond the limit is rejected.
  const chain: Flow[] = [];
  for (let index = 0; index < FLOW_MAX_FALLBACK_DEPTH + 2; index += 1) {
    chain.push(
      storedFlow({
        id: `fl_chain_${index}`,
        ...(index < FLOW_MAX_FALLBACK_DEPTH + 1 ? { fallbackFlowId: `fl_chain_${index + 1}` } : {}),
      }),
    );
  }
  assert.match(
    String(validateFlowFallback(chain[0] as Flow, chain)[0]?.message),
    /deeper than/,
  );
  // The schema itself only rejects self-fallback (tenant-wide checks are server-side).
  assert.equal(flowSchema.safeParse(storedFlow({ id: 'fl_self', fallbackFlowId: 'fl_self' })).success, false);
});

test('PATCH: scalars merge, list fields replace wholesale, fallback can be cleared', () => {
  const current = storedFlow();
  const patch = flowPatchSchema.parse({
    priority: 5,
    name: null,
    sources: [{ kind: 'edge', edgeId: 'cam-hall' }],
    sinks: [{ kind: 'hls', layout: 'speaker' }],
    triggers: [{ kind: 'manual' }, { kind: 'edge_online' }],
    fallbackFlowId: 'fl_backup',
  });
  const merged = mergeFlow(current, patch, 2000);
  assert.equal(merged.priority, 5);
  assert.equal(merged.name, undefined);
  assert.deepEqual(merged.sources, [{ kind: 'edge', edgeId: 'cam-hall' }], 'sources are replaced, not merged by index');
  assert.deepEqual(merged.sinks, [{ kind: 'hls', layout: 'speaker' }]);
  assert.deepEqual(merged.triggers, [{ kind: 'manual' }, { kind: 'edge_online' }]);
  assert.equal(merged.fallbackFlowId, 'fl_backup');
  assert.equal(merged.updatedAt, 2000);
  assert.equal(merged.createdAt, 1000);
  assert.equal(flowSchema.safeParse(merged).success, true);
  const cleared = mergeFlow(merged, flowPatchSchema.parse({ fallbackFlowId: null }), 3000);
  assert.equal(cleared.fallbackFlowId, undefined);
  // Empty patch is rejected by the HTTP layer (the schema accepts `{}`).
  assert.deepEqual(flowPatchSchema.parse({}), {});
});

test('redaction: flow views never expose URLs/stream keys, only hosts', () => {
  const view = flowView(storedFlow({ sources: [{ kind: 'rtmp_ingest', url: RTMP }] }));
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('super-secret-stream-key'), 'stream key never appears in a view');
  const ingest = view.sources[0];
  assert.equal(ingest?.urlHost, 'rtmp://live.example/…');
  assert.equal(ingest?.hasSecret, true);
  assert.equal('url' in (ingest ?? {}), false);
  const streamSink = view.sinks.find((sink) => sink.kind === 'rtmp');
  assert.equal(streamSink?.urlHost, 'rtmp://live.example/…');
  assert.equal('url' in (streamSink ?? {}), false);
  assert.equal(flowSourceView({ kind: 'room', roomId: 'hall' }).hasSecret, false);
  assert.equal(flowSinkView({ kind: 'hls' }).hasSecret, false);
  assert.equal(flowSinkView({ kind: 'rtmp', secretRef: SECRET_REF }).hasSecret, true);
  assert.equal(flowSinkView({ kind: 'rtmp', secretRef: SECRET_REF }).secretRef, SECRET_REF);
  assert.ok(FLOW_LIMITATIONS.length >= 5);
  assert.ok(FLOW_LIMITATIONS.some((line) => /cross-room/i.test(line)));
});

test('schedule: interval/once arithmetic and due detection', () => {
  const interval = { kind: 'schedule' as const, everySec: 60 };
  assert.equal(nextFlowScheduleAt(interval, { createdAt: 1_000 }), 61_000);
  assert.equal(nextFlowScheduleAt(interval, { createdAt: 1_000, lastFiredAt: 61_000 }), 121_000);
  const once = { kind: 'schedule' as const, at: 5_000 };
  assert.equal(nextFlowScheduleAt(once, { createdAt: 1_000 }), 5_000);
  assert.equal(nextFlowScheduleAt(once, { createdAt: 1_000, lastFiredAt: 5_000 }), null);
  assert.equal(nextFlowScheduleAt({ kind: 'manual' }, { createdAt: 1_000 }), null);
  assert.equal(nextFlowRunAt({ triggers: [interval], createdAt: 1_000 }), 61_000);
  assert.equal(nextFlowRunAt({ triggers: [{ kind: 'manual' }], createdAt: 1_000 }), null);
  assert.equal(isFlowScheduleDue({ triggers: [interval], createdAt: 1_000 }, 60_999), false);
  assert.equal(isFlowScheduleDue({ triggers: [interval], createdAt: 1_000 }, 61_000), true);
  assert.equal(isFlowScheduleDue({ triggers: [interval], createdAt: 1_000, lastFiredAt: 61_000 }, 61_000), false);
});
