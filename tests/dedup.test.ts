import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { joinTranscripts, mergeTranscripts } from "../lib/dedup";

describe("mergeTranscripts", () => {
  it("drops a repeated boundary of at least four words", () => {
    const merged = mergeTranscripts(
      "hoy vamos a hablar de la casa de maría y del jardín",
      "de la casa de maría y del jardín que está detrás",
    );
    assert.equal(merged, "hoy vamos a hablar de la casa de maría y del jardín que está detrás");
  });

  it("ignores case and edge punctuation", () => {
    const merged = mergeTranscripts(
      "el perro grande corre por el parque",
      "corre por el parque, hasta la plaza",
    );
    assert.equal(merged, "el perro grande corre por el parque hasta la plaza");
  });

  it("does not treat two shared words as an overlap", () => {
    const merged = mergeTranscripts("nos vemos en la casa", "en la casa grande de al lado");
    assert.equal(merged, "nos vemos en la casa en la casa grande de al lado");
  });

  it("joins a list into continuous text", () => {
    const text = joinTranscripts([
      "uno dos tres cuatro cinco",
      "dos tres cuatro cinco seis siete",
      "",
    ]);
    assert.equal(text, "uno dos tres cuatro cinco seis siete");
  });
});
