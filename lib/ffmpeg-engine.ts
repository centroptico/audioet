import { buildChunkArgs, parseDuration, pickEncoder, type EncoderChoice } from "./ffmpeg-args";
import type { EncodeResult } from "./types";

const INPUT_DIR = "/input";
const CORE_JS = "/ffmpeg/core/ffmpeg-core.js";
const CORE_WASM = "/ffmpeg/core/ffmpeg-core.wasm";

type LogEvent = { type?: string; message: string };
type ProgressEvent = { progress: number; time: number };

interface FFmpegInstance {
  loaded: boolean;
  load: (config?: { coreURL?: string; wasmURL?: string }) => Promise<boolean>;
  exec: (args: string[], timeout?: number) => Promise<number>;
  ffprobe: (args: string[], timeout?: number) => Promise<number>;
  on(event: "log", callback: (event: LogEvent) => void): void;
  on(event: "progress", callback: (event: ProgressEvent) => void): void;
  off(event: "log", callback: (event: LogEvent) => void): void;
  off(event: "progress", callback: (event: ProgressEvent) => void): void;
  mount: (type: string, options: { files?: File[] }, mountPoint: string) => Promise<boolean>;
  unmount: (mountPoint: string) => Promise<boolean>;
  createDir: (path: string) => Promise<boolean>;
  deleteDir: (path: string) => Promise<boolean>;
  readFile: (path: string, encoding?: string) => Promise<Uint8Array | string>;
  deleteFile: (path: string) => Promise<boolean>;
  terminate: () => void;
}

type FFmpegModule = {
  FFmpeg: new () => FFmpegInstance;
  FFFSType: { WORKERFS: string };
};

export function browserSupportsEngine(): boolean {
  return typeof WebAssembly === "object" && typeof Worker === "function" && typeof File === "function";
}

async function importEngine(): Promise<FFmpegModule> {
  // A variable import so the bundler leaves the public ESM build alone.
  const importer = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<FFmpegModule>;
  return importer(new URL("/ffmpeg/esm/index.js", window.location.href).href);
}

async function blobUrlFrom(url: string, mime: string, onProgress?: (ratio: number) => void): Promise<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`No se pudo descargar el motor de audio (${response.status}).`);
  }
  const total = Number(response.headers.get("content-length") || 0);
  const reader = response.body.getReader();
  const parts: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    parts.push(value as BlobPart);
    received += value.byteLength;
    if (total > 0) onProgress?.(Math.min(1, received / total));
  }
  return URL.createObjectURL(new Blob(parts, { type: mime }));
}

function safeInputFile(file: File): File {
  const match = /\.([a-z0-9]{1,8})$/i.exec(file.name);
  const extension = (match?.[1] ?? "audio").toLowerCase();
  return new File([file], `input.${extension}`, { type: file.type || "application/octet-stream" });
}

