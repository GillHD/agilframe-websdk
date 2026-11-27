/**
 * Server-issued liveness challenge contract (best-effort, not certified).
 *
 * The server issues a random task bound to one tenant + room + participant; the
 * browser reports only signals (booleans and a confidence), never frames. The
 * verdict is advisory, not a deepfake proof. `livenessTasks` must stay in sync
 * with `LIVENESS_TASKS` in `@agil/security`.
 */
import { z } from 'zod';

export const livenessTasks = ['blink', 'head-left', 'head-right'] as const;

export type LivenessTask = (typeof livenessTasks)[number];

/** Client-reported evidence for one challenge attempt (all fields optional). */
export const livenessSignalsSchema = z.object({
  /** A face was found in the self-view during the challenge. */
  faceDetected: z.boolean().optional(),
  /** The requested blink was observed (either eye, MediaPipe blendshapes). */
  blinkDetected: z.boolean().optional(),
  /** The requested head turn was observed. */
  headTurnDetected: z.boolean().optional(),
  /** False when the face-landmarker model could not be loaded. */
  modelAvailable: z.boolean().optional(),
  /** Confidence of the local detector, 0..1 (never trusted as proof). */
  confidence: z.number().min(0).max(1).optional(),
  /** Frames analysed by the browser during the attempt. */
  framesAnalyzed: z.number().int().min(0).max(100_000).optional(),
  /** Wall-clock duration of the attempt. */
  durationMs: z.number().int().min(0).max(600_000).optional(),
});

export type LivenessSignals = z.infer<typeof livenessSignalsSchema>;

export const livenessVerifyRequestSchema = z.object({
  signals: livenessSignalsSchema,
});

export type LivenessVerifyRequest = z.infer<typeof livenessVerifyRequestSchema>;

/** `POST /v1/rooms/:roomId/liveness/challenge` response. */
export interface LivenessChallengeResponse {
  sessionId: string;
  task: LivenessTask;
  issuedAt: number;
  expiresAt: number;
  ttlSec: number;
  /** Engine that issued the challenge (`challenge` = built-in free engine). */
  engine: string;
  /** Always true: the verdict is advisory, never a legal certification. */
  advisory: true;
}

export type LivenessVerifyStatus = 'verified' | 'failed' | 'unavailable' | 'expired' | 'invalid';

/** `POST /v1/rooms/:roomId/liveness/:sessionId/verify` response. */
export interface LivenessVerifyResponse {
  sessionId: string;
  passed: boolean;
  status: LivenessVerifyStatus;
  /** Risk-style score, 0..1 (0 = no concern, 1 = challenge clearly failed). */
  score: number;
  flags: string[];
  engine: string;
  attempts: number;
  maxAttempts: number;
  advisory: true;
}
