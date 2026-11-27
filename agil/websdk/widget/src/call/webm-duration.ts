/**
 * Best-effort WebM duration metadata.
 *
 * Chrome's `MediaRecorder` writes a streaming WebM: Segment/Cluster sizes are
 * "unknown" and the Segment Info element has no `Duration` (0x4489), so
 * `ffprobe` reports `Duration: N/A` and some players cannot seek until the file
 * is re-indexed. The pilot P3 finding asks for duration metadata "if feasible".
 *
 * This module rewrites only the Info element: it appends a `Duration` float in
 * Segment ticks (`durationSec * 1e9 / TimecodeScale`) and fixes the Info size.
 * The streaming Segment size stays "unknown", so no cluster offsets need to be
 * rewritten. The operation is intentionally conservative — anything unexpected
 * (known-size Segment, SeekHead/Cues, unknown Info size) returns the original
 * blob unchanged rather than risking a corrupt recording.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_CUES = 0x1c53bb6b;
const ID_CRC32 = 0xbf;

const DEFAULT_TIMECODE_SCALE = 1_000_000; // nanoseconds per Segment tick (1 ms)

interface Vint {
  length: number;
  value: number;
  unknown: boolean;
}

interface ElementHeader {
  id: number;
  idLength: number;
  size: number;
  sizeLength: number;
  unknown: boolean;
  headerLength: number;
  dataOffset: number;
}

function readVint(buf: Uint8Array, offset: number): Vint | null {
  if (offset >= buf.length) return null;
  const first = buf[offset] as number;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > buf.length) return null;
  let value = BigInt(first & (mask - 1));
  for (let index = 1; index < length; index += 1) {
    value = (value << 8n) | BigInt(buf[offset + index] as number);
  }
  const max = (1n << BigInt(7 * length)) - 1n;
  return {
    length,
    value: value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value),
    unknown: value === max,
  };
}

function readId(buf: Uint8Array, offset: number): { id: number; length: number } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset] as number;
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 4 || offset + length > buf.length) return null;
  let id = 0;
  for (let index = 0; index < length; index += 1) id = id * 256 + (buf[offset + index] as number);
  return { id, length };
}

function readElementHeader(buf: Uint8Array, offset: number): ElementHeader | null {
  const id = readId(buf, offset);
  if (!id) return null;
  const size = readVint(buf, offset + id.length);
  if (!size) return null;
  const headerLength = id.length + size.length;
  return {
    id: id.id,
    idLength: id.length,
    size: size.value,
    sizeLength: size.length,
    unknown: size.unknown,
    headerLength,
    dataOffset: offset + headerLength,
  };
}

function encodeSize(value: number, preferredLength?: number): Uint8Array | null {
  for (let length = preferredLength ?? 1; length <= 8; length += 1) {
    if (preferredLength && length !== preferredLength) return null;
    const max = 2 ** (7 * length) - 2; // all-ones is the "unknown size" marker
    if (value > max) continue;
    const bytes = new Uint8Array(length);
    let remaining = BigInt(value);
    for (let index = length - 1; index >= 0; index -= 1) {
      bytes[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    bytes[0] = (bytes[0] as number) | (1 << (8 - length));
    return bytes;
  }
  return null;
}

function readUnsigned(buf: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let index = 0; index < length; index += 1) value = value * 256 + (buf[offset + index] as number);
  return value;
}

function readFloat(buf: Uint8Array, offset: number, length: number): number | null {
  if (length !== 4 && length !== 8) return null;
  const view = new DataView(buf.buffer, buf.byteOffset + offset, length);
  return length === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
}

function writeFloat(value: number, length: 8 | 4): Uint8Array {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  if (length === 8) view.setFloat64(0, value, false);
  else view.setFloat32(0, value, false);
  return bytes;
}

function durationElement(value: number): Uint8Array {
  return new Uint8Array([0x44, 0x89, 0x88, ...writeFloat(value, 8)]);
}

/** Parses the Segment Info children needed for a duration patch. */
function findSegmentInfo(buf: Uint8Array): {
  segment: ElementHeader;
  info: ElementHeader;
  timecodeScale: number;
  duration: { offset: number; length: number; value: number } | null;
} | null {
  let offset = 0;
  const first = readElementHeader(buf, 0);
  if (!first || first.id !== ID_EBML || first.unknown) return null;
  offset = first.dataOffset + first.size;
  const segment = readElementHeader(buf, offset);
  if (!segment || segment.id !== ID_SEGMENT) return null;
  // A known-size Segment would need its own size rewritten when the Info grows;
  // Chrome/Firefox streaming output uses "unknown", so bail out instead.
  if (!segment.unknown) return null;

  const segmentEnd = buf.length;
  let childOffset = segment.dataOffset;
  while (childOffset < segmentEnd) {
    const child = readElementHeader(buf, childOffset);
    if (!child) return null;
    if (child.id === ID_INFO) {
      if (child.unknown) return null;
      const infoEnd = child.dataOffset + child.size;
      if (infoEnd > buf.length) return null;
      let timecodeScale = DEFAULT_TIMECODE_SCALE;
      let duration: { offset: number; length: number; value: number } | null = null;
      let fieldOffset = child.dataOffset;
      while (fieldOffset < infoEnd) {
        const field = readElementHeader(buf, fieldOffset);
        if (!field || field.unknown) return null;
        // An Info-level CRC would no longer match after appending Duration.
        if (field.id === ID_CRC32) return null;
        const fieldEnd = field.dataOffset + field.size;
        if (fieldEnd > infoEnd) return null;
        if (field.id === ID_TIMECODE_SCALE) {
          const value = readUnsigned(buf, field.dataOffset, field.size);
          if (value > 0) timecodeScale = value;
        } else if (field.id === ID_DURATION) {
          const value = readFloat(buf, field.dataOffset, field.size);
          if (value !== null) duration = { offset: field.dataOffset, length: field.size, value };
        }
        fieldOffset = fieldEnd;
      }
      return { segment, info: child, timecodeScale, duration };
    }
    // SeekHead/Cues hold absolute offsets into the stream; inserting bytes
    // inside Segment before them would invalidate those offsets. A Segment CRC
    // would also stop matching.
    if (child.id === ID_SEEK_HEAD || child.id === ID_CUES || child.id === ID_CRC32 || child.unknown) return null;
    childOffset = child.dataOffset + child.size;
  }
  return null;
}