function copyBytes(data: Uint8Array | string): Uint8Array {
  if (typeof data === "string") throw new Error("El fragmento de audio salió vacío.");
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

/**
 * One single-thread ffmpeg.wasm instance. The source file is mounted with
 * WORKERFS so a multi-hour note is not copied into the wasm heap. Each slice
 * is encoded into memory, read out, and deleted before the next one starts.
 */
export class AudioEncoder {
  private ffmpeg: FFmpegInstance | null = null;
  private workerFs: string | null = null;
  private loadPromise: Promise<void> | null = null;
  private encoder: EncoderChoice | null = null;
  private inputPath = "";
  private mounted = false;
  private generation = 0;
  private chain: Promise<unknown> = Promise.resolve();

  async load(onProgress?: (ratio: number) => void): Promise<void> {
    if (!browserSupportsEngine()) {
      throw new Error("Este navegador no puede procesar el audio (faltan WebAssembly o Workers).");
    }
    if (this.ffmpeg?.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.loadInner(onProgress).catch((error: unknown) => {
        this.loadPromise = null;
        throw error;
      });
    }
    await this.loadPromise;
  }

  private async loadInner(onProgress?: (ratio: number) => void): Promise<void> {
    const ffmpegModule = await importEngine();
    const ffmpeg = new ffmpegModule.FFmpeg();
    this.workerFs = ffmpegModule.FFFSType.WORKERFS;
    onProgress?.(0.02);
    const coreURL = await blobUrlFrom(new URL(CORE_JS, window.location.href).href, "text/javascript");
    const wasmURL = await blobUrlFrom(
      new URL(CORE_WASM, window.location.href).href,
      "application/wasm",
      (ratio) => onProgress?.(0.02 + ratio * 0.9),
    );
    try {
      await ffmpeg.load({ coreURL, wasmURL });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      throw new Error(
        detail
          ? `No se pudo iniciar el motor de audio. ${detail}`
          : "No se pudo iniciar el motor de audio. Recarga la página e inténtalo otra vez.",
      );
    }
    this.ffmpeg = ffmpeg;
    onProgress?.(1);
  }

  terminate(): void {
    this.generation += 1;
    this.ffmpeg?.terminate();
    this.ffmpeg = null;
    this.loadPromise = null;
    this.encoder = null;
    this.mounted = false;
    this.inputPath = "";
    this.chain = Promise.resolve();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private requireFfmpeg(): FFmpegInstance {
    if (!this.ffmpeg?.loaded) throw new Error("El motor de audio no está listo.");
    return this.ffmpeg;
  }

  async mount(file: File): Promise<void> {
    const generation = this.generation;
    const safe = safeInputFile(file);
    await this.exclusive(async () => {
      if (generation !== this.generation) return;
      const ffmpeg = this.requireFfmpeg();
      try {
        await ffmpeg.unmount(INPUT_DIR);
      } catch {
        // Not mounted anymore.
      }
      try {
        await ffmpeg.deleteDir(INPUT_DIR);
      } catch {
        // Directory already gone.
      }
      this.mounted = false;
      if (generation !== this.generation) return;
      await ffmpeg.createDir(INPUT_DIR);
      const mounted = await ffmpeg.mount(this.workerFs ?? "WORKERFS", { files: [safe] }, INPUT_DIR);
      if (!mounted) throw new Error("No se pudo leer el audio sin copiarlo entero a memoria (WORKERFS).");
      this.mounted = true;
      this.inputPath = `${INPUT_DIR}/${safe.name}`;
    });
  }

  async unmount(): Promise<void> {
    if (!this.ffmpeg || !this.mounted) return;
    const generation = this.generation;
    await this.exclusive(async () => {
      if (generation !== this.generation || !this.ffmpeg || !this.mounted) return;
      try {
        await this.ffmpeg.unmount(INPUT_DIR);
      } catch {
        // Already unmounted.
      }
      try {
        await this.ffmpeg.deleteDir(INPUT_DIR);
      } catch {
        // Already removed.
      }
      this.mounted = false;
      this.inputPath = "";
    });
  }

  async ensureEncoder(): Promise<EncoderChoice> {
    if (this.encoder) return this.encoder;
    const generation = this.generation;
    return this.exclusive(async () => {
      if (generation !== this.generation) throw new Error("Transcripción cancelada");
      if (this.encoder) return this.encoder;
      const log = await this.collectLog(["-hide_banner", "-encoders"]);
      const choice = pickEncoder(log);
      if (!choice) {
        throw new Error("Este motor de audio no puede recodificar a mp3, aac ni opus.");
      }
      this.encoder = choice;
      return choice;
    });
  }

  async probeDuration(): Promise<number> {
    const generation = this.generation;
    return this.exclusive(async () => {
      if (generation !== this.generation) throw new Error("Transcripción cancelada");
      const ffmpeg = this.requireFfmpeg();
      if (!this.inputPath) throw new Error("No hay ningún audio cargado.");
      try {
        const code = await ffmpeg.ffprobe([
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          this.inputPath,
          "-o",
          "duration.txt",
        ]);
        if (code === 0) {
          const raw = await ffmpeg.readFile("duration.txt", "utf8");
          await ffmpeg.deleteFile("duration.txt").catch(() => false);
          const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
          const duration = Number.parseFloat(text.trim());
          if (Number.isFinite(duration) && duration > 0) return duration;
        }
      } catch {
        // Some builds fail ffprobe. The log parser below still works.
      }
      const log = await this.collectLog(["-hide_banner", "-i", this.inputPath]);
      const duration = parseDuration(log);
      if (!duration) {
        throw new Error("No se pudo leer la duración. Prueba con m4a, mp3, ogg, wav o webm.");
      }
      return duration;
    });
  }

  async encodeRange(
    start: number,
    duration: number,
    onRatio?: (ratio: number) => void,
  ): Promise<EncodeResult> {
    const generation = this.generation;
    return this.exclusive(async () => {
      if (generation !== this.generation) {
        const error = new Error("Transcripción cancelada");
        error.name = "AbortError";
        throw error;
      }
      const ffmpeg = this.requireFfmpeg();
      const encoder = this.encoder ?? (await this.ensureEncoderUnlocked());
      const output = `slice.${encoder.extension}`;
      const args = buildChunkArgs(this.inputPath, output, start, duration, encoder);
      let log = "";
      const onLog = ({ message }: LogEvent) => {
        log += `${message}\n`;
        if (log.length > 6000) log = log.slice(-4000);
      };
      const onProgress = ({ progress }: ProgressEvent) => {
        if (Number.isFinite(progress)) onRatio?.(Math.max(0, Math.min(1, progress)));
      };
      ffmpeg.on("log", onLog);
      ffmpeg.on("progress", onProgress);
      try {
        const code = await ffmpeg.exec(args);
        if (generation !== this.generation) {
          const error = new Error("Transcripción cancelada");
          error.name = "AbortError";
          throw error;
        }
        if (code !== 0) {
          const tail = log.trim().slice(-500);
          throw new Error(tail ? `ffmpeg: ${tail}` : `ffmpeg terminó con código ${code}.`);
        }
        const data = await ffmpeg.readFile(output);
        const bytes = copyBytes(data);
        if (bytes.byteLength === 0) throw new Error("El fragmento de audio salió vacío.");
        await ffmpeg.deleteFile(output);
        return { bytes, format: encoder.format, bitrate: encoder.bitrate };
      } finally {
        ffmpeg.off("log", onLog);
        ffmpeg.off("progress", onProgress);
      }
    });
  }

  private async ensureEncoderUnlocked(): Promise<EncoderChoice> {
    if (this.encoder) return this.encoder;
    const log = await this.collectLog(["-hide_banner", "-encoders"]);
    const choice = pickEncoder(log);
    if (!choice) throw new Error("Este motor de audio no puede recodificar a mp3, aac ni opus.");
    this.encoder = choice;
    return choice;
  }

  private async collectLog(args: string[]): Promise<string> {
    const ffmpeg = this.requireFfmpeg();
    let log = "";
    const onLog = ({ message }: LogEvent) => {
      log += `${message}\n`;
    };
    ffmpeg.on("log", onLog);
    try {
      await ffmpeg.exec(args);
    } finally {
      ffmpeg.off("log", onLog);
    }
    return log;
  }
}
