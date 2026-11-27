/**
 * Per-node module (Docker add-on) protocol contract.
 *
 * Pure schema tests: the catalog allowlist ids, module report/command/result
 * shapes, image/reference validation and the backward-compatible heartbeat
 * request (old agents send `{}`; a newer agent's unknown module must not make
 * the Core reject the whole liveness beat).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_MODULE_COMMAND_MAX_QUEUE,
  NODE_MODULE_COMMAND_TTL_MS,
  NODE_MODULE_COMMAND_TTL_SEC,
  NODE_MODULE_MAX_ITEMS,
  NODE_MODULE_MAX_PORTS,
  nodeHeartbeatRequestSchema,
  nodeModuleActionRequestSchema,
  nodeModuleActions,
  nodeModuleCatalogEntrySchema,
  nodeModuleCommandSchema,
  nodeModuleImageRepository,
  nodeModuleReportSchema,
  nodeModuleReportsSchema,
  nodeModuleResultSchema,
  nodeModuleResultsSchema,
  nodeModuleSchema,
  nodeModuleStatuses,
  nodeModulesPaths,
} from '../src/cluster.js';

const MODULE = {
  id: 'egress',
  kind: 'egress',
  name: 'Egress streaming worker',
  version: '0.1.0',
  image: 'agil/node-egress:0.1.0',
  status: 'running',
  health: 'healthy',
  ports: [8080, 8443],
  updatedAt: 1_732_230_000_000,
};

const REPORT = {
  id: 'egress',
  image: 'agil/node-egress:0.1.0',
  status: 'running',
  name: 'Egress streaming worker',
  version: '0.1.0',
  health: 'healthy',
  ports: [8080],
  updatedAt: 1_732_230_000_000,
};

const COMMAND = {
  id: 'nmc_0123456789abcdef',
  moduleId: 'egress',
  action: 'start',
  createdAt: 1_732_230_000_000,
  expiresAt: 1_732_230_300_000,
};

function issuePaths(schema: { safeParse: (value: unknown) => any }, input: unknown): string[] {
  const result = schema.safeParse(input);
  assert.equal(result.success, false, `expected ${JSON.stringify(input)} to be rejected`);
  return result.error.issues.map((issue: { path: (string | number)[] }) => issue.path.join('.'));
}

test('node module inventory round-trips (id/kind/status/health/ports/updatedAt)', () => {
  assert.deepEqual(nodeModuleSchema.parse(MODULE), MODULE);
  const minimal = {
    id: 'turn',
    kind: 'turn',
    name: 'TURN/STUN relay',
    version: '',
    image: 'coturn/coturn:4.6',
    status: 'stopped',
    health: 'unknown',
    ports: [],
    updatedAt: 0,
  };
  assert.deepEqual(nodeModuleSchema.parse(minimal), minimal);
  // lastError is optional and bounded.
  assert.equal(nodeModuleSchema.parse({ ...MODULE, lastError: 'docker start failed' }).lastError, 'docker start failed');
  assert.deepEqual(issuePaths(nodeModuleSchema, { ...MODULE, lastError: 'x'.repeat(301) }), ['lastError']);
});

test('node module inventory accepts custom types and rejects invalid fields', () => {
  assert.equal(nodeModuleSchema.parse({ ...MODULE, id: 'gpu', kind: 'compute' }).id, 'gpu');
  assert.deepEqual(issuePaths(nodeModuleSchema, { ...MODULE, id: 'bad id' }), ['id']);
  assert.deepEqual(issuePaths(nodeModuleSchema, { ...MODULE, kind: 'bad type' }), ['kind']);
  assert.deepEqual(issuePaths(nodeModuleSchema, { ...MODULE, status: 'paused' }), ['status']);
  assert.deepEqual(issuePaths(nodeModuleSchema, { ...MODULE, health: 'sick' }), ['health']);
  assert.deepEqual(issuePaths(nodeModuleSchema, { ...MODULE, ports: [0] }), ['ports.0']);
  assert.deepEqual(issuePaths(nodeModuleSchema, { ...MODULE, ports: [70_000] }), ['ports.0']);
  assert.deepEqual(issuePaths(nodeModuleSchema, { ...MODULE, ports: Array(NODE_MODULE_MAX_PORTS + 1).fill(80) }), ['ports']);
  assert.deepEqual(issuePaths(nodeModuleSchema, { ...MODULE, updatedAt: -1 }), ['updatedAt']);
  assert.deepEqual(issuePaths(nodeModuleSchema, { ...MODULE, updatedAt: 1.5 }), ['updatedAt']);
});

test('image references are validated and repository matching ignores tag/digest/registry port', () => {
  // `''` fails several constraints; a path may repeat, values must all be `image`.
  assert.deepEqual([...new Set(issuePaths(nodeModuleSchema, { ...MODULE, image: '' }))], ['image']);
  assert.deepEqual(issuePaths(nodeModuleSchema, { ...MODULE, image: 'http://evil/egress:1' }), ['image']);
  assert.deepEqual(issuePaths(nodeModuleSchema, { ...MODULE, image: 'agil//egress:1' }), ['image']);
  assert.deepEqual(issuePaths(nodeModuleSchema, { ...MODULE, image: 'agil/egress:' }), ['image']);

  assert.equal(nodeModuleImageRepository('agil/node-egress:0.1.0'), 'agil/node-egress');
  assert.equal(nodeModuleImageRepository('agil/node-egress@sha256:' + 'a'.repeat(64)), 'agil/node-egress');
  assert.equal(nodeModuleImageRepository('registry.example:5000/agil/egress:2.0'), 'registry.example:5000/agil/egress');
  assert.equal(nodeModuleImageRepository('registry.example:5000/agil/egress'), 'registry.example:5000/agil/egress');
  assert.equal(nodeModuleImageRepository('coturn'), 'coturn');
  // Tag/digest variants are representable; the Core still checks the repository.
  assert.equal(
    nodeModuleSchema.parse({ ...MODULE, image: 'agil/node-egress@sha256:' + 'b'.repeat(64) }).image,
    'agil/node-egress@sha256:' + 'b'.repeat(64),
  );
});

test('heartbeat module reports require id/image/status and strip unknown fields', () => {
  assert.deepEqual(nodeModuleReportSchema.parse(REPORT), REPORT);
  assert.deepEqual(nodeModuleReportSchema.parse({ id: 'egress', image: 'agil/node-egress:0.1.0', status: 'stopped' }), {
    id: 'egress',
    image: 'agil/node-egress:0.1.0',
    status: 'stopped',
  });
  // An id that is not in this Core's catalog still parses: a newer agent must
  // not break node liveness against an older Core (the server drops the entry).
  assert.equal(nodeModuleReportSchema.parse({ id: 'gpu', image: 'agil/node-gpu:1', status: 'running' }).id, 'gpu');
  assert.deepEqual(issuePaths(nodeModuleReportSchema, { id: 'egress', status: 'running' }), ['image']);
  assert.deepEqual(issuePaths(nodeModuleReportSchema, { image: 'agil/node-egress:1', status: 'running' }), ['id']);
  assert.deepEqual(issuePaths(nodeModuleReportSchema, { id: 'egress', image: 'agil/node-egress:1' }), ['status']);
  // Unknown fields are stripped, not rejected (forward compatibility).
  const parsed = nodeModuleReportSchema.parse({ ...REPORT, futureField: 1, nested: { a: 1 } });
  assert.deepEqual(parsed, REPORT);
});

test('heartbeat accepts a bounded modules/moduleResults snapshot and stays backward compatible', () => {
  assert.deepEqual(nodeHeartbeatRequestSchema.parse({}), {});
  assert.deepEqual(nodeHeartbeatRequestSchema.parse({ capacity: { maxRooms: 2 }, status: 'offline' }), {
    capacity: { maxRooms: 2 },
    status: 'offline',
  });
  const body = nodeHeartbeatRequestSchema.parse({
    modules: [REPORT],
    moduleResults: [{ commandId: COMMAND.id, ok: true, status: 'running' }],
  });
  assert.equal(body.modules?.length, 1);
  assert.equal(body.moduleResults?.[0]?.commandId, COMMAND.id);
  assert.equal(nodeModuleReportsSchema.parse([]).length, 0);
});

test('module reports/results snapshots are bounded to 32 entries', () => {
  const tooMany = Array(NODE_MODULE_MAX_ITEMS + 1).fill(REPORT);
  assert.equal(nodeModuleReportsSchema.safeParse(tooMany).success, false);
  const tooManyResults = Array(NODE_MODULE_MAX_ITEMS + 1).fill({ commandId: COMMAND.id, ok: true, status: 'running' });
  assert.equal(nodeModuleResultsSchema.safeParse(tooManyResults).success, false);
});

test('commands are server-shaped: id format, catalog module id, action enum, TTL window', () => {
  assert.deepEqual(nodeModuleCommandSchema.parse(COMMAND), COMMAND);
  assert.deepEqual(nodeModuleCommandSchema.parse({ ...COMMAND, image: 'agil/node-egress:0.1.0' }).image, 'agil/node-egress:0.1.0');
  assert.deepEqual(issuePaths(nodeModuleCommandSchema, { ...COMMAND, id: 'cmd_1' }), ['id']);
  assert.deepEqual(issuePaths(nodeModuleCommandSchema, { ...COMMAND, moduleId: 'gpu' }), ['moduleId']);
  const custom = { ...COMMAND, moduleId: 'gpu', targetContainerId: 'a'.repeat(64) };
  assert.deepEqual(nodeModuleCommandSchema.parse(custom), custom);
  assert.equal(nodeModuleCommandSchema.safeParse({ ...custom, action: 'install' }).success, false);
  assert.equal(nodeModuleCommandSchema.safeParse({ ...custom, image: 'redis:7' }).success, false);
  assert.deepEqual(issuePaths(nodeModuleCommandSchema, { ...COMMAND, action: 'upgrade' }), ['action']);
  assert.deepEqual(issuePaths(nodeModuleCommandSchema, { ...COMMAND, createdAt: -1 }), ['createdAt']);
  assert.deepEqual(issuePaths(nodeModuleCommandSchema, { ...COMMAND, expiresAt: 1.5 }), ['expiresAt']);
  // An action request cannot carry an image/command: unknown keys are stripped.
  assert.deepEqual(nodeModuleActionRequestSchema.parse({ action: 'install', image: 'evil:1' }), { action: 'install' });
  assert.deepEqual(issuePaths(nodeModuleActionRequestSchema, {}), ['action']);
  assert.deepEqual(issuePaths(nodeModuleActionRequestSchema, { action: 'upgrade' }), ['action']);
  for (const action of nodeModuleActions) {
    assert.equal(nodeModuleActionRequestSchema.parse({ action }).action, action);
  }
});

test('module results are bounded and use the documented status/error shape', () => {
  const result = { commandId: COMMAND.id, ok: false, status: 'error', error: 'container exited' };
  assert.deepEqual(nodeModuleResultSchema.parse(result), result);
  assert.deepEqual(issuePaths(nodeModuleResultSchema, { ...result, error: 'x'.repeat(301) }), ['error']);
  assert.deepEqual(issuePaths(nodeModuleResultSchema, { commandId: 'bogus', ok: true, status: 'running' }), ['commandId']);
  for (const status of nodeModuleStatuses) {
    assert.equal(nodeModuleResultSchema.parse({ commandId: COMMAND.id, ok: true, status }).status, status);
  }
});

test('catalog entries carry the allowlist image/repository/ports/env hints and actions', () => {
  const entry = {
    id: 'turn',
    kind: 'turn',
    name: 'TURN/STUN relay',
    description: 'coturn relay',
    image: 'coturn/coturn:4.6',
    repository: 'coturn/coturn',
    ports: [3478, 5349],
    env: [
      { name: 'TURN_REALM', required: true, secret: false, description: 'realm' },
      { name: 'TURN_STATIC_AUTH_SECRET', required: true, secret: true, description: 'node-local secret' },
    ],
    actions: ['start', 'stop', 'restart', 'install', 'remove'],
  };
  assert.deepEqual(nodeModuleCatalogEntrySchema.parse(entry), entry);
  assert.deepEqual(issuePaths(nodeModuleCatalogEntrySchema, { ...entry, id: 'gpu' }), ['id']);
  assert.deepEqual(issuePaths(nodeModuleCatalogEntrySchema, { ...entry, env: [{ name: 'lowercase' }] }), ['env.0.name']);
  // Env hints are metadata only: no `value` field exists to smuggle a secret.
  assert.equal('value' in nodeModuleCatalogEntrySchema.parse(entry).env[0]!, false);
  assert.deepEqual(issuePaths(nodeModuleCatalogEntrySchema, { ...entry, actions: ['upgrade'] }), ['actions.0']);
});

test('heartbeat response/module API path constants are stable', () => {
  assert.equal(nodeModulesPaths.catalog, '/v1/admin/node-modules/catalog');
  assert.equal(nodeModulesPaths.nodeModules('edge-1'), '/v1/admin/nodes/edge-1/modules');
  assert.equal(
    nodeModulesPaths.moduleActions('edge-1', 'egress'),
    '/v1/admin/nodes/edge-1/modules/egress/actions',
  );
  // Reserved characters are percent-encoded so a module id cannot escape its segment.
  assert.equal(
    nodeModulesPaths.moduleActions('edge/1', 'egress'),
    '/v1/admin/nodes/edge%2F1/modules/egress/actions',
  );
});

test('queue constants match the documented contract', () => {
  assert.equal(NODE_MODULE_COMMAND_TTL_SEC, 300);
  assert.equal(NODE_MODULE_COMMAND_TTL_MS, 300_000);
  assert.equal(NODE_MODULE_COMMAND_MAX_QUEUE, 16);
  assert.equal(NODE_MODULE_MAX_ITEMS, 32);
  assert.equal(NODE_MODULE_MAX_PORTS, 8);
});
