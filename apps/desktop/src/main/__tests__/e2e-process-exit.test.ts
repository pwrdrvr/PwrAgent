import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectDescendantPids,
  isPidAlive,
  waitForPidsToExit,
} from "../../../e2e/fixtures/process-exit";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("E2E process exit helpers", () => {
  it("collects nested descendants without including unrelated processes", () => {
    const processTable = [
      "101 50",
      "102 101",
      "103 102",
      "201 99",
      "not a process row",
    ].join("\n");

    expect(collectDescendantPids(50, processTable)).toEqual([101, 102, 103]);
  });

  it("treats EPERM as alive and other signal errors as exited", () => {
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    });

    expect(isPidAlive(101)).toBe(true);
    expect(isPidAlive(102)).toBe(false);
  });

  it("returns immediately when every watched process has already exited", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    });

    await expect(waitForPidsToExit([101], 5_000, 100)).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls until parent and helper processes have both exited", async () => {
    vi.useFakeTimers();
    const livePids = new Set([101, 102]);
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (!livePids.has(Number(pid))) {
        throw Object.assign(new Error("missing"), { code: "ESRCH" });
      }
      return true;
    });

    const waiting = waitForPidsToExit(livePids, 5_000, 100);
    livePids.delete(101);
    await vi.advanceTimersByTimeAsync(100);
    livePids.delete(102);
    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toEqual([]);
  });

  it("reports survivors when the polling budget expires", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockReturnValue(true);

    const waiting = waitForPidsToExit([101], 200, 100);
    await vi.advanceTimersByTimeAsync(200);

    await expect(waiting).resolves.toEqual([101]);
  });
});
