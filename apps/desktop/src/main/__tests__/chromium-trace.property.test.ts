import fs from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { ChromiumTrace, filterChromiumTrace } from "../diagnostics/chromium-trace";
import { acquireChromiumTrace, tryAcquireChromiumTrace } from "../diagnostics/chromium-trace-lease";
import { createTemporaryTestDirectory } from "../shell/testing/test-harness";

const layout = { name: "Layout", pid: 4, tid: 2, ph: "X", cat: "devtools.timeline", ts: 312, dur: 5 };
const rawTrace = JSON.stringify({ traceEvents: [layout] });
const noTrace = new Error("Failed to stop tracing - no trace in progress");

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
        const stopRecording = vi.fn(async (file: string) => {
          expect(recording).toBe(true);
          recording = false;
          expect(path.dirname(file)).not.toBe(root.path);
          await fs.writeFile(file, rawTrace);
          return file;
        });
        const warn = vi.fn();
        const times = [...wallTimes];
        const trace = new ChromiumTrace(() => ({ startRecording, stopRecording }), warn, {
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
            record_mode: "record-continuously", trace_buffer_size_in_kb: 32 * 1024,
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
  const stopRecording = vi.fn(async (file: string) => file);
  const trace = new ChromiumTrace(() => ({ startRecording, stopRecording }), vi.fn());
  const first = {};
  const last = {};
  const manual = acquireChromiumTrace();
  try {
    await trace.arm(first);
    await trace.arm(last);
    expect(startRecording).not.toHaveBeenCalled();
    expect(stopRecording).not.toHaveBeenCalled();
    manual();
    await armed;
    await trace.release(first);
    expect(stopRecording).not.toHaveBeenCalled();
    expect(tryAcquireChromiumTrace()).toBeUndefined();
    await trace.release(last);
    expect(stopRecording).toHaveBeenCalledOnce();
    const available = acquireChromiumTrace();
    available();
  } finally {
    manual();
    await trace.release(first);
    await trace.release(last);
  }
});

it("bounds missing native start and stop acknowledgements and recovers before reusing the recorder", async () => {
  let nativeRecording = false;
  let mono = 0;
  let privatePath = "";
  const startRecording = vi.fn(async () => {
    nativeRecording = true;
  }).mockImplementationOnce(() => {
    nativeRecording = true;
    return new Promise<void>(() => {});
  });
  const stopRecording = vi.fn(async (file: string) => {
    if (!nativeRecording) throw noTrace;
    nativeRecording = false;
    return file;
  });
  const warning = vi.fn();
  const trace = new ChromiumTrace(() => ({ startRecording, stopRecording }), warning, {
    monotonicNow: () => ++mono, startTimeoutMs: 20, stopTimeoutMs: 20,
  });
  const owner = {};
  const root = await createTemporaryTestDirectory();
  const file = path.join(root.path, "never-published.trace.json");
  try {
    await trace.arm(owner);
    expect(await trace.capture(owner, file, ++mono)).toMatchObject({ status: "skipped" });
    await trace.arm(owner);
    expect(startRecording).toHaveBeenCalledTimes(2);
    stopRecording.mockImplementationOnce((destination) => {
      nativeRecording = false;
      privatePath = destination;
      return new Promise<string>(() => {});
    });
    expect(await trace.capture(owner, file, ++mono)).toEqual({ status: "failed" });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.dirname(privatePath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(warning).toHaveBeenCalledTimes(2);
    await trace.arm(owner);
    expect(startRecording).toHaveBeenCalledTimes(3);
  } finally {
    await trace.release(owner);
    await root.cleanup();
  }
});
