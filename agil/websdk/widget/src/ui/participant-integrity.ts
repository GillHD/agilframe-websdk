/**
 * Participant integrity normalisation (C-04/C-02 robustness).
 *
 * `Participant.integrity` is optional on the wire: a real server sends
 * `integrity: 'unknown'`, but older/synthetic payloads (and the QA harness)
 * omit the field entirely. The tile renderer used to fall through to the
 * “possible media spoofing” branch for anything that was not `'verified'`, so a
 * missing field painted a red warning triangle on every participant — the
 * abnormal state that made the v3 screenshots useless as evidence.
 *
 * The rule is simple and total: only an explicit `'suspicious'` is suspicious.
 * Everything unknown, missing, `null` or malformed is `'unknown'` and renders
 * nothing at all.
 */
import type { ParticipantIntegrity } from '@agil/protocol';

const INTEGRITY_VALUES: readonly ParticipantIntegrity[] = ['unknown', 'verified', 'suspicious'];

/** Map any incoming value onto the closed `ParticipantIntegrity` enum. */
export function normalizeIntegrity(value: unknown): ParticipantIntegrity {
  return INTEGRITY_VALUES.includes(value as ParticipantIntegrity) ? (value as ParticipantIntegrity) : 'unknown';
}

/**
 * Which badge (if any) a tile should show for a participant.
 *
 * - `verified`  — the participant's identity was verified (user-check icon)
 *                 or its media integrity was verified (shield icon).
 * - `suspicious`— an explicit integrity warning arrived from the server.
 * - `none`      — unknown/missing: no badge, no colour, no alarm.
 */
export type IntegrityBadge = 'verified' | 'suspicious' | 'none';

export function integrityBadge(integrity: unknown, participantVerified: boolean): IntegrityBadge {
  if (participantVerified) return 'verified';
  const normalized = normalizeIntegrity(integrity);
  if (normalized === 'verified') return 'verified';
  if (normalized === 'suspicious') return 'suspicious';
  return 'none';
}
