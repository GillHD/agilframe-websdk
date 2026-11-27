/**
 * Regression tests for the pilot recording fixes.
 *
 *  - P1: local blob downloads used to be silently dropped by `safeHttpUrl()`
 *    (it only allows http/https). The dedicated path must click one anchor and
 *    revoke the object URL, and must refuse foreign/opaque blob URLs.
 *  - P1: the recording indicator was hidden by `display:none !important`; the
 *    stylesheet must not hide it anymore (browser rect/visibility is covered by
 *    the QA recording harness).
 *  - P2: start/stop is broadcast as participant state and a guest derives a
 *    persistent indicator from it.
 *  - P3: WebM recordings get a best-effort Duration element.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Participant } from '@agil/protocol';
import { isSameOriginBlobUrl, triggerBlobDownload } from '../src/call/download.js';
import {
  findRemoteRecording,
  recordingIndicatorState,
  recordingStatePatch,
  remoteRecordingPatch,
} from '../src/call/recording-state.js';
import { readWebmDuration, withWebmDuration } from '../src/call/webm-duration.js';
import { createInitialRecording } from '../src/state.js';

/* ------------------------------------------------------------------ */
/* P1: blob download path                                              */
/* ------------------------------------------------------------------ */

test('blob download: only same-origin blob: URLs are eligible', () => {
  assert.equal(isSameOriginBlobUrl('blob:http://localhost:8787/abc', 'http://localhost:8787/embed.html'), true);
  assert.equal(isSameOriginBlobUrl('blob:https://calls.example/abc', 'https://calls.example/call'), true);
  // Provider/foreign object URL, opaque origin and non-blob schemes are refused.
  assert.equal(isSameOriginBlobUrl('blob:https://cdn.provider.example/abc', 'https://calls.example/call'), false);
  assert.equal(isSameOriginBlobUrl('blob:null/abc', 'https://calls.example/call'), false);
  assert.equal(isSameOriginBlobUrl('https://calls.example/file.webm', 'https://calls.example/call'), false);
  assert.equal(isSameOriginBlobUrl('javascript:alert(1)', 'https://calls.example/call'), false);
  assert.equal(isSameOriginBlobUrl('', 'https://calls.example/call'), false);
});

interface FakeAnchor {
  href: string;
  download: string;
  rel: string;
  clicks: number;
  removed: boolean;
  click(): void;
  remove(): void;
}

function fakeDocument(events: string[]): { document: never; anchor: FakeAnchor } {
  const anchor: FakeAnchor = {
    href: '',
    download: '',
    rel: '',
    clicks: 0,
    removed: false,
    click() {
      this.clicks += 1;
      events.push('click');
    },
    remove() {
      this.removed = true;
      events.push('remove');
    },
  };
  const document = {
    createElement: () => anchor,
    body: { appendChild: () => undefined },
  };
  return { document: document as never, anchor };
}

test('blob download: creates anchor, clicks it, then revokes the URL', () => {
  const events: string[] = [];
  const { document, anchor } = fakeDocument(events);
  const revoked: string[] = [];
  const created: string[] = [];
  const blob = new Blob(['recording'], { type: 'video/webm' });
  const ok = triggerBlobDownload(blob, 'agil-recording.webm', {
    document: document as unknown as Parameters<typeof triggerBlobDownload>[2]['document'],
    createObjectUrl: (value) => {
      assert.equal(value, blob);
      created.push('blob:http://localhost:8787/rec-1');
      return created[0] as string;
    },
    revokeObjectUrl: (url) => {
      revoked.push(url);
      events.push('revoke');
    },
    href: 'http://localhost:8787/embed.html',
  });
  assert.equal(ok, true);
  assert.equal(anchor.clicks, 1);
  assert.equal(anchor.download, 'agil-recording.webm');
  assert.equal(anchor.href, 'blob:http://localhost:8787/rec-1');
  assert.equal(anchor.removed, true);
  assert.deepEqual(revoked, ['blob:http://localhost:8787/rec-1']);
  assert.deepEqual(events, ['click', 'remove', 'revoke'], 'revoke happens only after the click');
});

