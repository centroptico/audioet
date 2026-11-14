import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChunkArgs, ENCODER_PREFERENCE, parseDuration, pickEncoder } from "../lib/ffmpeg-args";

const ENCODER_LIST = `
Encoders:
 V..... libx264              libx264 H.264
 A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3)
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libopus              libopus Opus
`;

describe("ffmpeg args", () => {
  it("prefers mp3, then aac, then opus", () => {
    assert.equal(pickEncoder(ENCODER_LIST)?.id, "libmp3lame");
    assert.equal(pickEncoder(ENCODER_LIST.replace("libmp3lame", "missing"))?.id, "aac");
    assert.equal(pickEncoder(" A....D libopus              libopus Opus")?.id, "libopus");
    assert.equal(pickEncoder(" A....D libfdk_aac           Fraunhofer"), null);
  });

  it("puts the fast seek before the input and requests mono 16 kHz", () => {
    const encoder = ENCODER_PREFERENCE[0];
    const args = buildChunkArgs("/input/input.m4a", "slice.mp3", 12.5, 600, encoder);
    assert.ok(args.indexOf("-ss") < args.indexOf("-i"));
    assert.ok(args.indexOf("-t") < args.indexOf("-i"));
    assert.equal(args[args.indexOf("-ss") + 1], "12.500");
    assert.equal(args[args.indexOf("-t") + 1], "600.000");
    assert.equal(args[args.indexOf("-ac") + 1], "1");
    assert.equal(args[args.indexOf("-ar") + 1], "16000");
    assert.ok(args.includes("libmp3lame"));
    assert.ok(args.includes("32k"));
    assert.equal(args.at(-1), "slice.mp3");
  });

  it("parses ffmpeg duration lines", () => {
    assert.equal(parseDuration("Duration: 01:02:03.50, start: 0.000000"), 3723.5);
    assert.equal(parseDuration("Duration: N/A"), null);
  });
});
