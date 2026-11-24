import fs from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { ChromiumTraceExportError, type FilteredChromiumTrace } from "../diagnostics/chromium-trace";
import { chromiumTraceProcessor, type ChromiumTraceFilterProcess } from "../diagnostics/chromium-trace-processor";
import { createTemporaryTestDirectory } from "../shell/testing/test-harness";

function startNodeFilter(path: string): ChromiumTraceFilterProcess {
  const worker = new Worker(path);
  const result = new Promise<FilteredChromiumTrace>((resolve, reject) => {
    const fail = () => reject(new ChromiumTraceExportError("worker", "filter"));
    worker.once("error", fail);
    worker.once("exit", fail);
    worker.once("message", (message: unknown) => {
      if (types.isUint8Array(message)) {
        resolve({ bytes: message, filterCpuMs: 1, filterElapsedMs: 1 });
      } else {
        reject(new ChromiumTraceExportError("invalid-data", "filter"));
      }
    });
  });
  return {
    send: (chunk) => worker.postMessage(chunk),
    result,
    close: async () => { await worker.terminate(); },
  };
}

it("processes a large chunked export in the worker and returns only filtered JSON", async () => {
  const root = await createTemporaryTestDirectory();
  try {
    const worker = path.join(root.path, "trace-worker.cjs");
    await build({
      entryPoints: [path.join(import.meta.dirname, "../diagnostics/chromium-trace-worker.ts")],
      outfile: worker, bundle: true, platform: "node", format: "cjs",
      // The real transformation must execute in the worker isolate.
      banner: { js: 'if (require("node:worker_threads").isMainThread) throw new Error("Expected a worker");' },
    });
    const secret = "https://private.invalid/customer";
    const base = { name: "Layout", pid: 1, tid: 2, ts: 3, ph: "X", cat: "devtools.timeline" };
    const row = JSON.stringify({ ...base, args: { url: secret, text: "ü".repeat(2_000) } });
    async function* chunks() {
      yield { data: '{"traceEvents":[' };
      const batch = Buffer.from(`${row},`.repeat(110)).toString("base64");
      for (let i = 0; i < 96; i += 1) yield { data: batch, base64Encoded: true };
      yield { data: `${row}]}` };
    }

    const processTrace = chromiumTraceProcessor(() => startNodeFilter(worker));
    const { bytes } = await processTrace(chunks(), new AbortController().signal);
    const filtered = JSON.parse(Buffer.from(bytes).toString("utf8")).traceEvents;
    expect(filtered).toHaveLength(96 * 110 + 1);
    expect(filtered.every((event: unknown) => JSON.stringify(event) === JSON.stringify({
      pid: 1, tid: 2, cat: "devtools.timeline", name: "Layout", ph: "X", ts: 3,
    }))).toBe(true);
    expect(await fs.readdir(root.path)).toEqual(["trace-worker.cjs"]);

    const aborted = new AbortController();
    async function* interrupted() {
      yield { data: `{"traceEvents":[${row}` };
      aborted.abort();
      yield { data: "]}" };
    }
    await expect(processTrace(interrupted(), aborted.signal)).rejects.toMatchObject({ name: "AbortError" });

    const batch = Buffer.from(`${row},`.repeat(110)).toString("base64");
    async function* oversized() {
      for (let i = 0; i < 128; i += 1) yield { data: batch, base64Encoded: true };
    }
    await expect(processTrace(oversized(), new AbortController().signal)).rejects
      .toMatchObject({ phase: "stream-read", category: "limit" });
  } finally {
    await root.cleanup();
  }
});

it("surfaces an unavailable worker while Chromium is still opening the stream", async () => {
  const root = await createTemporaryTestDirectory();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  async function* nativeStream() {
    await blocked;
    yield { data: "{}" };
  }
  try {
    const processTrace = chromiumTraceProcessor(() => startNodeFilter(path.join(root.path, "missing.cjs")));
    await expect(processTrace(nativeStream(), new AbortController().signal)).rejects
      .toMatchObject({ phase: "filter", category: "worker" });
  } finally {
    release();
    await root.cleanup();
  }
});