/**
 * Returns a copy of `blob` with a WebM `Duration` element, or the original blob
 * when the metadata cannot be added safely.
 */
export async function withWebmDuration(blob: Blob, durationSec: number): Promise<Blob> {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return blob;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch {
    return blob;
  }
  const found = findSegmentInfo(bytes);
  if (!found) return blob;
  const { info, timecodeScale } = found;
  const ticks = (durationSec * 1_000_000_000) / timecodeScale;
  if (!Number.isFinite(ticks) || ticks <= 0) return blob;

  // Already carries a usable duration: rewrite it in place (no size change).
  if (found.duration) {
    if (Math.abs(found.duration.value - ticks) < 1) return blob;
    const encoded = writeFloat(ticks, found.duration.length === 4 ? 4 : 8);
    const patched = new Uint8Array(bytes);
    patched.set(encoded, found.duration.offset);
    return new Blob([patched], { type: blob.type });
  }

  const infoSize = info.size;
  const duration = durationElement(ticks);
  const newInfoSize = infoSize + duration.length;
  // Keep the original Info header width when it can still hold the new size
  // (Chrome's 1-byte 0x99 always can); otherwise grow the header.
  let newInfoSizeBytes = encodeSize(newInfoSize, info.sizeLength);
  if (!newInfoSizeBytes) newInfoSizeBytes = encodeSize(newInfoSize);
  if (!newInfoSizeBytes) return blob;

  const infoHeader = bytes.subarray(info.dataOffset - info.headerLength, info.dataOffset);
  const infoId = infoHeader.subarray(0, info.idLength);
  const prefix = bytes.subarray(0, info.dataOffset - info.headerLength);
  const infoData = bytes.subarray(info.dataOffset, info.dataOffset + infoSize);
  const suffix = bytes.subarray(info.dataOffset + infoSize);
  const out = new Uint8Array(prefix.length + infoId.length + newInfoSizeBytes.length + infoData.length + duration.length + suffix.length);
  let cursor = 0;
  out.set(prefix, cursor);
  cursor += prefix.length;
  out.set(infoId, cursor);
  cursor += infoId.length;
  out.set(newInfoSizeBytes, cursor);
  cursor += newInfoSizeBytes.length;
  out.set(infoData, cursor);
  cursor += infoData.length;
  out.set(duration, cursor);
  cursor += duration.length;
  out.set(suffix, cursor);
  return new Blob([out], { type: blob.type });
}

/** Reads the Segment Info `Duration` in seconds (tests/diagnostics). */
export function readWebmDuration(bytes: Uint8Array): number | null {
  const found = findSegmentInfo(bytes);
  if (!found?.duration) return null;
  return (found.duration.value * found.timecodeScale) / 1_000_000_000;
}