test('blob download: a foreign blob URL is refused and still revoked', () => {
  const events: string[] = [];
  const { document, anchor } = fakeDocument(events);
  const revoked: string[] = [];
  const ok = triggerBlobDownload(new Blob(['x']), 'x.webm', {
    document: document as unknown as Parameters<typeof triggerBlobDownload>[2]['document'],
    createObjectUrl: () => 'blob:https://cdn.provider.example/x',
    revokeObjectUrl: (url) => revoked.push(url),
    href: 'https://calls.example/call',
  });
  assert.equal(ok, false);
  assert.equal(anchor.clicks, 0, 'no anchor click for a non-local URL');
  assert.deepEqual(revoked, ['blob:https://cdn.provider.example/x']);
});

test('blob download: no document means no false success', () => {
  assert.equal(triggerBlobDownload(new Blob(['x']), 'x.webm', {
    createObjectUrl: () => 'blob:http://localhost/x',
    revokeObjectUrl: () => undefined,
    href: 'http://localhost/',
  }), false);
});

/* ------------------------------------------------------------------ */
/* P1: indicator stylesheet is not hidden                              */
/* ------------------------------------------------------------------ */

test('recording indicator: no header CSS rule hides it with display:none', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/style.css', import.meta.url)), 'utf8');
  // Remove comments so commented-out selectors don't masquerade as rules.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const hideRules = [...stripped.matchAll(/([^{}]*\.agil-rec-indicator[^{}]*)\{([^{}]*)\}/g)];
  const hidden = hideRules.filter((rule) => /(^|;)\s*display\s*:\s*none/.test(rule[2] ?? ''));
  assert.deepEqual(hidden.map((rule) => rule[1]?.trim()), [], 'indicator must not be display:none');
  assert.match(stripped, /\.agil-rec-indicator\s*\{[^}]*display:\s*inline-flex/);
});

/* ------------------------------------------------------------------ */
/* P2: signaling recording state                                       */
/* ------------------------------------------------------------------ */

function participant(id: string, name: string, recording: boolean, startedAt?: number): Participant {
  return {
    id,
    name,
    role: 'guest',
    joinedAt: 1,
    verified: false,
    integrity: 'unknown',
    state: { mic: 'on', cam: 'on', screen: false, handRaised: false, network: 'good', recording, recordingStartedAt: startedAt ?? null },
  };
}

test('recording state: start/stop patch contains both flag and start time', () => {
  assert.deepEqual(recordingStatePatch(true, 1_700_000_000_000), {
    recording: true,
    recordingStartedAt: 1_700_000_000_000,
  });
  assert.deepEqual(recordingStatePatch(false, null), { recording: false, recordingStartedAt: null });
});

test('recording state: guest derives the earliest active remote recording', () => {
  const participants = [
    participant('a', 'Alisa', false),
    participant('b', 'Bob', true, 1_700_000_030_000),
    participant('c', 'Carol', true, 1_700_000_010_000),
  ];
  assert.deepEqual(findRemoteRecording(participants), {
    remoteActive: true,
    remoteStartedAt: 1_700_000_010_000,
    remoteByName: 'Carol',
  });
  assert.deepEqual(findRemoteRecording([participant('a', 'Alisa', false)]), {
    remoteActive: false,
    remoteStartedAt: null,
    remoteByName: null,
  });
});

test('recording state: patch is emitted on start/stop and not on identical frames', () => {
  const initial = createInitialRecording();
  const started = remoteRecordingPatch(initial, [participant('h', 'Host', true, 1_700_000_000_000)]);
  assert.deepEqual(started, {
    remoteActive: true,
    remoteStartedAt: 1_700_000_000_000,
    remoteByName: 'Host',
  });
  const recording = { ...initial, ...started };
  assert.equal(remoteRecordingPatch(recording, [participant('h', 'Host', true, 1_700_000_000_000)]), null);
  // A repeated start frame for an already known recording is not an event.
  assert.equal(remoteRecordingPatch(recording, [participant('h', 'Host', true, 1_700_000_000_000)]), null);
  assert.deepEqual(remoteRecordingPatch(recording, [participant('h', 'Host', false)]), {
    remoteActive: false,
    remoteStartedAt: null,
    remoteByName: null,
  });
});

