import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { POST } from "../app/api/transcribe/route";
import { API_MAX_BYTES } from "../lib/config";

const secret = "sk-or-v1-route-secret-987654";
const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

function audioRequest(options?: { origin?: string; format?: string; bytes?: Uint8Array; host?: string }) {
  const form = new FormData();
  const payload = options?.bytes ?? new Uint8Array([9, 8, 7, 6]);
  const copy = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
  form.append("file", new File([copy], "fragmento.mp3", { type: "audio/mpeg" }));
  form.append("format", options?.format ?? "mp3");
  const headers = new Headers();
  if (options?.origin) headers.set("origin", options.origin);
  if (options?.host) headers.set("host", options.host);
  return new Request("http://localhost/api/transcribe", { method: "POST", body: form, headers });
}

describe("POST /api/transcribe", () => {
  it("refuses other websites and a missing key without calling OpenRouter", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response("nope");
    };
    process.env.OPENROUTER_API_KEY = secret;

    const forbidden = await POST(audioRequest({ origin: "https://evil.example" }));
    assert.equal(forbidden.status, 403);
    assert.equal(called, false);

    delete process.env.OPENROUTER_API_KEY;
    const missing = await POST(audioRequest());
    const missingBody = (await missing.json()) as { error?: string };
    assert.equal(missing.status, 422);
    assert.match(missingBody.error ?? "", /OPENROUTER_API_KEY/);
    assert.equal(called, false);
  });

  it("forwards a small slice and returns only the transcript", async () => {
    process.env.OPENROUTER_API_KEY = secret;
    const logs: unknown[][] = [];
    const log = console.log;
    const errorLog = console.error;
    console.log = (...args: unknown[]) => logs.push(args);
    console.error = (...args: unknown[]) => logs.push(args);
    let upstreamBody = "";
    globalThis.fetch = async (_url, init) => {
      upstreamBody = String(init?.body ?? "");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${secret}`);
      return new Response(JSON.stringify({ text: "texto listo", usage: { cost: 0.1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const response = await POST(audioRequest({ origin: "http://localhost" }));
      const body = (await response.json()) as { text?: string; usage?: unknown; error?: string };
      assert.equal(response.status, 200);
      assert.deepEqual(body, { text: "texto listo" });
      assert.equal(upstreamBody.includes(secret), false);
      assert.equal(JSON.stringify(logs).includes(secret), false);
    } finally {
      console.log = log;
      console.error = errorLog;
    }
  });

  it("shows the upstream error and rejects an oversized slice", async () => {
    process.env.OPENROUTER_API_KEY = secret;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: `clave ${secret} rechazada`, code: 401 } }), {
        status: 401,
      });
    const failed = await POST(audioRequest());
    const failedBody = (await failed.json()) as { error?: string };
    assert.equal(failed.status, 401);
    assert.match(failedBody.error ?? "", /OpenRouter: clave \[clave\] rechazada/);
    assert.equal(failedBody.error?.includes(secret), false);

    globalThis.fetch = async () => {
      throw new Error("fetch should not run");
    };
    const oversized = await POST(audioRequest({ bytes: new Uint8Array(API_MAX_BYTES + 1) }));
    assert.equal(oversized.status, 413);

    const badFormat = await POST(audioRequest({ format: "exe" }));
    assert.equal(badFormat.status, 400);
  });
});
