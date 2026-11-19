import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTimestamp, renderTranscript, type TimedWord } from "../lib/transcript-format";

const talk: TimedWord[] = [
  { word: "Hola,", start: 0.2, end: 0.5, speaker: 0 },
  { word: "soy", start: 0.6, end: 0.8, speaker: 0 },
  { word: "Ana.", start: 0.9, end: 1.2, speaker: 0 },
  { word: "¿Vienes?", start: 1.4, end: 1.8, speaker: 0 },
  { word: "Sí,", start: 2.2, end: 2.4, speaker: 1 },
  { word: "Ana.", start: 2.5, end: 2.9, speaker: 1 },
];

describe("renderTranscript", () => {
  it("formats absolute timestamps as hh:mm:ss", () => {
    assert.equal(formatTimestamp(0), "[00:00:00]");
    assert.equal(formatTimestamp(61), "[00:01:01]");
    assert.equal(formatTimestamp(3661.9), "[01:01:01]");
  });

  it("writes paragraphs, not one line per word", () => {
    const text = renderTranscript({
      words: talk,
      offset: 0,
      dropBefore: 0,
      speakers: true,
      timestamps: true,
    });
    assert.equal(
      text,
      ["[00:00:00] Speaker 1: Hola, soy Ana. ¿Vienes?", "", "[00:00:02] Speaker 2: Sí, Ana."].join("\n"),
    );
    assert.equal(text.split("\n").filter((line) => line.trim()).length, 2);
  });

  it("puts one timestamp on each sentence when nobody is identified", () => {
    const text = renderTranscript({
      words: talk.map(({ word, start, end }) => ({ word, start, end })),
      offset: 0,
      dropBefore: 0,
      speakers: false,
      timestamps: true,
    });
    assert.match(text, /^\[00:00:00\] Hola, soy Ana\./);
    assert.match(text, /\[00:00:01\] ¿Vienes\?/);
    assert.equal(text.includes("Speaker"), false);
  });

  it("drops the overlap and keeps the clock in the full recording", () => {
    const words: TimedWord[] = [
      { word: "Ana.", start: 4.2, end: 4.6, speaker: 0 },
      { word: "Seguimos", start: 6.1, end: 6.6, speaker: 0 },
      { word: "mañana.", start: 6.7, end: 7.2, speaker: 0 },
    ];
    const text = renderTranscript({
      words,
      offset: 595,
      dropBefore: 600,
      speakers: true,
      timestamps: true,
    });
    assert.equal(text.includes("Ana."), false);
    assert.equal(text, "[00:10:01] Speaker 1: Seguimos mañana.");
  });
});
