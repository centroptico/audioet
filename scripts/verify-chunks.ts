import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planChunks } from "../lib/chunk-plan";
import { buildChunkArgs, pickEncoder } from "../lib/ffmpeg-args";

type Probe = {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    sample_rate?: string;
    channels?: number;
    duration?: string;
    bit_rate?: string;
  }>;
  format?: { duration?: string; size?: string; bit_rate?: string };
};

function run(command: string, args: string[], allowFail = false): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !allowFail) {
        reject(new Error(`${command} ${args.join(" ")}\n${stderr || error.message}`));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

async function probe(file: string): Promise<Probe> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    file,
  ]);
  return JSON.parse(stdout) as Probe;
}

function audioStream(info: Probe) {
  const stream = info.streams?.find((item) => item.codec_type === "audio") ?? info.streams?.[0];
  if (!stream) throw new Error("ffprobe did not find an audio stream");
  return stream;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "audioet-chunks-"));
  const failures: string[] = [];
  const check = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };

  try {
    const encoders = await run("ffmpeg", ["-hide_banner", "-encoders"]);
    const encoder = pickEncoder(`${encoders.stdout}\n${encoders.stderr}`);
    if (!encoder) throw new Error("system ffmpeg has none of libmp3lame, aac, libopus");
    console.log(`encoder ${encoder.id} ${encoder.bitrate} -> ${encoder.format}`);

    const cases = [
      {
        name: "iphone-like-m4a",
        input: join(root, "voice.m4a"),
        seconds: 1200,
        make: [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=44100:duration=1200",
          "-ac",
          "2",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          join(root, "voice.m4a"),
        ],
      },
      {
        name: "whatsapp-like-ogg",
        input: join(root, "voice.ogg"),
        seconds: 25,
        make: [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=220:sample_rate=48000:duration=25",
          "-c:a",
          "libopus",
          "-b:a",
          "24k",
          join(root, "voice.ogg"),
        ],
      },
    ];

    for (const item of cases) {
      console.log(`\n${item.name}: generating ${item.seconds}s`);
      await run("ffmpeg", item.make);
      const source = await probe(item.input);
      const duration = Number(source.format?.duration ?? audioStream(source).duration ?? 0);
      const sourceSize = Number(source.format?.size ?? 0);
      console.log(`source ${sourceSize} bytes, duration ${duration.toFixed(2)}s, channels ${audioStream(source).channels}`);
      const plan = planChunks(duration);
      console.log(`plan ${plan.length} slices`);
      check(Math.abs(duration - item.seconds) < 1, `${item.name} duration ${duration}`);

      for (const slice of plan) {
        const output = join(root, `${item.name}-${slice.index}.${encoder.extension}`);
        const args = buildChunkArgs(item.input, output, slice.start, slice.duration, encoder);
        await run("ffmpeg", args);
        const info = await probe(output);
        const stream = audioStream(info);
        const size = (await stat(output)).size;
        const outDuration = Number(stream.duration ?? info.format?.duration ?? 0);
        const bitrate = Number(stream.bit_rate || info.format?.bit_rate || 0);
        console.log(
          `  #${slice.index} start ${slice.start.toFixed(1)} plan ${slice.duration.toFixed(1)}s ` +
            `got ${outDuration.toFixed(2)}s ${size} bytes ${stream.codec_name} ${stream.sample_rate}Hz ` +
            `ch ${stream.channels} ${bitrate}bps`,
        );
        check(size > 1000, `${item.name} #${slice.index} is tiny (${size})`);
        check(size < 4_000_000, `${item.name} #${slice.index} is ${size} bytes, over 4 MB`);
        check(size <= 3_500_000, `${item.name} #${slice.index} is ${size} bytes, over the 3.5 MB budget`);
        check(stream.channels === 1, `${item.name} #${slice.index} channels ${stream.channels}`);
        check(stream.sample_rate === "16000", `${item.name} #${slice.index} rate ${stream.sample_rate}`);
        check(Math.abs(outDuration - slice.duration) < 2, `${item.name} #${slice.index} duration ${outDuration} vs ${slice.duration}`);
        if (slice.duration >= 30) {
          check(bitrate > 20_000 && bitrate < 48_000, `${item.name} #${slice.index} bitrate ${bitrate}`);
        }
      }

      if (item.name === "iphone-like-m4a") {
        const tenMinutes = 600 * 128_000 / 8;
        check(tenMinutes > 4_500_000, "fixture math: a raw 10 min slice of the 128 kbps source would exceed 4.5 MB");
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error("\nChunk verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("\nChunk verification passed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
