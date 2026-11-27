/**
 * Recording state shared by signaling and the UI.
 *
 * Host recording was previously local-only: guests got a chat notice but no
 * persistent indicator (pilot P2). The recorder broadcasts start/stop as a
 * partial `state` message; the server stores it on the participant and replays
 * it in `welcome`/`room`, so a late joiner still sees the indicator.
 */
import type { Participant, ParticipantState } from '@agil/protocol';
import type { RecordingState } from '../types.js';

/** Partial participant state sent when the local recorder starts/stops. */
export function recordingStatePatch(active: boolean, startedAt: number | null): Partial<ParticipantState> {
  return { recording: active, recordingStartedAt: active ? startedAt : null };
}

export interface RemoteRecording {
  remoteActive: boolean;
  remoteStartedAt: number | null;
  remoteByName: string | null;
}

/** Picks the earliest active remote recording out of the participant list. */
export function findRemoteRecording(participants: readonly Participant[]): RemoteRecording {
  let found: { participant: Participant; startedAt: number | null } | null = null;
  for (const participant of participants) {
    if (participant.state?.recording !== true) continue;
    const startedAt =
      typeof participant.state.recordingStartedAt === 'number' ? participant.state.recordingStartedAt : null;
    if (!found || (startedAt !== null && (found.startedAt === null || startedAt < found.startedAt))) {
      found = { participant, startedAt };
    }
  }
  if (!found) return { remoteActive: false, remoteStartedAt: null, remoteByName: null };
  return {
    remoteActive: true,
    remoteStartedAt: found.startedAt,
    remoteByName: found.participant.name,
  };
}

/** Returns the remote-recording patch only when it actually changed. */
export function remoteRecordingPatch(
  recording: RecordingState,
  participants: readonly Participant[],
): Partial<RecordingState> | null {
  const next = findRemoteRecording(participants);
  const same =
    (recording.remoteActive ?? false) === next.remoteActive &&
    (recording.remoteStartedAt ?? null) === next.remoteStartedAt &&
    (recording.remoteByName ?? null) === next.remoteByName;
  return same ? null : next;
}

/** What the header indicator should render (local recording wins over remote). */
export function recordingIndicatorState(recording: RecordingState): {
  active: boolean;
  startedAt: number | null;
  byName: string | null;
} {
  if (recording.active) return { active: true, startedAt: recording.startedAt, byName: null };
  if (recording.remoteActive) {
    return { active: true, startedAt: recording.remoteStartedAt ?? null, byName: recording.remoteByName ?? null };
  }
  return { active: false, startedAt: null, byName: null };
}
