import { describe, expect, it, vi } from "vitest";
import { LaunchpadCreationOperations, LaunchpadCreationCancelledError, type LaunchpadCreationOperation } from "../app-server/launchpad-creation-operations";
import type { MaterializeDirectoryLaunchpadResponse } from "@pwragent/shared";

const request = { operationId: "creation-1", directoryKey: "repo", submittedAt: 1_000 };
const result: MaterializeDirectoryLaunchpadResponse = { backend: "codex", threadId: "thread-1", executionMode: "default", workMode: "local" };

describe("launchpad creation operations", () => {
  it("remembers cancellation that overtakes the startup request, scoped to its authenticated viewer", async () => {
    const operations = new LaunchpadCreationOperations();
    const work = vi.fn(async () => result);
    expect(operations.manage({ operationId: request.operationId, action: "cancel" }, "viewer").cancellationAccepted).toBe(true);
    await expect(operations.run(request, "viewer", work)).rejects.toBeInstanceOf(LaunchpadCreationCancelledError);
    expect(work).not.toHaveBeenCalled();
    expect(operations.manage({ operationId: request.operationId, action: "read" }, "other").operation).toBeUndefined();
    await expect(operations.run(request, "other", work)).resolves.toEqual(result);
  });

  it("deduplicates creation and recovers its final response after a reconnect", async () => {
    const operations = new LaunchpadCreationOperations();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const work = vi.fn(async (operation: LaunchpadCreationOperation) => {
      await gate;
      operation.commit();
      return result;
    });
    const first = operations.run(request, "viewer", work);
    const second = operations.run(request, "viewer", work);
    expect(first).toBe(second);
    finish();
    await first;
    const snapshot = operations.manage({ operationId: request.operationId, action: "read" }, "viewer");
    expect(snapshot.operation).toMatchObject({ phase: "completed", result, submittedAt: 1_000 });
    expect(work).toHaveBeenCalledOnce();
    expect(operations.manage({ operationId: request.operationId, action: "cancel" }, "viewer").cancellationAccepted).toBe(false);
  });

  it("cancels before the dispatch gate but refuses cancellation after it", async () => {
    const operations = new LaunchpadCreationOperations();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const turn = vi.fn();
    const running = operations.run(request, undefined, async (operation) => {
      await gate;
      operation.commit();
      turn();
      return result;
    });
    const rejected = expect(running).rejects.toBeInstanceOf(LaunchpadCreationCancelledError);
    expect(operations.manage({ operationId: request.operationId, action: "cancel" }).cancellationAccepted).toBe(true);
    release();
    await rejected;
    expect(turn).not.toHaveBeenCalled();
  });
});
