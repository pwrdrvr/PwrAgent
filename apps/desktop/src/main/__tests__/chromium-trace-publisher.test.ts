import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { chromiumTracePublisher } from "../diagnostics/chromium-trace-publisher";
import { createTemporaryTestDirectory } from "../shell/testing/test-harness";

it("processes a large chunked export outside the main isolate and stages only filtered JSON", async () => {
  const root = await createTemporaryTestDirectory();
  try {
    const worker = path.join(root.path, "trace-worker.cjs");
    await build({
      entryPoints: [path.join(import.meta.dirname, "../diagnostics/chromium-trace-worker.ts")],
      outfile: worker, bundle: true, platform: "node", format: "cjs",
      // The real transformation must execute in the worker isolate.
      banner: { js: 'if (require("node:worker_threads").isMainThread) throw new Error("Expected a worker");' },
    });
    const pending = path.join(root.path, "filtered.tmp");
    const secret = "https://private.invalid/customer";
    const base = { name: "Layout", pid: 1, tid: 2, ts: 3, ph: "X", cat: "devtools.timeline" };
    const row = JSON.stringify({ ...base, args: { url: secret, text: "ü".repeat(2_000) } });
    async function* chunks() {
      yield { data: '{"traceEvents":[' };
      const batch = Buffer.from(`${row},`.repeat(110)).toString("base64");
      for (let i = 0; i < 192; i += 1) yield { data: batch, base64Encoded: true };
      yield { data: `${row}]}` };
    }

    const publish = chromiumTracePublisher(worker);
    await publish(chunks(), pending, new AbortController().signal);
    const filtered = JSON.parse(await fs.readFile(pending, "utf8")).traceEvents;
    expect(filtered).toHaveLength(192 * 110 + 1);
    expect(filtered.every((event: unknown) => JSON.stringify(event) === JSON.stringify({
      pid: 1, tid: 2, cat: "devtools.timeline", name: "Layout", ph: "X", ts: 3,
    }))).toBe(true);
    expect((await fs.readdir(root.path)).sort()).toEqual(["filtered.tmp", "trace-worker.cjs"]);

    const aborted = new AbortController();
    async function* interrupted() {
      yield { data: `{"traceEvents":[${row}` };
      aborted.abort();
      yield { data: "]}" };
    }
    const abortedPath = path.join(root.path, "aborted.tmp");
    await expect(publish(interrupted(), abortedPath, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(fs.stat(abortedPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await root.cleanup();
  }
});
