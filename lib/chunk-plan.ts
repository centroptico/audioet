import { CHUNK_SECONDS, OVERLAP_SECONDS } from "./config";
import type { ChunkPlanItem } from "./types";

/**
 * Cover `durationSec` with fixed windows that overlap by `overlapSeconds`.
 * The overlap is what lets us drop repeated words where two transcripts meet.
 * Seeking is keyframe-based, so a few seconds of overlap also covers a late
 * or early cut without leaving a gap.
 */
export function planChunks(
  durationSec: number,
  chunkSeconds = CHUNK_SECONDS,
  overlapSeconds = OVERLAP_SECONDS,
): ChunkPlanItem[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const chunk = Math.max(1, chunkSeconds);
  const overlap = Math.min(Math.max(0, overlapSeconds), chunk - 1);
  if (durationSec <= chunk) {
    return [{ index: 0, start: 0, duration: durationSec }];
  }

  const step = chunk - overlap;
  const items: ChunkPlanItem[] = [];
  let start = 0;
  let index = 0;
  while (start < durationSec - 0.05 && index < 10_000) {
    const duration = Math.min(chunk, durationSec - start);
    items.push({ index, start, duration });
    if (start + duration >= durationSec - 0.05) break;
    start += step;
    index += 1;
  }
  return items;
}

/** Byte estimate for a constant-bitrate slice. `bitrate` is like "32k". */
export function estimateChunkBytes(durationSec: number, bitrate = "32k"): number {
  const kbps = Number.parseInt(bitrate, 10);
  if (!Number.isFinite(kbps) || kbps <= 0) return 0;
  return Math.ceil((durationSec * kbps * 1000) / 8);
}
