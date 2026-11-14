"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CHUNK_SECONDS, OVERLAP_SECONDS, PLAN_VERSION } from "../lib/config";
import { postChunk } from "../lib/client-transcribe";
import { copyText } from "../lib/copy-text";
import { readBrowserDuration } from "../lib/duration";
import { AudioEncoder } from "../lib/ffmpeg-engine";
import { formatBytes, formatClock } from "../lib/format";
import { planChunks } from "../lib/chunk-plan";
import { orderedTextFrom, runTranscription } from "../lib/orchestrator";
import { errorMessage, isAbortError } from "../lib/retry";
import {
  clearTranscript,
  fileKeyOf,
  loadTranscript,
  persistableChunks,
  samePlan,
  saveTranscript,
  type PersistedTranscript,
} from "../lib/storage";
import type { ChunkRecord, TranscriptSnapshot } from "../lib/types";

type Phase = "idle" | "engine" | "running";

type FileMeta = {
  key: string;
  name: string;
  size: number;
  duration: number;
};

const ACCEPT = "audio/*,video/mp4,video/webm,.m4a,.aac,.mp3,.wav,.ogg,.opus,.webm,.flac,.caf,.mp4,.mpeg";

function looksLikeAudio(file: File): boolean {
  if (file.type.startsWith("audio/") || file.type.startsWith("video/")) return true;
  if (!file.type || file.type === "application/octet-stream") return true;
  return /\.(m4a|aac|mp3|wav|ogg|opus|webm|flac|caf|mp4|mpeg|mpga)$/i.test(file.name);
}

function recordsFromSaved(saved: PersistedTranscript): ChunkRecord[] {
  return saved.chunks.map((chunk) => ({
    index: chunk.index,
    start: chunk.start,
    duration: chunk.duration,
    status: chunk.status,
    text: chunk.text,
    error: chunk.error,
  }));
}

function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

