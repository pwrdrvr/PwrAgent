import { describe, expect, it } from "vitest";
import { MAX_NATIVE_SPANS, summarizeNativeCpuTrace } from "../diagnostics/native-cpu-trace";
const span = (name: string, ts: number, dur: number, extra = {}) => ({
  ph: "X", cat: "toplevel", pid: 1, tid: 2, name, ts, dur, ...extra,
});
describe("native trace attribution boundary", () => {
  it("preserves the 700ms JS child of a 700ms IPC parent and unions both clocks", () => {
    const result = summarizeNativeCpuTrace({ traceEvents: [
      span("Receive mojo message", 10, 700_000, { tts: 20, tdur: 699_000 }),
      span("V8.Execute", 11, 699_999, { tts: 21, tdur: 698_999 }),
    ] });
    expect(result.spans[1].parent).toBe(0);
    expect(result.threads[0]).toMatchObject({ wallUnionUs: 700_000, threadCpuUnionUs: 699_000 });
  });
  it("retains B/E nesting and thread timing while reporting incomplete boundaries", () => {
    const result = summarizeNativeCpuTrace({ traceEvents: [
      { ...span("RunTask", 10, 0), ph: "B", tts: 1 },
      { ...span("Layout", 20, 0), ph: "B", tts: 2 },
      { ...span("ignored", 40, 0), ph: "E", tts: 12 },
      { ...span("ignored", 60, 0), ph: "E", tts: 20 },
      { ...span("ignored", 70, 0), ph: "E" },
      { ...span("RunTask", 80, 0), ph: "B" },
    ] });
    expect(result.spans.map((s) => [s.name, s.dur, s.tdur, s.parent])).toEqual([
      ["RunTask", 50, 19, null], ["Layout", 20, 10, 0],
    ]);
    expect(result.coverage.incompleteSpans).toBe(2);
  });
  it("does not infer CPU from wall time or add different threads together", () => {
    const result = summarizeNativeCpuTrace({ traceEvents: [
      span("RunTask", 0, 700), span("V8.Execute", 0, 700, { tid: 3 }),
    ] });
    expect(result.threads.map((t) => t.threadCpuUnionUs)).toEqual([null, null]);
    expect(result.threads.map((t) => t.wallUnionUs)).toEqual([700, 700]);
  });
  it("exports no untrusted strings, IDs, args, stacks, DOM text or user timing", () => {
    const secret = "operator-content";
    const result = summarizeNativeCpuTrace({ traceEvents: [
      span(secret, 0, 10, { cat: "ipc", args: { text: secret }, id: secret, stack: secret }),
      span(secret, 0, 10, { cat: "blink.user_timing" }),
      { ...span("thread_name", 0, 0), ph: "M", args: { name: secret } },
      span("RunTask", NaN, 1), span("RunTask", 0, Infinity),
      span("RunTask", 0, 1, { pid: secret }),
    ] });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0].name).toBe("ipc-or-mojo");
    expect(result.threads[0].role).toBe("other");
  });
  it("reports coverage, crossing spans and a bounded export without claiming exclusivity", () => {
    const result = summarizeNativeCpuTrace({ traceEvents: [
      span("RunTask", 0, 10), span("Layout", 5, 10),
      ...Array.from({ length: MAX_NATIVE_SPANS }, () => span("Paint", 20, 1)),
    ] });
    expect(result.spans).toHaveLength(MAX_NATIVE_SPANS);
    expect(result.coverage).toMatchObject({ firstTraceTs: 0, lastTraceTs: 21, crossingSpans: 1, omittedSpans: 2 });
    expect(result.threads[0].wallUnionUs).toBe(16);
    expect(result.semantics).toContain("never exclusive");
  });
});
