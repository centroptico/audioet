import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OPENROUTER_MODEL, OPENROUTER_URL, UPSTREAM_MODE } from "../lib/config";
import {
  buildUpstreamRequest,
  parseUpstreamError,
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

  it("returns text and surfaces the upstream message without the key", async () => {
    const text = await transcribeWithOpenRouter({
      apiKey: secret,
      bytes,
      format: "ogg",
      mode: "json",
      fetchImpl: async () =>
        new Response(JSON.stringify({ text: "buenos días", usage: { seconds: 1 } }), { status: 200 }),
    });
    assert.equal(text, "buenos días");

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
