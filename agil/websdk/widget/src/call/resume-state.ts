/**
 * Client-side live-call continuity state machine (docs/call-continuity.md).
 *
 * The widget owns three planes that can break independently:
 *   - the signaling WebSocket (presence, chat, SDP relay),
 *   - the media plane (mesh peer connections or the LiveKit/SFU session),
 *   - local tracks (camera/microphone), which must never be re-acquired for a
 *     short network blip (that would flash the camera light and duplicate
 *     `getUserMedia` permissions).
 *
 * This module is deliberately DOM-free and side-effect free so the reconnect
 * matrix can be unit-tested. `AgilWidgetSession` feeds it socket events and the
 * next `welcome` frame, then applies the returned decision:
 *
 *   socket close ──► reconnecting ──► (socket open) ──► restoring
 *        ▲                                              │
 *        │                                   welcome(resumed=true)
 *        │                                              ▼
 *        └──────────── retry budget exhausted ────── restored
 *
 * Key rule: a resume never rebuilds the mesh peers or restarts the SFU when the
 * server confirmed the same participant and the media plane is still healthy.
 * That is what keeps the tile/presence list free of duplicates.
 */
import type { ResumeStatus } from '../types.js';

export type { ResumeStatus } from '../types.js';

/** What caused the interruption (hosts get it in `connection-state` payloads). */
export type ResumeTrigger = 'socket-closed' | 'heartbeat-timeout' | 'manual';

/** The parts of a `welcome` frame the decision needs. */
export interface ResumeWelcomeInput {
  /** `welcome.resumed` — the server swapped this socket onto the old member. */
  resumed: boolean;
  /** The welcome carries a fresh SFU session (`welcome.media`). */
  hasSfuSession: boolean;
  /** The SFU engine still reports a live connection. */
  sfuConnected: boolean;
  /** Fresh `welcome.media.room` equals the live session's room. */
  sameSfuRoom: boolean;
  /** Existing mesh peers are still connected independently of the WebSocket. */
  meshConnected?: boolean;
}

export interface ResumeDecision {
  status: ResumeStatus;
  /** Server confirmed continuity (same participant, no re-join). */
  resumed: boolean;
  /** Do not tear down the current media plane. */
  keepMedia: boolean;
  /** (Re)start the SFU engine with the fresh session. */
  rejoinSfu: boolean;
  /** Drop and re-add mesh peers from the welcome participant list. */
  rebuildPeers: boolean;
  /** Local camera/mic tracks are preserved on every path. */
  keepLocalTracks: true;
  reason:
    | 'initial-join'
    | 'resume-restored'
    | 'resume-media-healthy'
    | 'resume-needs-sfu-rejoin'
    | 'resume-needs-peers'
    | 'resume-rejected'
    | 'not-interrupted';
}

const isInterrupted = (status: ResumeStatus): boolean =>
  status === 'reconnecting' || status === 'restoring' || status === 'restored' || status === 'failed';

export class ResumeStateMachine {
  private current: ResumeStatus = 'idle';
  private attemptCount = 0;
  private startedAt: number | null = null;
  private restoredAt: number | null = null;
  private lastFailure: string | null = null;
  /** A socket is open but its `welcome` has not been applied yet. */
  private awaitingWelcome = false;
  private trigger: ResumeTrigger | null = null;

  get status(): ResumeStatus {
    return this.current;
  }

  /** True while an automatic reconnect socket is awaiting its `welcome`. */
  get waitingForWelcome(): boolean {
    return this.awaitingWelcome;
  }

  get attempts(): number {
    return this.attemptCount;
  }

  get startedAtMs(): number | null {
    return this.startedAt;
  }

  get restoredAtMs(): number | null {
    return this.restoredAt;
  }

  get failure(): string | null {
    return this.lastFailure;
  }

  /** True once any interruption happened in this session (until `reset()`). */
  get interrupted(): boolean {
    return this.attemptCount > 0 || isInterrupted(this.current);
  }

