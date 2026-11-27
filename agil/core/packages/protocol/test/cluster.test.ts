/**
 * Node live-metrics contract: heartbeat accepts an optional, range-validated
 * `metrics` snapshot and stays backward compatible with old agents that send
 * only `capacity`/`status`. Pure protocol tests (no server).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_OFFLINE_AFTER_SEC,
  nodeHeartbeatRequestSchema,
  nodeMetricsInputSchema,
  nodeMetricsSchema,
} from '../src/cluster.js';

const FULL = {
  cpuPercent: 12.5,
  memoryPercent: 43,
  load1: 0.42,
  activeRooms: 3,
  participants: 17,
  bandwidthMbps: 12.5,
  uptimeSec: 86_400,
  version: '0.1.0',
  reportedAt: 1_732_230_000_000,
};

function issuePaths(input: unknown): string[] {
  const result = nodeMetricsInputSchema.safeParse(input);
  assert.equal(result.success, false, `expected ${JSON.stringify(input)} to be rejected`);
  return result.error.issues.map((issue) => issue.path.join('.'));
}

test('a full metrics snapshot round-trips unchanged (all fields accepted)', () => {
  const parsed = nodeMetricsInputSchema.parse(FULL);
  assert.deepEqual(parsed, FULL);
  // The stored/returned shape is the same snapshot plus the mandatory timestamp.
  assert.deepEqual(nodeMetricsSchema.parse(FULL), FULL);
  assert.equal(nodeMetricsSchema.parse(FULL).reportedAt, FULL.reportedAt);
});

test('metrics are optional: an old-style heartbeat (capacity/status only) still parses', () => {
  assert.deepEqual(nodeHeartbeatRequestSchema.parse({}), {});
  assert.deepEqual(nodeHeartbeatRequestSchema.parse({ capacity: { maxParticipants: 300 }, status: 'offline' }), {
    capacity: { maxParticipants: 300 },
    status: 'offline',
  });
  assert.equal(nodeHeartbeatRequestSchema.parse({ metrics: {} }).metrics?.reportedAt, undefined);
});

test('partial metric reports are valid: each field is independently optional', () => {
  assert.deepEqual(nodeMetricsInputSchema.parse({ cpuPercent: 0 }), { cpuPercent: 0 });
  assert.deepEqual(nodeMetricsInputSchema.parse({ metrics: undefined }), {});
  assert.deepEqual(nodeMetricsInputSchema.parse({ participants: 0, uptimeSec: 0 }), { participants: 0, uptimeSec: 0 });
  // Boundary values are inclusive.
  assert.deepEqual(nodeMetricsInputSchema.parse({ cpuPercent: 100, memoryPercent: 100 }), { cpuPercent: 100, memoryPercent: 100 });
  assert.deepEqual(nodeMetricsInputSchema.parse({ load1: 0, bandwidthMbps: 0 }), { load1: 0, bandwidthMbps: 0 });
});

test('cpu/memory percentages outside 0..100 are rejected', () => {
  assert.deepEqual(issuePaths({ cpuPercent: 101 }), ['cpuPercent']);
  assert.deepEqual(issuePaths({ cpuPercent: -0.1 }), ['cpuPercent']);
  assert.deepEqual(issuePaths({ memoryPercent: 100.01 }), ['memoryPercent']);
  assert.deepEqual(issuePaths({ memoryPercent: -1 }), ['memoryPercent']);
});

test('counters, load, bandwidth and uptime are finite and non-negative', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(issuePaths({ load1: bad }), ['load1']);
    assert.deepEqual(issuePaths({ bandwidthMbps: bad }), ['bandwidthMbps']);
  }
  assert.deepEqual(issuePaths({ load1: -1 }), ['load1']);
  assert.deepEqual(issuePaths({ bandwidthMbps: -1 }), ['bandwidthMbps']);
  assert.deepEqual(issuePaths({ activeRooms: -1 }), ['activeRooms']);
  assert.deepEqual(issuePaths({ participants: -1 }), ['participants']);
  assert.deepEqual(issuePaths({ uptimeSec: -1 }), ['uptimeSec']);
  // Counters must be integers; bandwidth/load/uptime may be fractional.
  assert.deepEqual(issuePaths({ activeRooms: 1.5 }), ['activeRooms']);
  assert.deepEqual(issuePaths({ participants: 1.5 }), ['participants']);
  assert.equal(nodeMetricsInputSchema.parse({ activeRooms: 1, participants: 2, uptimeSec: 60 }).uptimeSec, 60);
  // `process.uptime()` reports fractional seconds; a node agent must not get a 400 for it.
  assert.equal(nodeMetricsInputSchema.parse({ uptimeSec: 86400.75 }).uptimeSec, 86_400.75);
  assert.deepEqual(issuePaths({ uptimeSec: -1.5 }), ['uptimeSec']);
});

test('reportedAt/version are validated (epoch ms integer, trimmed 1..32 chars)', () => {
  assert.deepEqual(issuePaths({ reportedAt: -1 }), ['reportedAt']);
  assert.deepEqual(issuePaths({ reportedAt: 1.5 }), ['reportedAt']);
  assert.deepEqual(issuePaths({ reportedAt: Number.NaN }), ['reportedAt']);
  assert.deepEqual(issuePaths({ version: '' }), ['version']);
  assert.deepEqual(issuePaths({ version: 'x'.repeat(33) }), ['version']);
  assert.deepEqual(nodeMetricsInputSchema.parse({ version: '  0.1.0  ' }), { version: '0.1.0' });
});

test('unknown keys are stripped, not rejected (forward compatibility)', () => {
  const parsed = nodeMetricsInputSchema.parse({ cpuPercent: 5, gpuPercent: 90, nested: { a: 1 } });
  assert.deepEqual(parsed, { cpuPercent: 5 });
  const heartbeat = nodeHeartbeatRequestSchema.parse({ metrics: { cpuPercent: 5, futureMetric: 1 }, extra: true });
  assert.deepEqual(heartbeat, { metrics: { cpuPercent: 5 } });
});

test('stored metrics schema requires reportedAt and rejects it when absent', () => {
  const result = nodeMetricsSchema.safeParse({ cpuPercent: 5 });
  assert.equal(result.success, false);
  if (!result.success) assert.deepEqual(result.error.issues.map((issue) => issue.path.join('.')), ['reportedAt']);
});

test('liveness contract constants stay unchanged', () => {
  assert.equal(NODE_OFFLINE_AFTER_SEC, 90);
});
