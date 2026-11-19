import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySpeakerMap,
  excerptsFromChunks,
  parseSpeakerContent,
} from "../lib/speaker-map";

const chunk = [
  "[00:00:01] Speaker 1: Hola, soy Ana. ¿Cómo estás?",
  "",
  "[00:00:08] Speaker 2: Bien, Ana. Yo soy Luis.",
].join("\n");

describe("speaker maps", () => {
  it("keeps a compact excerpt with the line that reveals a name", () => {
    const excerpts = excerptsFromChunks([{ index: 0, text: chunk }]);
    assert.equal(excerpts.length, 1);
    assert.equal(excerpts[0]?.speakers[0]?.label, "Speaker 1");
    assert.match(excerpts[0]?.speakers[0]?.hints[0] ?? "", /soy Ana/);
    assert.match(excerpts[0]?.speakers[1]?.hints[0] ?? "", /soy Luis/);
  });

  it("renames only the label and rejects a rewrite of the speech", () => {
    const mapped = applySpeakerMap(chunk, { "Speaker 1": "Ana", "Speaker 2": "Luis" });
    assert.match(mapped, /\[00:00:01\] Ana: Hola, soy Ana\./);
    assert.match(mapped, /\[00:00:08\] Luis: Bien, Ana\. Yo soy Luis\./);
    assert.equal(mapped.includes("Speaker"), false);
    const longer = applySpeakerMap("Speaker 1: uno\n\nSpeaker 10: diez", { "Speaker 1": "Ana" });
    assert.equal(longer, "Ana: uno\n\nSpeaker 10: diez");

    const parsed = parseSpeakerContent(
      '```json\n{"chunks":[{"Speaker 1":"Ana","Speaker 2":"esto no es un nombre porque es una frase larga"},{"Speaker 1":"Speaker 1"}]}\n```',
      2,
    );
    assert.equal(parsed?.[0]?.["Speaker 2"], undefined);
    assert.deepEqual(parsed?.[0], { "Speaker 1": "Ana" });
    assert.deepEqual(parsed?.[1], { "Speaker 1": "Speaker 1" });
  });
});