test('recording indicator: local recording wins over a remote one', () => {
  assert.deepEqual(recordingIndicatorState(createInitialRecording()), { active: false, startedAt: null, byName: null });
  const remote = { ...createInitialRecording(), remoteActive: true, remoteStartedAt: 10, remoteByName: 'Host' };
  assert.deepEqual(recordingIndicatorState(remote), { active: true, startedAt: 10, byName: 'Host' });
  const local = { ...remote, active: true, startedAt: 20 };
  assert.deepEqual(recordingIndicatorState(local), { active: true, startedAt: 20, byName: null });
});

/* ------------------------------------------------------------------ */
/* P3: WebM duration metadata                                          */
/* ------------------------------------------------------------------ */

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function syntheticWebm(options: { segmentKnownSize?: boolean; durationTicks?: number } = {}): Uint8Array {
  const ebml = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01]);
  const timecodeScale = new Uint8Array([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]);
  const muxingApp = new Uint8Array([0x4d, 0x80, 0x81, 0x78]);
  const infoPayload = options.durationTicks
    ? concat(timecodeScale, muxingApp, new Uint8Array([0x44, 0x89, 0x88]), float64(options.durationTicks))
    : concat(timecodeScale, muxingApp);
  const info = concat(new Uint8Array([0x15, 0x49, 0xa9, 0x66, 0x80 | infoPayload.length]), infoPayload);
  const segmentId = new Uint8Array([0x18, 0x53, 0x80, 0x67]);
  const cluster = new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x81, 0x00]);
  let segmentHeader: Uint8Array;
  if (options.segmentKnownSize) {
    // Encode the known segment size as 1 byte (payload = Info + Cluster).
    segmentHeader = concat(segmentId, new Uint8Array([0x80 | (info.length + cluster.length)]));
  } else {
    segmentHeader = concat(segmentId, new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  }
  return concat(ebml, segmentHeader, info, cluster);
}

function float64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return bytes;
}

test('webm duration: appends Duration inside Segment Info without moving clusters', async () => {
  const original = syntheticWebm();
  const blob = new Blob([original], { type: 'video/webm' });
  const patchedBlob = await withWebmDuration(blob, 7.45);
  const patched = new Uint8Array(await patchedBlob.arrayBuffer());
  assert.equal(patched.length, original.length + 11, 'only the 11-byte Duration element is added');
  const duration = readWebmDuration(patched);
  assert.ok(duration !== null && Math.abs(duration - 7.45) < 0.001, `duration ${duration}`);
  // Original blob is untouched.
  assert.equal(new Uint8Array(await blob.arrayBuffer()).length, original.length);
  // Payload after the Info element is byte-identical.
  const clusterOffset = patched.findIndex((byte, index) =>
    byte === 0x1f && patched[index + 1] === 0x43 && patched[index + 2] === 0xb6 && patched[index + 3] === 0x75,
  );
  const originalClusterOffset = original.findIndex((byte, index) =>
    byte === 0x1f && original[index + 1] === 0x43 && original[index + 2] === 0xb6 && original[index + 3] === 0x75,
  );
  assert.ok(clusterOffset > 0 && originalClusterOffset > 0);
  assert.deepEqual(patched.subarray(clusterOffset), original.subarray(originalClusterOffset));
});

test('webm duration: an existing Duration is overwritten in place', async () => {
  const original = syntheticWebm({ durationTicks: 1000 });
  const patchedBlob = await withWebmDuration(new Blob([original]), 2.5);
  const patched = new Uint8Array(await patchedBlob.arrayBuffer());
  assert.equal(patched.length, original.length);
  const duration = readWebmDuration(patched);
  assert.ok(duration !== null && Math.abs(duration - 2.5) < 0.001, `duration ${duration}`);
});

test('webm duration: known-size Segment is left unchanged instead of risking corruption', async () => {
  const original = syntheticWebm({ segmentKnownSize: true });
  const patched = new Uint8Array(await (await withWebmDuration(new Blob([original]), 5)).arrayBuffer());
  assert.deepEqual(patched, original);
  assert.equal(readWebmDuration(patched), null);
});
