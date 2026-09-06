import { describe, expect, it, vi } from "vitest";
import type { PrAutoDispatchOutcome } from "../pr-status/pr-auto-dispatch";
import { logPrAutoDispatchOutcome } from "../pr-status/pr-auto-dispatch-log";

describe("PR auto-dispatch logging", () => {
  const levels = {
    scheduled: "info",
    dispatched: "info",
    "gate-off": "debug",
    "not-actionable": "debug",
    deferred: "debug",
    "missing-head": "debug",
    disabled: "debug",
    busy: "debug",
    pending: "debug",
    duplicate: "debug",
    "attempt-limit": "debug",
    cancelled: "debug",
    stale: "debug",
    failed: "warn",
  } satisfies Record<PrAutoDispatchOutcome["status"], "debug" | "info" | "warn">;

  it.each(Object.entries(levels))("logs %s at %s", (status, level) => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const outcome = {
      threadKey: "codex:thread-1",
      status: status as PrAutoDispatchOutcome["status"],
      fingerprint: "same-head-and-failure",
    };
    for (let poll = 0; poll < 3; poll += 1) {
      logPrAutoDispatchOutcome(logger, "github.com/org/repo#1", outcome);
    }
    expect(logger[level]).toHaveBeenCalledTimes(3);
    expect(logger[level]).toHaveBeenLastCalledWith("pr auto dispatch", {
      prKey: "github.com/org/repo#1",
      ...outcome,
    });
    for (const other of ["debug", "info", "warn"] as const) {
      if (other !== level) expect(logger[other]).not.toHaveBeenCalled();
    }
  });
});
