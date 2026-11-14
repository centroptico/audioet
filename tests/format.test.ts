import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBilledMinutes, formatUsd } from "../lib/format";

describe("money formatting", () => {
  it("keeps tiny USD amounts visible with a Spanish comma", () => {
    assert.equal(formatUsd(0.000398), "US$0,000398");
    assert.equal(formatUsd(0.0123), "US$0,0123");
    assert.equal(formatUsd(0), "US$0,0000");
    assert.equal(formatUsd(0.1), "US$0,1000");
    assert.equal(formatUsd(1234.5), "US$1.234,5000");
  });

  it("turns billed seconds into minutes", () => {
    assert.equal(formatBilledMinutes(14.328), "0,2 min de audio");
    assert.equal(formatBilledMinutes(90), "1,5 min de audio");
    assert.equal(formatBilledMinutes(0), "0,0 min de audio");
  });
});
