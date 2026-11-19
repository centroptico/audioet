import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateChunkBytes, planChunks } from "../lib/chunk-plan";
import { CHUNK_SECONDS, MAX_CHUNK_BYTES } from "../lib/config";

describe("planChunks", () => {
  it("returns nothing for empty durations", () => {
    assert.deepEqual(planChunks(0), []);
    assert.deepEqual(planChunks(-5), []);
    assert.deepEqual(planChunks(Number.NaN), []);
  });

  it("keeps a short note as a single slice", () => {
    assert.deepEqual(planChunks(12.5), [{ index: 0, start: 0, duration: 12.5 }]);
    assert.deepEqual(planChunks(CHUNK_SECONDS), [{ index: 0, start: 0, duration: CHUNK_SECONDS }]);
  });

  it("covers three hours with overlapping slices under 4 MB", () => {
    const duration = 3 * 60 * 60;
    const plan = planChunks(duration);
    assert.equal(plan.length, 19);
    let covered = 0;
    for (const slice of plan) {
      assert.ok(slice.start <= covered + 1e-6);
      assert.ok(slice.duration > 0);
      assert.ok(slice.duration <= CHUNK_SECONDS + 1e-6);
      const bytes = estimateChunkBytes(slice.duration, "32k");
      assert.ok(bytes < 4_000_000, `slice ${slice.index} estimates ${bytes} bytes`);
      assert.ok(bytes <= MAX_CHUNK_BYTES);
      covered = Math.max(covered, slice.start + slice.duration);
    }
    assert.ok(covered >= duration - 1e-6);
    assert.equal(estimateChunkBytes(600, "32k"), 2_400_000);
  });
});
