import fs from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { ChromiumTrace, type ProcessChromiumTrace } from "../diagnostics/chromium-trace";
import { filterChromiumTrace } from "../diagnostics/chromium-trace-filter";
import { acquireChromiumTrace, tryAcquireChromiumTrace } from "../diagnostics/chromium-trace-lease";
import { createTemporaryTestDirectory } from "../shell/testing/test-harness";

const layout = { name: "Layout", pid: 4, tid: 2, ph: "X", cat: "devtools.timeline", ts: 312, dur: 5 };
const rawTrace = JSON.stringify({ traceEvents: [layout] });
const processTrace: ProcessChromiumTrace = async (chunks, signal) => {
  const buffers: Buffer[] = [];
  for await (const chunk of chunks) {
    signal.throwIfAborted();
    buffers.push(Buffer.from(chunk.data));
  }
  return Buffer.concat(buffers);
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
        const trace = new ChromiumTrace(() => ({ start: startRecording, read, dispose }), processTrace, warn, {
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
            recordMode: "recordContinuously", traceBufferSizeInKb: 8 * 1024,
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
  const trace = new ChromiumTrace(() => ({ start: startRecording, read, dispose }), processTrace, vi.fn());
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
    const trace = new ChromiumTrace(() => ({ start, read, dispose }), processTrace, vi.fn(), {
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
  const trace = new ChromiumTrace(() => ({ start, dispose, read: reading }), processTrace, vi.fn(), {
    monotonicNow: () => ++mono, stopTimeoutMs: 100,
  });
  const owner = {};
  const file = path.join(root.path, "never-published.trace.json");
  try {
    await trace.arm(owner);
    expect(await trace.capture(owner, file, ++mono)).toEqual({ status: "failed", phase: "stop", category: "timeout" });
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

it("reports the last reached native phase without persisting or logging a protocol error", async () => {
  const root = await createTemporaryTestDirectory();
  const phases = ["stop", "stream-open", "stream-read", "stream-close"] as const;
  const file = path.join(root.path, "trace.json");
  try {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: phases.length - 1 }), fc.string(), async (index, text) => {
      const warn = vi.fn();
      const trace = new ChromiumTrace(() => ({
        start: async () => {},
        async *read(_signal, report) {
          for (const phase of phases.slice(0, index + 1)) report?.(phase);
          if (index === phases.length - 1) yield { data: rawTrace };
          throw new Error(`contrived-protocol-input:${text}`);
        },
        dispose: () => {},
      }), processTrace, warn);
      const owner = {};
      try {
        await trace.arm(owner);
        expect(await trace.capture(owner, file, performance.now() + 1)).toEqual({
          status: "failed", phase: phases[index], category: "protocol",
        });
        expect(warn.mock.calls).toEqual([["Could not save Chromium trace"]]);
        expect(await fs.readdir(root.path)).toEqual([]);
      } finally {
        await trace.release(owner);
      }
    }));
  } finally {
    await root.cleanup();
  }
});
