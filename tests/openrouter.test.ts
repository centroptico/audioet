import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OPENROUTER_MODEL, OPENROUTER_URL, UPSTREAM_MODE } from "../lib/config";
import {
  buildUpstreamRequest,
  OpenRouterError,
  parseUpstreamError,
  readUsage,
  redactSecret,
  transcribeWithOpenRouter,
} from "../lib/openrouter";

const bytes = new Uint8Array([1, 2, 3, 4, 255]);
const secret = "sk-or-v1-test-secret-value";

describe("OpenRouter request shape", () => {
  it("defaults to the documented JSON shape", () => {
    assert.equal(UPSTREAM_MODE, "json");
  });

  it("sends documented JSON without a data URI, language, or the API key in the body", async () => {
    const built = buildUpstreamRequest({
      apiKey: secret,
      bytes,
      format: "mp3",
      siteUrl: "https://audioet.example",
      mode: "json",
    });
    const request = new Request(built.url, built.init);
    assert.equal(request.url, OPENROUTER_URL);
    assert.equal(request.headers.get("authorization"), `Bearer ${secret}`);
    assert.equal(request.headers.get("x-title"), "Audioet");
    const body = (await request.json()) as {
      model?: string;
      language?: string;
      response_format?: string;
      input_audio?: { data?: string; format?: string };
    };
    assert.equal(body.model, OPENROUTER_MODEL);
    assert.equal(body.language, undefined);
    assert.equal(body.response_format, undefined);
    assert.equal(body.input_audio?.format, "mp3");
    assert.equal(body.input_audio?.data, Buffer.from(bytes).toString("base64"));
    assert.equal(body.input_audio?.data?.startsWith("data:"), false);
    assert.equal(JSON.stringify(body).includes(secret), false);
  });

  it("sends verbose JSON for timestamps and diarizes Grok only through provider options", async () => {
    const grok = buildUpstreamRequest({
      apiKey: secret,
      bytes,
      format: "mp3",
      job: { speakers: true, timestamps: true, model: "grok" },
    });
    const grokBody = (await new Request(grok.url, grok.init).json()) as {
      model?: string;
      language?: string;
      diarize?: boolean;
      response_format?: string;
      provider?: { options?: { xai?: { diarize?: boolean } } };
    };
    assert.equal(grokBody.model, "x-ai/grok-stt-2.0");
    assert.equal(grokBody.language, undefined);
    assert.equal(grokBody.diarize, undefined);
    assert.equal(grokBody.response_format, "verbose_json");
    assert.equal(grokBody.provider?.options?.xai?.diarize, true);

    const microsoft = buildUpstreamRequest({
      apiKey: secret,
      bytes,
      format: "mp3",
      job: { speakers: true, timestamps: false, model: "microsoft" },
    });
    const microsoftBody = (await new Request(microsoft.url, microsoft.init).json()) as {
      model?: string;
      diarize?: boolean;
      provider?: unknown;
    };
    assert.equal(microsoftBody.model, "microsoft/mai-transcribe-2");
    assert.equal(microsoftBody.diarize, true);
    assert.equal(microsoftBody.provider, undefined);

    const timed = buildUpstreamRequest({
      apiKey: secret,
      bytes,
      format: "mp3",
      job: { speakers: false, timestamps: true, model: "grok" },
    });
    const timedBody = (await new Request(timed.url, timed.init).json()) as { diarize?: boolean; provider?: unknown };
    assert.equal(timedBody.diarize, undefined);
    assert.equal(timedBody.provider, undefined);
  });

  it("can switch to multipart without forcing a language", async () => {
    const built = buildUpstreamRequest({
      apiKey: secret,
      bytes,
      format: "m4a",
      mode: "multipart",
    });
    const request = new Request(built.url, built.init);
    const form = await request.formData();
    assert.equal(form.get("model"), OPENROUTER_MODEL);
    assert.equal(form.get("language"), null);
    const file = form.get("file");
    assert.ok(file instanceof File);
    assert.equal(file.name, "audio.m4a");
    assert.equal(file.size, bytes.byteLength);
  });

  it("returns text, cost and seconds, and a missing cost counts as unknown", async () => {
    const priced = await transcribeWithOpenRouter({
      apiKey: secret,
      bytes,
      format: "mp3",
      mode: "json",
      fetchImpl: async () =>
        new Response(JSON.stringify({ text: "hola", usage: { seconds: 14.328, cost: 0.000398 } }), {
          status: 200,
        }),
    });
    assert.deepEqual(priced, {
      text: "hola",
      cost: 0.000398,
      seconds: 14.328,
      costKnown: true,
      words: [],
      segments: [],
    });

    const missing = await transcribeWithOpenRouter({
      apiKey: secret,
      bytes,
      format: "ogg",
      mode: "json",
      fetchImpl: async () =>
        new Response(JSON.stringify({ text: "buenos días", usage: { seconds: 1 } }), { status: 200 }),
    });
    assert.equal(missing.text, "buenos días");
    assert.equal(missing.cost, 0);
    assert.equal(missing.seconds, 1);
    assert.equal(missing.costKnown, false);
    assert.deepEqual(readUsage({}), { cost: 0, seconds: 0, costKnown: false });

    await assert.rejects(
      () =>
        transcribeWithOpenRouter({
          apiKey: secret,
          bytes,
          format: "mp3",
          fetchImpl: async () =>
            new Response(JSON.stringify({ error: { message: `bad key ${secret}`, code: 400 } }), {
              status: 400,
            }),
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /bad key \[clave\]/);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error instanceof OpenRouterError && error.usage, undefined);
        return true;
      },
    );

    await assert.rejects(
      () =>
        transcribeWithOpenRouter({
          apiKey: secret,
          bytes,
          format: "mp3",
          fetchImpl: async () =>
            new Response(
              JSON.stringify({ error: { message: "rate" }, usage: { cost: 0.002, seconds: 3 } }),
              { status: 429 },
            ),
        }),
      (error: unknown) => {
        assert.ok(error instanceof OpenRouterError);
        assert.equal(error.status, 429);
        assert.deepEqual(error.usage, { cost: 0.002, seconds: 3, costKnown: true });
        return true;
      },
    );
  });

  it("turns an upstream timeout into an error the client can split", async () => {
    await assert.rejects(
      () =>
        transcribeWithOpenRouter({
          apiKey: secret,
          bytes,
          format: "mp3",
          fetchImpl: async () => {
            const error = new Error("timed out");
            error.name = "TimeoutError";
            throw error;
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { status?: number }).status, 504);
        assert.match(error.message, /no respondió a tiempo/i);
        return true;
      },
    );
  });
});

describe("parseUpstreamError", () => {
  it("redacts the key from plain and JSON bodies", () => {
    assert.equal(redactSecret(`token ${secret}`, secret), "token [clave]");
    assert.match(parseUpstreamError(502, "provider down", secret), /provider down/);
    assert.match(parseUpstreamError(500, "", secret), /500/);
  });
});
