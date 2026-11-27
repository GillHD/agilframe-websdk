/**
 * Reaction input normalization (shared by the default UI and headless hosts).
 *
 * Reactions are opaque short strings (emoji or a short emoticon) sent over the
 * signaling socket and rendered as text; this module only enforces length and
 * rejects control characters so a host button cannot flood the room.
 */
export const MAX_REACTION_LENGTH = 16;

export function normalizeReaction(emoji: unknown): string | null {
  if (typeof emoji !== 'string') return null;
  const trimmed = emoji.trim();
  if (!trimmed || trimmed.length > MAX_REACTION_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}
