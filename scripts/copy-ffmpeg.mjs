import { cp, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// package.json is not exported; resolve a public file and walk up to the package root.
const ffmpegDir = join(dirname(require.resolve("@ffmpeg/ffmpeg/worker")), "..", "..");
const coreDir = join(dirname(require.resolve("@ffmpeg/core/wasm")), "..", "..");

const esmOut = join(root, "public/ffmpeg/esm");
const coreOut = join(root, "public/ffmpeg/core");
await mkdir(esmOut, { recursive: true });
await mkdir(coreOut, { recursive: true });

const esmSrc = join(ffmpegDir, "dist/esm");
for (const name of await readdir(esmSrc)) {
  if (!name.endsWith(".js")) continue;
  await cp(join(esmSrc, name), join(esmOut, name));
}

await cp(join(coreDir, "dist/esm/ffmpeg-core.js"), join(coreOut, "ffmpeg-core.js"));
await cp(join(coreDir, "dist/esm/ffmpeg-core.wasm"), join(coreOut, "ffmpeg-core.wasm"));

const wasm = join(coreOut, "ffmpeg-core.wasm");
console.log(`copied single-thread ffmpeg core to public/ffmpeg (${wasm})`);
