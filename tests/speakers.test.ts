import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SPEAKER_MODEL } from "../lib/config";
import { buildSpeakerRequest, unifySpeakers } from "../lib/speakers";

describe("speaker unification request", () => {
  it("calls the verified Grok chat model and asks for usage cost", async () => {
    const built = buildSpeakerRequest({
      apiKey: "sk-or-v1-test-secret-value",
      chunkCount: 1,
      excerpts: [{ index: 0, speakers: [{ label: "Speaker 1", first: "soy Ana", last: "soy Ana", hints: ["soy Ana"] }] }],
    });
    const body = (await new Request(built.url, built.init).json()) as {
      model?: string;
      usage?: { include?: boolean };
      messages?: unknown[];
    };
    assert.equal(body.model, SPEAKER_MODEL);
    assert.equal(SPEAKER_MODEL, "x-ai/grok-4.3");
    assert.equal(body.usage?.include, true);
    assert.equal(JSON.stringify(body).includes("sk-or-v1-test-secret-value"), false);
    assert.equal(body.messages?.length, 2);
  });

  it("reads the mapping and its cost", async () => {
    const result = await unifySpeakers({
      apiKey: "sk-or-v1-test-secret-value",
      chunkCount: 1,
      excerpts: [],
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"chunks":[{"Speaker 1":"Ana"}]}' } }],
            usage: { cost: 0.0002 },
          }),
          { status: 200 },
        ),
    });
    assert.deepEqual(result.maps, [{ "Speaker 1": "Ana" }]);
    assert.equal(result.cost, 0.0002);
    assert.equal(result.costKnown, true);
  });
});
