import fc from "fast-check";
import { expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { resolveBackgroundCleanupThread } from "../background-archive-cleanup-thread";

it("resolves blocker names only from an unambiguous identity on the owning instance", () => {
  fc.assert(fc.property(fc.uuid(), fc.uuid(), (threadId, owner) => {
    const row = (source: "codex" | "claude", instanceId?: string): NavigationThreadSummary => ({
      id: threadId, source, title: `${source} on ${instanceId ?? "local"}`, titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: true },
      ...(instanceId ? { federation: { instanceLabel: instanceId, ref: { backend: source, threadId,
        target: { scope: "remote" as const, instanceId } } } } : {}),
    });
    const local = row("codex");
    const remote = row("claude", owner);
    expect(resolveBackgroundCleanupThread({ threadId, instanceId: owner }, [local, remote]))
      .toEqual({ threadId, instanceId: owner, backend: "claude", title: remote.title });
    expect(resolveBackgroundCleanupThread({ threadId }, [remote])).toBeUndefined();
    expect(resolveBackgroundCleanupThread({ threadId, instanceId: owner }, [local])).toBeUndefined();
    expect(resolveBackgroundCleanupThread({ threadId }, [local, row("claude")])).toBeUndefined();
    expect(resolveBackgroundCleanupThread({ threadId, backend: "codex" }, [local, row("claude")]))
      .toMatchObject({ backend: "codex", title: local.title });
    expect(resolveBackgroundCleanupThread({ threadId, instanceId: owner }, [local], { scope: "remote", instanceId: owner }))
      .toMatchObject({ backend: "codex", title: local.title });
  }));
});
