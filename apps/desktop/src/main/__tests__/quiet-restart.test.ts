import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { QuietRestartTarget } from "../app-server/backend-registry-types";
import { runQuietRestart, type QuietRestartDependencies } from "../shell/quiet-restart";

const target: QuietRestartTarget = { backend: "codex", threadId: "thread-1", turnId: "turn-1" };

function dependencies(overrides: Partial<QuietRestartDependencies["registry"]> = {}) {
  const calls: string[] = [];
  const registry: QuietRestartDependencies["registry"] = {
    cancelQuietRestart: vi.fn(),
    beginQuietRestart: vi.fn(() => {
      calls.push("begin");
      return [target];
    }),
    saveRestartContinuations: vi.fn(() => {
      calls.push("save");
      return 1;
    }),
    steerTurnsForQuietRestart: vi.fn(async () => {
      calls.push("steer");
      return 1;
    }),
    waitForQuietRestartTurns: vi.fn(async () => {
      calls.push("wait");
      return "ended" as const;
    }),
    ...overrides,
  };
  const terminateActions = vi.fn(async () => {
    calls.push("terminate");
    return 2;
  });
  const log = { info: vi.fn(), warn: vi.fn() };
  return { calls, registry, terminateActions, log };
}

describe("runQuietRestart", () => {
  it("saves continuations before stopping anything, then steers, terminates, and waits", async () => {
    const deps = dependencies();
    const summary = await runQuietRestart({
      ...deps,
      now: () => 1_000,
      turnGraceMs: 7_000,
      actionGraceMs: 2_000,
    });
    expect(deps.calls.slice(0, 2)).toEqual(["begin", "save"]);
    expect(deps.calls.slice(2, 4).sort()).toEqual(["steer", "terminate"]);
    expect(deps.calls.slice(4)).toEqual(["wait", "save"]);
    expect(deps.registry.saveRestartContinuations).toHaveBeenCalledWith([target], 1_000, true);
    expect(deps.terminateActions).toHaveBeenCalledWith(2_000);
    expect(deps.registry.waitForQuietRestartTurns).toHaveBeenCalledWith([target], 7_000);
    expect(summary).toEqual({
      runningTurns: 1,
      continuations: 1,
      steered: 1,
      actionsTerminated: 2,
      turns: "ended",
      durationMs: 0,
    });
  });

  it("finishes cleanup after a steer fails, once the checkpoint succeeded", async () => {
    const deps = dependencies({
      steerTurnsForQuietRestart: vi.fn(async () => {
        throw new Error("steer refused");
      }),
    });
    const summary = await runQuietRestart(deps);
    expect(summary).toMatchObject({ runningTurns: 1, continuations: 1, steered: 0, actionsTerminated: 2, turns: "ended" });
    expect(deps.log.warn).toHaveBeenCalledWith("quiet restart step failed", expect.objectContaining({ step: "steer" }));
  });
});

it("never interrupts work if the initial durable checkpoint fails", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("disk full", "database busy", "storage unavailable"), fc.boolean(), async (failure, beginFails) => {
    const fail = vi.fn(() => { throw new Error(failure); });
    const deps = dependencies(beginFails ? { beginQuietRestart: fail } : { saveRestartContinuations: fail });
    const cancelQuietRestart = vi.fn();
    await expect(runQuietRestart({ ...deps, registry: { ...deps.registry, cancelQuietRestart } })).rejects.toThrow(failure);
    expect(cancelQuietRestart).toHaveBeenCalledOnce();
    expect(deps.terminateActions).not.toHaveBeenCalled();
    expect(deps.registry.steerTurnsForQuietRestart).not.toHaveBeenCalled();
  }));
});
