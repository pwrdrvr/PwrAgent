import fs from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { ChromiumTrace, type PublishChromiumTrace } from "../diagnostics/chromium-trace";
import { filterChromiumTrace } from "../diagnostics/chromium-trace-filter";
import { acquireChromiumTrace, tryAcquireChromiumTrace } from "../diagnostics/chromium-trace-lease";
import { createTemporaryTestDirectory } from "../shell/testing/test-harness";

const layout = { name: "Layout", pid: 4, tid: 2, ph: "X", cat: "devtools.timeline", ts: 312, dur: 5 };
const rawTrace = JSON.stringify({ traceEvents: [layout] });
const publish: PublishChromiumTrace = async (chunks, file, signal) => {
  for await (const chunk of chunks) {
    signal.throwIfAborted();
    await fs.writeFile(file, chunk.data);
  }
};

it("keeps timing and known labels while reconstructing events from untrusted native exports", () => {
  fc.assert(fc.property(fc.string(), fc.integer(), (text, timestamp) => {
    const secret = `https://private.invalid/?${new URLSearchParams({ text })}`;
    const raw = {
      metadata: { [secret]: secret },
      traceEvents: [
        { ...layout, ts: timestamp, cat: `devtools.timeline,${secret}`, args: { url: secret }, id: secret },
        { ...layout, ts: timestamp, name: secret, cat: "blink.user_timing", ph: "I", s: secret },
        { ...layout, name: "process_name", ph: "M", args: { name: "Renderer", nested: secret } },
        { ...layout, name: "thread_name", ph: "M", args: { name: secret } },
        { ...layout, cat: secret },
        { ...layout, ts: Infinity },
      ],
    };
    expect(filterChromiumTrace(raw)).toEqual({
      traceEvents: [
        { ...layout, ts: timestamp },
        { ...layout, ts: timestamp, name: "User timing", cat: "blink.user_timing", ph: "I", s: "t" },
        { pid: layout.pid, tid: layout.tid, name: "process_name", ph: "M", cat: "__metadata", args: { name: "Renderer" } },
      ],
    });
  }));
});

it("assigns each trace to one overlapping trigger across arbitrary wall-clock changes", async () => {
  const root = await createTemporaryTestDirectory();
  try {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.integer(), { minLength: 3, maxLength: 8 }),
      fc.boolean(),
      async (wallTimes, reverse) => {
        let mono = 0;
        let recording = false;
        const startRecording = vi.fn(async () => {
          expect(recording).toBe(false);
          recording = true;
        });
        const read = vi.fn(async function* () {
          expect(recording).toBe(true);
          yield { data: rawTrace };
        });
        const dispose = () => { recording = false; };
        const warn = vi.fn();
        const times = [...wallTimes];
        const trace = new ChromiumTrace(() => ({ start: startRecording, read, dispose }), publish, warn, {
          monotonicNow: () => ++mono,
          wallNow: () => times.shift() ?? 0,
        });
        const owners = [{}, {}];
        const firstOwner = owners[Number(reverse)];
        const secondOwner = owners[Number(!reverse)];
        const files = [0, 1, 2].map((i) => path.join(root.path, `trace-${i}.json`));
        try {
          await Promise.all(owners.map((owner) => trace.arm(owner)));
          expect(startRecording).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            recordMode: "recordContinuously", traceBufferSizeInKb: 32 * 1024,
          }));
          const trigger = ++mono;
          const first = trace.capture(firstOwner, files[0], trigger);
          const rearm = trace.arm(firstOwner);
          const overlapping = trace.capture(secondOwner, files[1], trigger);
          expect(await first).toMatchObject({ status: "written" });
          await rearm;
          expect(await overlapping).toEqual({ status: "skipped", reason: "trigger-predates-recording" });
          await trace.release(firstOwner);
          expect(recording).toBe(true);
          expect(await trace.capture(secondOwner, files[2], ++mono)).toMatchObject({ status: "written" });
          expect(JSON.parse(await fs.readFile(files[2], "utf8"))).toEqual({ traceEvents: [layout] });
          await expect(fs.stat(files[1])).rejects.toMatchObject({ code: "ENOENT" });
          expect(warn).not.toHaveBeenCalled();
        } finally {
          await Promise.all(owners.map((owner) => trace.release(owner)));
          await Promise.all(files.map((file) => fs.rm(file, { force: true })));
        }
      },
    ), { numRuns: 30 });
  } finally {
    await root.cleanup();
  }
});

it("reconciles with a manual trace owner and discards only when the last renderer exits", async () => {
  let started!: () => void;
  const armed = new Promise<void>((resolve) => { started = resolve; });
  const startRecording = vi.fn(async () => started());
  const read = vi.fn();
  const dispose = vi.fn();
  const trace = new ChromiumTrace(() => ({ start: startRecording, read, dispose }), publish, vi.fn());
  const first = {};
  const last = {};
  const manual = acquireChromiumTrace();
  try {
    await trace.arm(first);
    await trace.arm(last);
    expect(startRecording).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    manual();
    await armed;
    await trace.release(first);
    expect(dispose).not.toHaveBeenCalled();
    expect(tryAcquireChromiumTrace()).toBeUndefined();
    await trace.release(last);
    expect(dispose).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    const available = acquireChromiumTrace();
    available();
  } finally {
    manual();
    await trace.release(first);
    await trace.release(last);
  }
});

it.each(["reject", "timeout"] as const)(
  "disposes an unacknowledged session without ending or exporting it on %s",
  async (failure) => {
    const start = vi.fn(() => failure === "reject"
      ? Promise.reject(new Error("Tracing is already started"))
      : new Promise<void>(() => {}));
    const read = vi.fn();
    const dispose = vi.fn();
    const trace = new ChromiumTrace(() => ({ start, read, dispose }), publish, vi.fn(), {
      startTimeoutMs: 20,
    });
    const owner = {};
    try {
      await trace.arm(owner);
      expect(await trace.capture(owner, "unused.json", performance.now())).toMatchObject({ status: "skipped" });
      expect(dispose).toHaveBeenCalledOnce();
      expect(read).not.toHaveBeenCalled();
      const available = acquireChromiumTrace();
      available();
    } finally {
      await trace.release(owner);
    }
  },
);

it("closes a timed-out export before rearming, even if the old chunk arrives late", async () => {
  const root = await createTemporaryTestDirectory();
  let deliverLateChunk!: () => void;
  let finishRead!: () => void;
  const late = new Promise<void>((resolve) => { deliverLateChunk = resolve; });
  const finished = new Promise<void>((resolve) => { finishRead = resolve; });
  let mono = 0;
  const reading = vi.fn(async function* () { yield { data: rawTrace }; })
    .mockImplementationOnce(async function* () {
      try {
        await late;
        yield { data: rawTrace };
      } finally {
        finishRead();
      }
    });
  const start = vi.fn(async () => {});
  const dispose = vi.fn();
  const trace = new ChromiumTrace(() => ({ start, dispose, read: reading }), publish, vi.fn(), {
    monotonicNow: () => ++mono, stopTimeoutMs: 100,
  });
  const owner = {};
  const file = path.join(root.path, "never-published.trace.json");
  try {
    await trace.arm(owner);
    expect(await trace.capture(owner, file, ++mono)).toEqual({ status: "failed" });
    expect(dispose).toHaveBeenCalledOnce();
    await trace.arm(owner);
    deliverLateChunk();
    await finished;
    expect(start).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
    expect(await fs.readdir(root.path)).toEqual([]);
  } finally {
    deliverLateChunk();
    await trace.release(owner);
    await root.cleanup();
  }
});
