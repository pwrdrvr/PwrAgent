import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";
import { canNestThread } from "../thread-nest-drop";

function thread(id: string, overrides: Partial<NavigationThreadSummary> = {}): NavigationThreadSummary {
  return {
    id,
    title: id,
    titleSource: "explicit",
    source: "codex",
    executionMode: "default",
    linkedDirectories: [],
    inbox: { inInbox: false },
    ...overrides,
  } as NavigationThreadSummary;
}

function remote(id: string, instanceId: string, capabilities: string[] = ["thread_grouping"]) {
  return thread(id, {
    federation: {
      capabilities,
      instanceLabel: instanceId,
      peerStatus: "connected",
      ref: { backend: "codex", target: { scope: "remote", instanceId }, threadId: id },
    },
  } as Partial<NavigationThreadSummary>);
}

function index(...threads: NavigationThreadSummary[]) {
  return new Map(threads.map((entry) => [threadSummaryIdentityKey(entry), entry]));
}

describe("canNestThread", () => {
  it("nests a root under another root, across providers", () => {
    const child = thread("child");
    const parent = thread("parent", { source: "acp:gemini" } as Partial<NavigationThreadSummary>);
    expect(canNestThread(child, parent, index(child, parent))).toBe(true);
  });

  it("refuses itself, its current parent, and every one of its own sub-threads", () => {
    const root = thread("root");
    const child = thread("child", { parentThreadId: "root", parentThreadBackend: "codex" });
    const grandchild = thread("grandchild", { parentThreadId: "child", parentThreadBackend: "codex" });
    const threads = index(root, child, grandchild);
    expect(canNestThread(root, root, threads)).toBe(false);
    expect(canNestThread(child, root, threads)).toBe(false);
    expect(canNestThread(root, child, threads)).toBe(false);
    expect(canNestThread(root, grandchild, threads)).toBe(false);
    // Moving a grandchild up to its grandparent is a real change.
    expect(canNestThread(grandchild, root, threads)).toBe(true);
  });

  it("keeps a link on the owner: one instance, one that can group, never a provider sub-agent", () => {
    const local = thread("local");
    const peerA = remote("peer-a", "pwr_a");
    const peerA2 = remote("peer-a2", "pwr_a");
    const peerB = remote("peer-b", "pwr_b");
    const older = remote("older", "pwr_a", ["thread_navigation"]);
    const worker = thread("worker", { codexNativeSubAgent: {} } as Partial<NavigationThreadSummary>);
    const threads = index(local, peerA, peerA2, peerB, older, worker);
    expect(canNestThread(peerA, peerA2, threads)).toBe(true);
    expect(canNestThread(peerA, peerB, threads)).toBe(false);
    expect(canNestThread(local, peerA, threads)).toBe(false);
    expect(canNestThread(peerA, local, threads)).toBe(false);
    expect(canNestThread(older, peerA, threads)).toBe(false);
    expect(canNestThread(peerA, older, threads)).toBe(false);
    expect(canNestThread(worker, local, threads)).toBe(false);
    expect(canNestThread(local, worker, threads)).toBe(false);
  });
});