export function AudioetApp() {
  const engineRef = useRef<AudioEncoder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState<PersistedTranscript | null>(null);
  const [snapshot, setSnapshot] = useState<TranscriptSnapshot | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [engineRatio, setEngineRatio] = useState(0);
  const [encodeRatio, setEncodeRatio] = useState<number | null>(null);
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [source, setSource] = useState<File | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const engine = () => {
    if (!engineRef.current) engineRef.current = new AudioEncoder();
    return engineRef.current;
  };

  useEffect(() => {
    // localStorage is read after mount so the server HTML and the first client render match.
    /* eslint-disable react-hooks/set-state-in-effect */
    const stored = loadTranscript(window.localStorage);
    setSaved(stored);
    setDraft(stored?.editedText ?? null);
    if (stored) {
      setMeta({
        key: stored.fileKey,
        name: stored.fileName,
        size: stored.fileSize,
        duration: stored.durationSec,
      });
    }
    setReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    if (phase === "idle") return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (!("wakeLock" in navigator)) return;
        const next = await navigator.wakeLock.request("screen");
        if (cancelled) {
          await next.release().catch(() => undefined);
          return;
        }
        lock = next;
      } catch {
        lock = null;
      }
    };
    void acquire();
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [phase]);

  useEffect(() => {
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      const current = loadTranscript(window.localStorage);
      if (!current) return;
      if (current.editedText === draft) return;
      saveTranscript(window.localStorage, { ...current, editedText: draft, updatedAt: Date.now() });
      setSaved({ ...current, editedText: draft, updatedAt: Date.now() });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draft, ready]);

  const chunks = snapshot?.chunks ?? (saved ? recordsFromSaved(saved) : []);
  const baseText = snapshot ? snapshot.orderedText : orderedTextFrom(chunks);
  const text = draft ?? baseText;
  const doneCount = chunks.filter((chunk) => chunk.status === "done").length;
  const total = chunks.length;
  const activeIndex = chunks.findIndex((chunk) => chunk.status !== "done");
  const fragment = total === 0 ? 0 : activeIndex === -1 ? total : activeIndex + 1;
  const percent = total === 0 ? 0 : Math.round((doneCount / total) * 100);
  const failed = chunks.filter((chunk) => chunk.status === "error");
  const incomplete = chunks.some((chunk) => chunk.status === "pending" || chunk.status === "error");
  const encoding = chunks.find((chunk) => chunk.status === "encoding");
  const transcribing = chunks.filter((chunk) => chunk.status === "transcribing");

  const busy = phase !== "idle";

  const persist = (snap: TranscriptSnapshot, info: FileMeta, edited: string | null) => {
    const next: PersistedTranscript = {
      version: 1,
      planVersion: PLAN_VERSION,
      chunkSeconds: CHUNK_SECONDS,
      overlapSeconds: OVERLAP_SECONDS,
      fileKey: info.key,
      fileName: info.name,
      fileSize: info.size,
      durationSec: info.duration,
      editedText: edited,
      chunks: persistableChunks(snap.chunks),
      updatedAt: Date.now(),
    };
    saveTranscript(window.localStorage, next);
    setSaved(next);
  };

  const start = async (file: File) => {
    if (!looksLikeAudio(file)) {
      setFatal("Ese archivo no parece de audio.");
      return;
    }
    if (file.size <= 0) {
      setFatal("El archivo está vacío.");
      return;
    }

    const myRun = ++runRef.current;
    if (phaseRef.current !== "idle") {
      abortRef.current?.abort();
      engine().terminate();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setSource(file);
    setFatal(null);
    setNotice(null);
    setCopied(false);
    setCopyError(null);
    setEncodeRatio(null);

    const key = fileKeyOf(file);
    const stored = loadTranscript(window.localStorage);
    const resume = samePlan(stored) && stored.fileKey === key ? stored : null;
    setMeta({
      key,
      name: file.name,
      size: file.size,
      duration: resume?.durationSec ?? 0,
    });
    if (resume && resume.chunks.length > 0 && resume.chunks.every((chunk) => chunk.status === "done")) {
      setMeta({ key, name: file.name, size: file.size, duration: resume.durationSec });
      setSnapshot({
        chunks: recordsFromSaved(resume),
        orderedText: orderedTextFrom(recordsFromSaved(resume)),
        encodingIndex: null,
        transcribing: [],
        doneCount: resume.chunks.length,
        total: resume.chunks.length,
      });
      setDraft(resume.editedText);
      setNotice("Esta transcripción ya está completa. Pulsa Borrar si quieres empezar de cero.");
      setPhase("idle");
      return;
    }

    setPhase("engine");
    setEngineRatio(0);
    if (!resume) {
      setSnapshot(null);
      setDraft(null);
      setSaved(null);
      clearTranscript(window.localStorage);
    }

    try {
      const durationPromise = resume
        ? Promise.resolve(resume.durationSec)
        : readBrowserDuration(file).catch(() => null);

      await engine().load((ratio) => {
        if (myRun === runRef.current) setEngineRatio(ratio);
      });
      if (myRun !== runRef.current || controller.signal.aborted) return;

      let duration = await durationPromise;
      await engine().mount(file);
      if (!duration) duration = await engine().probeDuration();
      if (myRun !== runRef.current || controller.signal.aborted) return;

      const info: FileMeta = { key, name: file.name, size: file.size, duration };
      setMeta(info);
      await engine().ensureEncoder();

      const plan = resume
        ? resume.chunks.map((chunk) => ({
            index: chunk.index,
            start: chunk.start,
            duration: chunk.duration,
          }))
        : planChunks(duration);

      setPhase("running");
      await runTranscription({
        plan,
        initial: resume?.chunks,
        signal: controller.signal,
        encode: (range) =>
          engine().encodeRange(range.start, range.duration, (ratio) => {
            if (myRun === runRef.current) setEncodeRatio(ratio);
          }),
        transcribe: (input) => postChunk(input.bytes, input.format, input.signal),
        onProgress: (snap) => {
          if (myRun !== runRef.current) return;
          setSnapshot(snap);
          setDraft(null);
          setEncodeRatio(null);
          persist(snap, info, null);
        },
      });
    } catch (error) {
      if (myRun !== runRef.current || isAbortError(error)) return;
      setFatal(errorMessage(error));
    } finally {
      if (myRun === runRef.current) setPhase("idle");
    }
  };

  const onClear = () => {
    abortRef.current?.abort();
    if (phaseRef.current !== "idle") engine().terminate();
    void engine().unmount();
    clearTranscript(window.localStorage);
    setSaved(null);
    setSnapshot(null);
    setDraft(null);
    setMeta(null);
    setSource(null);
    setFatal(null);
    setNotice(null);
    setCopied(false);
    setCopyError(null);
    setPhase("idle");
  };

  const onCopy = async () => {
    try {
      await copyText(text);
      setCopied(true);
      setCopyError(null);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      setCopyError(errorMessage(error));
    }
  };

  const takeFile = (file: File | undefined) => {
    if (file) void start(file);
  };

  const large = (meta?.size ?? 0) > 350 * 1024 * 1024;
  const showRestored = ready && !snapshot && Boolean(saved && (baseText || incomplete));
  const enginePercent = Math.round(engineRatio * 100);

  const statusLine = useMemo(() => {
    if (phase === "engine") return `Descargando el motor de audio… ${enginePercent}%`;
    if (encoding) {
      const ratio = encodeRatio == null ? "" : ` · ${Math.round(encodeRatio * 100)}%`;
      return `Codificando fragmento ${encoding.index + 1} de ${total}${ratio}`;
    }
    if (transcribing.length === 1) return `Transcribiendo fragmento ${transcribing[0].index + 1} de ${total}`;
    if (transcribing.length > 1) {
      const list = transcribing.map((chunk) => chunk.index + 1).join(", ");
      return `Transcribiendo fragmentos ${list}`;
    }
    if (phase === "running") return "Preparando el siguiente fragmento…";
    if (total > 0 && doneCount === total) return "Transcripción completa";
    return null;
  }, [phase, enginePercent, encoding, encodeRatio, total, transcribing, doneCount]);

  return (
    <main className={busy ? "shell is-busy" : "shell"}>
      <header className="masthead">
        <div>
          <h1 className="brand">Audioet</h1>
          <p className="lede">
            Transcribe notas de voz largas. El audio se parte en este dispositivo y no se guarda en ningún servidor.
          </p>
        </div>
      </header>

      <section
        className={over ? "drop is-over" : "drop"}
        onDragEnter={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          takeFile(event.dataTransfer.files?.[0]);
        }}
      >
        <strong>Suelta la nota de voz aquí</strong>
        <p>m4a, aac, ogg, opus, mp3, wav o webm. Pensado para notas de unas 2 o 3 horas.</p>
        <div className="actions">
          <button className="button primary" type="button" onClick={() => inputRef.current?.click()}>
            Elegir archivo
          </button>
          <input
            ref={inputRef}
            className="file-input"
            type="file"
            accept={ACCEPT}
            aria-label="Elegir un archivo de audio"
            onChange={(event) => {
              takeFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
      </section>

      {showRestored ? (
        <p className="banner" role="status">
          Hay una transcripción guardada en este dispositivo. No se borra hasta que pulses Borrar o elijas otro archivo.
          {incomplete
            ? " Faltan fragmentos: vuelve a elegir el mismo archivo para continuar donde se quedó."
            : ""}
        </p>
      ) : null}

      {meta ? (
        <section className="panel" aria-live="polite">
          <p className="file-line">
            <strong>{meta.name}</strong>
            <span>
              {formatBytes(meta.size)}
              {meta.duration ? ` · ${formatClock(meta.duration)}` : ""}
            </span>
          </p>
          {large ? (
            <p className="detail">Este archivo es muy grande. En un móvil puede tardar mucho o quedarse sin memoria.</p>
          ) : null}
          {phase === "engine" ? (
            <>
              <p className="kicker">Preparando</p>
              <div className="bar" aria-hidden="true">
                <span style={{ width: `${enginePercent}%` }} />
              </div>
              <p className="detail">{statusLine} Unos 31 MB la primera vez; después el navegador los reutiliza.</p>
            </>
          ) : null}
          {total > 0 && phase !== "engine" ? (
            <>
              <p className="kicker">
                Fragmento {fragment}/{total}
              </p>
              <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Progreso de la transcripción">
                <span style={{ width: `${percent}%` }} />
              </div>
              <p className="detail">
                {percent}%{statusLine ? ` · ${statusLine}` : ""}
              </p>
            </>
          ) : null}
          <p className="wake-notice">
            Mantén la pantalla encendida y esta pestaña abierta. Si el teléfono se bloquea, la transcripción se detiene. El texto que ya llegó se queda guardado en el dispositivo.
          </p>
          {failed.map((chunk) => (
            <div className="callout" role="alert" key={chunk.index}>
              <p>
                Fragmento {chunk.index + 1}: {chunk.error || "falló sin más detalle."}
              </p>
            </div>
          ))}
          {failed.length > 0 && source ? (
            <div className="actions">
              <button className="button primary" type="button" onClick={() => void start(source)} disabled={busy}>
                Reintentar fragmentos fallidos
              </button>
            </div>
          ) : null}
          {notice ? <p className="detail">{notice}</p> : null}
          {fatal ? (
            <div className="callout" role="alert">
              <p>{fatal}</p>
            </div>
          ) : null}
        </section>
      ) : null}

      {!meta && fatal ? (
        <div className="callout" role="alert">
          <p>{fatal}</p>
        </div>
      ) : null}

      <section className="transcript" aria-labelledby="transcript-label">
        <div className="toolbar">
          <div className="toolbar-buttons">
            <button className="button primary" type="button" onClick={() => void onCopy()} disabled={!text.trim()}>
              {copied ? "Copiado" : "Copiar"}
            </button>
            <button className="button ghost" type="button" onClick={onClear} disabled={!text && !meta && !saved}>
              Borrar
            </button>
          </div>
          <span className="word-count" id="transcript-label">
            {text.trim() ? `${wordCount(text).toLocaleString("es")} palabras` : "Transcripción"}
          </span>
        </div>
        <textarea
          value={ready ? text : ""}
          readOnly={busy}
          spellCheck={false}
          placeholder="El texto irá apareciendo aquí, en orden, conforme lleguen los fragmentos."
          aria-label="Transcripción"
          onChange={(event) => {
            if (!busy) setDraft(event.target.value);
          }}
        />
      </section>
      {copyError ? (
        <p className="callout" role="alert">
          {copyError}
        </p>
      ) : null}
      <p className="fineprint">
        Cada fragmento dura unos 10 minutos, se recodifica a mono 16 kHz y 32 kbps, y se envía al servidor solo para transcribirlo. Si cierras la pestaña, el texto ya hecho sigue aquí; el audio no.
      </p>
    </main>
  );
}
