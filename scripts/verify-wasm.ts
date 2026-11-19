import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import puppeteer from "puppeteer-core";
import { buildChunkArgs, pickEncoder } from "../lib/ffmpeg-args";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".m4a": "audio/mp4",
  ".json": "application/json",
};

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<script type="module">
const ffmpegModule = await import("/ffmpeg/esm/index.js");
const ffmpeg = new ffmpegModule.FFmpeg();
const logs = [];
ffmpeg.on("log", ({ message }) => logs.push(message));
try {
  await ffmpeg.load({
    coreURL: new URL("/ffmpeg/core/ffmpeg-core.js", location.href).href,
    wasmURL: new URL("/ffmpeg/core/ffmpeg-core.wasm", location.href).href,
  });
  window.__ffmpeg = ffmpeg;
  window.__logs = logs;
  window.__ready = true;
} catch (error) {
  window.__error = String(error && error.stack || error);
  window.__ready = true;
}
</script>`;

async function main() {
  await run("node", ["scripts/copy-ffmpeg.mjs"]);
  const root = await mkdtemp(join(tmpdir(), "audioet-wasm-"));
  const fixture = join(root, "voice.m4a");
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=44100:duration=20",
    "-ac",
    "2",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    fixture,
  ]);

  const publicDir = join(process.cwd(), "public");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/" || url.pathname === "/test.html") {
        response.writeHead(200, { "content-type": MIME[".html"] });
        response.end(PAGE);
        return;
      }
      if (url.pathname === "/fixture.m4a") {
        response.writeHead(200, { "content-type": MIME[".m4a"] });
        response.end(await readFile(fixture));
        return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (relative.includes("..")) {
        response.writeHead(403).end();
        return;
      }
      const file = normalize(join(publicDir, relative));
      if (!file.startsWith(publicDir)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const origin = `http://127.0.0.1:${address.port}`;

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    page.on("console", (message) => console.log("page:", message.text()));
    page.on("pageerror", (error) => console.error("page error:", error));
    await page.goto(`${origin}/test.html`, { waitUntil: "networkidle0", timeout: 120_000 });
    await page.waitForFunction("window.__ready === true");
    const loadError = await page.evaluate(() => (window as unknown as { __error?: string }).__error);
    if (loadError) throw new Error(loadError);

    const encoderLog = await page.evaluate(async () => {
      const ffmpeg = (window as unknown as { __ffmpeg: { exec: (args: string[]) => Promise<number> } }).__ffmpeg;
      const logs = (window as unknown as { __logs: string[] }).__logs;
      logs.length = 0;
      await ffmpeg.exec(["-hide_banner", "-encoders"]);
      return logs.join("\n");
    });
    const encoder = pickEncoder(encoderLog);
    if (!encoder) throw new Error(`wasm build is missing mp3/aac/opus encoders\n${encoderLog.slice(0, 500)}`);
    console.log(`wasm encoder ${encoder.id}`);

    const outputName = `slice.${encoder.extension}`;
    const args = buildChunkArgs("/input/input.m4a", outputName, 0, 20, encoder);
    const encoded = await page.evaluate(async (ffmpegArgs: string[], downloadName: string) => {
      const ffmpeg = (window as unknown as {
        __ffmpeg: {
          createDir: (path: string) => Promise<boolean>;
          mount: (type: string, options: { files?: File[] }, point: string) => Promise<boolean>;
          exec: (args: string[]) => Promise<number>;
          readFile: (path: string) => Promise<Uint8Array | string>;
        };
        __logs: string[];
      }).__ffmpeg;
      const logs = (window as unknown as { __logs: string[] }).__logs;
      const response = await fetch("/fixture.m4a");
      const blob = await response.blob();
      const file = new File([blob], "input.m4a", { type: "audio/mp4" });
      await ffmpeg.createDir("/input");
      const mounted = await ffmpeg.mount("WORKERFS", { files: [file] }, "/input");
      if (!mounted) throw new Error("WORKERFS mount returned false");
      logs.length = 0;
      const code = await ffmpeg.exec(ffmpegArgs);
      if (code !== 0) throw new Error(`ffmpeg exit ${code}: ${logs.slice(-12).join("\n")}`);
      const data = await ffmpeg.readFile(downloadName);
      if (typeof data === "string") throw new Error("expected binary output");
      let binary = "";
      const view = data instanceof Uint8Array ? data : new Uint8Array(data);
      for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
      return { size: view.byteLength, base64: btoa(binary) };
    }, args, outputName);

    console.log(`wasm slice ${encoded.size} bytes via WORKERFS`);
    if (encoded.size <= 1000 || encoded.size >= 4_000_000) {
      throw new Error(`unexpected wasm slice size ${encoded.size}`);
    }
    const outPath = join(root, outputName);
    await writeFile(outPath, Buffer.from(encoded.base64, "base64"));
    const probed = await run("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      outPath,
    ]);
    const info = JSON.parse(probed.stdout) as {
      streams?: Array<{ sample_rate?: string; channels?: number; codec_name?: string; duration?: string }>;
    };
    const stream = info.streams?.[0];
    if (!stream) throw new Error("ffprobe found no stream");
    console.log(
      `probed ${stream.codec_name} ${stream.sample_rate}Hz ch ${stream.channels} dur ${stream.duration}`,
    );
    if (stream.channels !== 1 || stream.sample_rate !== "16000") {
      throw new Error(`unexpected stream ${stream.sample_rate}Hz ch ${stream.channels}`);
    }
    if (stream.codec_name !== encoder.format && !(encoder.format === "m4a" && stream.codec_name === "aac")) {
      throw new Error(`codec ${stream.codec_name} does not match ${encoder.format}`);
    }
    const duration = Number(stream.duration ?? 0);
    if (Math.abs(duration - 20) > 2) throw new Error(`duration ${duration}`);
    console.log("wasm WORKERFS verification passed.");
  } finally {
    await browser.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
