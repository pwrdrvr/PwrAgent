import type { AgentEvent } from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import {
  FederatedDirectoryIndexCache,
  type FederatedDirectoryIdentity,
} from "../federated-directory-index-cache";
import type { ProjectIdentity } from "../federation-project-match";

const project: ProjectIdentity = { kind: "directory", label: "ProjectA", path: "/Users/me/ProjectA" };
const withProject: FederatedDirectoryIdentity[] = [
  { key: "workspace:new-thread", kind: "workspace", label: "Workspaces" },
  { key: "directory:/studio/ProjectA", kind: "directory", label: "ProjectA", path: "/studio/ProjectA" },
];
const withoutProject: FederatedDirectoryIdentity[] = [withProject[0]!];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const event = (instanceId: string, method: string, params: Record<string, unknown> = {}) => ({
  backend: "codex",
  federationTarget: { scope: "remote", instanceId },
  notification: { method, params },
}) as AgentEvent;

describe("FederatedDirectoryIndexCache", () => {
  it("does not keep a read the peer outdated while it was in flight", async () => {
    const cache = new FederatedDirectoryIndexCache();
    const stale = deferred<FederatedDirectoryIdentity[]>();
    const read = vi.fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(withProject);

    const first = cache.hasProject("studio", project, read);
    cache.observe(event("studio", "federation/peerStatus/changed", { instanceId: "studio", status: "connected" }));
    // A check after the change starts its own read instead of joining the old one.
    const second = cache.hasProject("studio", project, read);
    stale.resolve(withoutProject);

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    // The outdated answer was not kept, so the fresh one serves without a read.
    await expect(cache.hasProject("studio", project, read)).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not let a read that spanned a directory removal prove presence", async () => {
    const cache = new FederatedDirectoryIndexCache();
    const spanning = deferred<FederatedDirectoryIdentity[]>();
    const read = vi.fn()
      .mockReturnValueOnce(spanning.promise)
      .mockResolvedValueOnce(withoutProject);

    const check = cache.hasProject("studio", project, read);
    cache.observe(event("studio", "navigation/directory/removed", { directoryKey: "directory:/studio/ProjectA" }));
    // The owner answered from before the removal reached this window.
    spanning.resolve(withProject);
    await expect(check).resolves.toBe(true);

    await expect(cache.hasProject("studio", project, read)).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps the newer of two reads that land out of order", async () => {
    const cache = new FederatedDirectoryIndexCache();
    const older = cache.begin("studio");
    const newer = cache.begin("studio");
    cache.record(newer, withProject);
    cache.record(older, withoutProject);

    const read = vi.fn();
    await expect(cache.hasProject("studio", project, read)).resolves.toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it("never answers absence from what it holds", async () => {
    const cache = new FederatedDirectoryIndexCache();
    cache.record(cache.begin("studio"), withoutProject);
    const read = vi.fn().mockResolvedValue(withoutProject);

    await expect(cache.hasProject("studio", project, read)).resolves.toBe(false);
    await expect(cache.hasProject("studio", project, read)).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps nothing from a failed read", async () => {
    const cache = new FederatedDirectoryIndexCache();
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("The owner is still loading its directories."))
      .mockResolvedValueOnce(withProject);

    await expect(cache.hasProject("studio", project, read)).rejects.toThrow(/still loading/);
    await expect(cache.hasProject("studio", project, read)).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("drops a peer's index only for events that can change its directory set", () => {
    const cases: Array<[AgentEvent, boolean]> = [
      [event("studio", "federation/peerStatus/changed", { instanceId: "studio", status: "offline" }), true],
      [event("studio", "federation/eventStream/changed", { instanceId: "studio", epoch: "2" }), true],
      [event("studio", "navigation/directory/removed", { directoryKey: "directory:/studio/ProjectA" }), true],
      [event("studio", "navigation/threadDirectories/updated", { threadId: "thread-1" }), true],
      [event("studio", "thread/started", { thread: { id: "thread-1" } }), true],
      [event("studio", "navigation/invalidated", { sourceMethod: "navigation/directory/removed" }), true],
      [event("studio", "navigation/invalidated", { sourceMethod: "turn/completed", threadId: "thread-1" }), false],
      [event("studio", "turn/completed", { threadId: "thread-1" }), false],
      [event("studio", "navigation/directoryGitStatus/updated", { directoryKey: "directory:/studio/ProjectA" }), false],
      [event("studio", "item/agentMessage/delta", { threadId: "thread-1" }), false],
      // Another machine's event, or this machine's own, leaves the studio alone.
      [event("tower", "navigation/directory/removed", { directoryKey: "directory:/tower/ProjectA" }), false],
      [{ ...event("studio", "navigation/directory/removed"), federationTarget: undefined }, false],
    ];
    for (const [observed, drops] of cases) {
      const cache = new FederatedDirectoryIndexCache();
      cache.record(cache.begin("studio"), withProject);
      cache.observe(observed);
      const read = vi.fn().mockResolvedValue(withProject);
      void cache.hasProject("studio", project, read);
      expect({ method: observed.notification.method, params: observed.notification.params, drops })
        .toEqual({ method: observed.notification.method, params: observed.notification.params, drops: read.mock.calls.length > 0 });
    }
  });
});
