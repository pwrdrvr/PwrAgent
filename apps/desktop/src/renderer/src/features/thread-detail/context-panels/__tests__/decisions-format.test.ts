import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DecisionsRailBatch } from "@pwragent/shared/decisions-rail";
import {
  decisionBatchStatusLabel,
  decisionBatchTimingLine,
  decisionBatchTone,
  decisionInputSchemaSummary,
  decisionsRailHasContent,
  decisionsRailPollDelayMs,
  formatDecisionDuration,
  formatDecisionRate,
} from "../decisions-format";

const NOW = new Date(2026, 10, 19, 14, 4, 41).getTime();

const batch: DecisionsRailBatch = {
  batchId: "batch_1",
  decisionId: "dec_1",
  name: "diff_risk",
  version: 1,
  adHoc: false,
  provider: "jev",
  state: "completed",
  stopping: false,
  background: false,
  count: 48,
  finished: 48,
  succeeded: 48,
  failed: 0,
  skipped: 0,
  concurrency: 8,
  createdAt: NOW - 60_000,
  startedAt: NOW - 60_000,
  finishedAt: NOW - 50_800,
  wallMs: 9_200,
  itemsPerSecond: 48 / 9.2,
  latency: { samples: 48, meanMs: 95, maxMs: 310 },
  hasResultsFile: true,
};

describe("decisions format", () => {
  it("formats durations at each scale", () => {
    expect(formatDecisionDuration(95)).toBe("95 ms");
    expect(formatDecisionDuration(9_200)).toBe("9.2 s");
    expect(formatDecisionDuration(161_000)).toBe("2m 41s");
    expect(formatDecisionDuration(3_840_000)).toBe("1h 4m");
    expect(formatDecisionDuration(59_960)).toBe("1m 0s");
  });

  // Rule: a longer duration never reads as a shorter one. Oracle: the
  // number of milliseconds each label stands for.
  it("never orders two durations backwards", () => {
    const parse = (label: string): number => {
      const ms = /^(\d+) ms$/.exec(label);
      if (ms) return Number(ms[1]);
      const s = /^([\d.]+) s$/.exec(label);
      if (s) return Number(s[1]) * 1_000;
      const m = /^(\d+)m (\d+)s$/.exec(label);
      if (m) return Number(m[1]) * 60_000 + Number(m[2]) * 1_000;
      const h = /^(\d+)h (\d+)m$/.exec(label)!;
      return Number(h[1]) * 3_600_000 + Number(h[2]) * 60_000;
    };
    fc.assert(fc.property(fc.nat(10_000_000), fc.nat(10_000_000), (left, right) => {
      fc.pre(left <= right);
      expect(parse(formatDecisionDuration(left))).toBeLessThanOrEqual(parse(formatDecisionDuration(right)));
    }));
  });

  it("formats throughput", () => {
    expect(formatDecisionRate(48 / 9.2)).toBe("5.2/s");
    expect(formatDecisionRate(12.4)).toBe("12/s");
    expect(formatDecisionRate(0.25)).toBe("0.25/s");
    expect(formatDecisionRate(0)).toBe("—");
  });

  it("summarizes an input schema by its properties", () => {
    expect(decisionInputSchemaSummary({ type: "object", properties: { title: { type: "string" }, labels: { type: "array" } } }))
      .toBe("{ title, labels[] }");
    expect(decisionInputSchemaSummary({ type: "string" })).toBe("text");
    expect(decisionInputSchemaSummary({})).toBe("text or any object");
  });

  it("says why a batch stopped instead of its timing", () => {
    expect(decisionBatchTimingLine(batch, NOW)).toMatch(/^started [^·]+ · 9\.2 s · 5\.2\/s · mean 95 ms · max 310 ms$/);
    expect(decisionBatchTimingLine({
      ...batch,
      state: "stopped",
      finished: 120,
      succeeded: 12,
      failed: 1,
      skipped: 107,
      stoppedBy: { code: "credential_rejected", message: "rejected" },
    }, NOW)).toMatch(/credential_rejected after 13 items$/);
    // An operator's Stop reads like any finished batch.
    expect(decisionBatchTimingLine({ ...batch, state: "stopped", stoppedBy: { code: "stopped_by_operator", message: "Stopped." } }, NOW))
      .toContain("mean 95 ms");
  });

  // Rule: an operator's Stop is not a failure; an error's stop is.
  it("tones an operator's Stop as neutral and an error's as an error", () => {
    expect(decisionBatchTone({ ...batch, state: "stopped", stoppedBy: { code: "stopped_by_operator", message: "Stopped." } })).toBe("neutral");
    expect(decisionBatchTone({ ...batch, state: "stopped", stoppedBy: { code: "credential_rejected", message: "rejected" } })).toBe("error");
  });

  it("labels a stopping batch and polls fast only while one can move", () => {
    expect(decisionBatchStatusLabel({ state: "running", stopping: true })).toBe("Stopping");
    expect(decisionBatchStatusLabel({ state: "queued", stopping: false })).toBe("Waiting");
    expect(decisionsRailPollDelayMs({ now: NOW, decisions: [], batches: [{ ...batch, state: "running" }] })).toBe(2_000);
    expect(decisionsRailPollDelayMs({ now: NOW, decisions: [], batches: [batch] })).toBe(10_000);
    expect(decisionsRailHasContent({ now: NOW, decisions: [], batches: [] })).toBe(false);
    expect(decisionsRailHasContent({ now: NOW, decisions: [], batches: [batch] })).toBe(true);
  });
});