  /** Socket dropped (or the heartbeat declared it dead). */
  beginAttempt(trigger: ResumeTrigger = 'socket-closed', now = Date.now()): ResumeStatus {
    if (this.current === 'idle') this.startedAt = now;
    this.trigger = trigger;
    this.attemptCount += 1;
    this.awaitingWelcome = true;
    this.restoredAt = null;
    this.lastFailure = null;
    this.current = 'reconnecting';
    return this.current;
  }

  /** A reconnect socket opened; the welcome has not arrived yet. */
  markSocketOpen(now = Date.now()): ResumeStatus {
    if (!this.awaitingWelcome) return this.current;
    if (this.startedAt === null) this.startedAt = now;
    this.current = 'restoring';
    return this.current;
  }

  /**
   * Applies the first frame after a reconnect. Returns the media/peer plan.
   * On an initial (non-reconnected) join the status stays `idle`.
   */
  applyWelcome(input: ResumeWelcomeInput, now = Date.now()): ResumeDecision {
    const wasInterrupted = this.awaitingWelcome || isInterrupted(this.current) || this.attemptCount > 0;
    this.awaitingWelcome = false;
    if (!wasInterrupted) {
      this.current = 'idle';
      return {
        status: 'idle',
        resumed: input.resumed,
        keepMedia: true,
        rejoinSfu: false,
        rebuildPeers: false,
        keepLocalTracks: true,
        reason: 'initial-join',
      };
    }
    if (!input.resumed) {
      // The server could not match the resume capability (grace expired, token
      // rotated away, Core lost the room). The call continues as a fresh join.
      this.current = 'failed';
      this.lastFailure = 'resume_rejected';
      return {
        status: 'failed',
        resumed: false,
        keepMedia: false,
        rejoinSfu: input.hasSfuSession,
        rebuildPeers: true,
        keepLocalTracks: true,
        reason: 'resume-rejected',
      };
    }
    this.current = 'restored';
    this.restoredAt = now;
    if (input.hasSfuSession) {
      if (input.sfuConnected && input.sameSfuRoom) {
        // LiveKit kept the same room: no rejoin, no duplicate publications.
        return {
          status: 'restored',
          resumed: true,
          keepMedia: true,
          rejoinSfu: false,
          rebuildPeers: false,
          keepLocalTracks: true,
          reason: 'resume-media-healthy',
        };
      }
      return {
        status: 'restored',
        resumed: true,
        keepMedia: false,
        rejoinSfu: true,
        rebuildPeers: false,
        keepLocalTracks: true,
        reason: 'resume-needs-sfu-rejoin',
      };
    }
    if (input.meshConnected) {
      return {
        status: 'restored',
        resumed: true,
        keepMedia: true,
        rejoinSfu: false,
        rebuildPeers: false,
        keepLocalTracks: true,
        reason: 'resume-media-healthy',
      };
    }
    // Rebuild when no connected mesh peer can be preserved.
    return {
      status: 'restored',
      resumed: true,
      keepMedia: false,
      rejoinSfu: false,
      rebuildPeers: true,
      keepLocalTracks: true,
      reason: 'resume-needs-peers',
    };
  }

  /** Reconnect budget exhausted (or a fatal handshake error). */
  fail(reason: string): ResumeStatus {
    this.awaitingWelcome = false;
    this.lastFailure = reason;
    this.current = 'failed';
    return this.current;
  }

  /** The "restored" toast/pill has been shown long enough; back to idle. */
  settle(): ResumeStatus {
    if (this.current === 'restored') this.current = 'idle';
    return this.current;
  }

  /** New call session (leave/destroy): forget every attempt. */
  reset(): void {
    this.current = 'idle';
    this.attemptCount = 0;
    this.startedAt = null;
    this.restoredAt = null;
    this.lastFailure = null;
    this.awaitingWelcome = false;
    this.trigger = null;
  }

  snapshot(): {
    status: ResumeStatus;
    attempts: number;
    interrupted: boolean;
    trigger: ResumeTrigger | null;
    startedAt: number | null;
    restoredAt: number | null;
    failure: string | null;
  } {
    return {
      status: this.current,
      attempts: this.attemptCount,
      interrupted: this.interrupted,
      trigger: this.trigger,
      startedAt: this.startedAt,
      restoredAt: this.restoredAt,
      failure: this.lastFailure,
    };
  }
}
