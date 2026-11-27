import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AudioOutput } from '../src/call/audio-output';

test('playback registered during a failed speaker change returns to the previous output', async () => {
  const output = new AudioOutput();
  const document = { createElement: () => ({ setSinkId: async () => undefined }) } as unknown as Document;
  let rejectChange = () => { throw new Error('Speaker change did not start'); };
  const current = {
    setSinkId: (deviceId: string) => deviceId === 'headset'
      ? new Promise<void>((_, reject) => { rejectChange = () => reject(new Error('Device unavailable')); })
      : Promise.resolve(),
  };
  output.register(current as unknown as HTMLMediaElement);
  const rejected = assert.rejects(output.select('headset', document), /Could not change the audio output/);
  await nextTurn();

  const late = { sinkId: '', setSinkId: async (deviceId: string) => {
    if (deviceId === 'headset') await headsetPending;
    late.sinkId = deviceId;
  } };
  let finishHeadset!: () => void;
  const headsetPending = new Promise<void>((resolve) => { finishHeadset = resolve; });
  output.register(late as unknown as HTMLMediaElement);
  rejectChange();
  await nextTurn();
  finishHeadset();
  await rejected;
  await nextTurn();
  assert.equal(late.sinkId, '');
});
