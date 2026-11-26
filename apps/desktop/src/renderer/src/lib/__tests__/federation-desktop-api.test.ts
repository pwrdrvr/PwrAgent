import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import { scopeDesktopApiToFederationTarget } from "../federation-desktop-api";
import { threadJobMonitorControl } from "../job-monitor-control";

describe("scopeDesktopApiToFederationTarget", () => {
  it("can clear a saved ACP opt-out after the runtime loses refresh support", async () => {
    const thread: NavigationThreadSummary = { source: "acp:grok", id: "grok-thread", title: "Fixture",
      titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: true }, jobMonitorCreationEnabled: false };
    const setThreadJobMonitorCreation = vi.fn(async () => ({ threadId: thread.id, enabled: true }));
    const api = { setThreadJobMonitorCreation };
    const restore = threadJobMonitorControl(api, thread, undefined);
    expect(restore).toBeDefined();
    await restore?.(true);
    expect(setThreadJobMonitorCreation).toHaveBeenCalledExactlyOnceWith({
      backend: "acp:grok", threadId: thread.id, enabled: true,
    });
    expect(threadJobMonitorControl(api, { ...thread, jobMonitorCreationEnabled: undefined }, undefined)).toBeUndefined();
  });

  it("exposes the Job Monitor toggle for a verified ACP session on its local owner", async () => {
    const thread: NavigationThreadSummary = { source: "acp:grok", id: "grok-thread",
      title: "Fixture", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: true } };
    const setThreadJobMonitorCreation = vi.fn(async () => ({ threadId: thread.id, enabled: false }));
    const api = { setThreadJobMonitorCreation };
    expect(threadJobMonitorControl(api, thread, undefined)).toBeUndefined();
    const verified = { ...thread, jobMonitorCreationControl: true } as const;
    expect(threadJobMonitorControl(api, verified, { scope: "remote", instanceId: "peer" })).toBeUndefined();
    const toggle = threadJobMonitorControl(api, verified, undefined);
    expect(toggle).toBeDefined();
    await toggle?.(false);
    expect(setThreadJobMonitorCreation).toHaveBeenCalledExactlyOnceWith({
      backend: thread.source, threadId: thread.id, enabled: false,
    });
  });

  it("binds a Job Monitor toggle to a capable thread owner even after selection changes", async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1 }), fc.boolean(), fc.boolean(), fc.boolean(),
      async (threadId, capable, connected, enabled) => {
        const setThreadJobMonitorCreation = vi.fn(async () => ({ threadId, enabled }));
        const desktopApi = { setThreadJobMonitorCreation };
        const viewer = { scope: "remote", instanceId: "viewer-window" } as const;
        const owner = { scope: "remote", instanceId: "owner" } as const;
        const thread: NavigationThreadSummary = { source: "codex", id: threadId,
          title: "Fixture", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false } };
        expect(threadJobMonitorControl(desktopApi, thread, viewer)).toBeUndefined();
        expect(threadJobMonitorControl(desktopApi, { ...thread, source: "acp:kimi" }, undefined)).toBeUndefined();
        const peerThread: NavigationThreadSummary = { ...thread, federation: {
          ref: { backend: "codex", threadId, target: owner }, instanceLabel: "Fixture owner",
          peerStatus: connected ? "connected" : "disconnected",
          capabilities: capable ? ["thread_job_monitor_control", "turn_control"] : ["turn_control"],
        } };
        const toggle = threadJobMonitorControl(scopeDesktopApiToFederationTarget(desktopApi, owner), peerThread, viewer);
        if (capable && connected) {
          const selectedLocal = threadJobMonitorControl(desktopApi, thread, undefined);
          await selectedLocal?.(!enabled);
          await toggle?.(enabled);
          expect(setThreadJobMonitorCreation.mock.calls).toEqual([
            [{ threadId, enabled: !enabled }], [{ threadId, enabled, federationTarget: owner }],
          ]);
        } else {
          expect(toggle).toBeUndefined();
          expect(setThreadJobMonitorCreation).not.toHaveBeenCalled();
        }
      },
    ), { numRuns: 30 });
  });
  it("scopes MCP inventory, selection, and verification to the thread owner", async () => {
    const listMcpConnections = vi.fn();
    const readThreadMcpConnections = vi.fn();
    const setThreadMcpConnections = vi.fn();
    const describeThreadMcpConnections = vi.fn();
    const target = { scope: "remote" as const, instanceId: "owner" };
    const api = scopeDesktopApiToFederationTarget({
      listMcpConnections, readThreadMcpConnections,
      setThreadMcpConnections, describeThreadMcpConnections,
    }, target)!;
    const thread = { backend: "codex" as const, threadId: "collision" };

    await api.listMcpConnections!();
    expect(listMcpConnections).toHaveBeenLastCalledWith({ federationTarget: target });
    await api.listMcpConnections!({ sandboxerStatusMaxAgeMs: 2_000 });
    expect(listMcpConnections).toHaveBeenLastCalledWith({ sandboxerStatusMaxAgeMs: 2_000, federationTarget: target });
    await api.readThreadMcpConnections!(thread);
    expect(readThreadMcpConnections).toHaveBeenCalledExactlyOnceWith({ ...thread, federationTarget: target });
    await api.setThreadMcpConnections!({ ...thread, connectionIds: [], providerServersEnabled: false, federationTarget: { scope: "remote", instanceId: "viewer" } });
    expect(setThreadMcpConnections).toHaveBeenCalledExactlyOnceWith({ ...thread, connectionIds: [], providerServersEnabled: false, federationTarget: target });
    await api.describeThreadMcpConnections!(thread);
    expect(describeThreadMcpConnections).toHaveBeenCalledExactlyOnceWith({ ...thread, federationTarget: target });
  });

  it("scopes Agent and Token Miser mutations to the selected owner", async () => {
    const setThreadAgent = vi.fn();
    const setThreadTokenMiser = vi.fn();
    const target = { scope: "remote" as const, instanceId: "owner" };
    const api = scopeDesktopApiToFederationTarget({ setThreadAgent, setThreadTokenMiser }, target)!;
    await api.setThreadAgent!({ threadId: "collision", agent: null });
    await api.setThreadTokenMiser!({ threadId: "collision", enabled: null, federationTarget: { scope: "local" } });
    expect(setThreadAgent).toHaveBeenCalledExactlyOnceWith({ threadId: "collision", agent: null, federationTarget: target });
    expect(setThreadTokenMiser).toHaveBeenCalledExactlyOnceWith({ threadId: "collision", enabled: null, federationTarget: target });
  });

  it("reads usage activity from the owner whose limits the rail describes", async () => {
    const readUsageActivity = vi.fn();
    const target = { scope: "remote" as const, instanceId: "owner" };
    const api = scopeDesktopApiToFederationTarget({ readUsageActivity } as DesktopApi, target)!;
    await api.readUsageActivity!({ from: 1, to: 2 });
    expect(readUsageActivity).toHaveBeenCalledExactlyOnceWith({ from: 1, to: 2, federationTarget: target });
  });

  it("routes remote filesystem operations to the owning peer and removes local path helpers", async () => {
    const openApplication = vi.fn(async () => ({ opened: true }));
    const refreshDirectoryGitStatuses = vi.fn(async () => ({
      scheduledCount: 1,
    }));
    const readPwrSnapConnectionStatus = vi.fn(async () => ({
      connectionId: "pwrsnap" as const,
      displayName: "PwrSnap" as const,
      availability: "running" as const,
      configured: true,
    }));
    const listWorktreeUnpublishedCommits = vi.fn(async () => ({
      commits: [],
      totalCommits: 0,
      truncated: false,
      maxCommits: 20,
      maxFilesPerCommit: 50,
    }));
    const getWorktreeUnpublishedCommitDiff = vi.fn(async () => ({}));
    const desktopApi = {
      openApplication,
      refreshDirectoryGitStatuses,
      readPwrSnapConnectionStatus,
      listWorktreeUnpublishedCommits,
      getWorktreeUnpublishedCommitDiff,
      connectPwrSnap: vi.fn(),
      openPwrSnap: vi.fn(),
      openPwrSnapDownload: vi.fn(),
      readPwrGitConnectionStatus: vi.fn(),
      connectPwrGit: vi.fn(),
      openPwrGit: vi.fn(),
      openPwrGitDownload: vi.fn(),
      openPath: vi.fn(),
      revealPath: vi.fn(),
      readMarkdownFile: vi.fn(),
      openMarkdownFileViewer: vi.fn(),
      readMarkdownFileViewerSnapshot: vi.fn(),
      onMarkdownFileViewerSnapshotChanged: vi.fn(),
    } as DesktopApi;
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };

    const scopedApi = scopeDesktopApiToFederationTarget(
      desktopApi,
      federationTarget,
    );
    await scopedApi?.openApplication?.({
      applicationId: "vscode",
      kind: "editor",
      targetPath: "/remote/repo/file.ts",
    });
    await scopedApi?.refreshDirectoryGitStatuses?.({
      directoryKeys: ["directory:/remote/repo"],
      force: true,
    });
    await scopedApi?.readPwrSnapConnectionStatus?.();
    await scopedApi?.listWorktreeUnpublishedCommits?.({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/remote/repo",
    });
    await scopedApi?.getWorktreeUnpublishedCommitDiff?.({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/remote/repo",
      commitSha: "a".repeat(40),
      path: "/remote/repo/file.ts",
    });

    expect(openApplication).toHaveBeenCalledWith({
      applicationId: "vscode",
      kind: "editor",
      targetPath: "/remote/repo/file.ts",
      federationTarget,
    });
    expect(refreshDirectoryGitStatuses).toHaveBeenCalledWith({
      directoryKeys: ["directory:/remote/repo"],
      force: true,
      federationTarget,
    });
    expect(readPwrSnapConnectionStatus).toHaveBeenCalledWith({
      federationTarget,
    });
    expect(listWorktreeUnpublishedCommits).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/remote/repo",
      federationTarget,
    });
    expect(getWorktreeUnpublishedCommitDiff).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/remote/repo",
      commitSha: "a".repeat(40),
      path: "/remote/repo/file.ts",
      federationTarget,
    });
    expect(scopedApi?.connectPwrSnap).toBeUndefined();
    expect(scopedApi?.openPwrSnap).toBeUndefined();
    expect(scopedApi?.openPwrSnapDownload).toBeUndefined();
    // A viewer's own PwrGit says nothing about the owner's machine.
    expect(scopedApi?.readPwrGitConnectionStatus).toBeUndefined();
    expect(scopedApi?.connectPwrGit).toBeUndefined();
    expect(scopedApi?.openPwrGit).toBeUndefined();
    expect(scopedApi?.openPwrGitDownload).toBeUndefined();
    expect(scopedApi?.openPath).toBeUndefined();
    expect(scopedApi?.revealPath).toBeUndefined();
    const thread = { backend: "codex" as const, threadId: "thread-1" };
    await scopedApi?.readMarkdownFile?.({ path: "/remote/report.md", thread, federationTarget: { scope: "local" } });
    expect(desktopApi.readMarkdownFile).toHaveBeenCalledWith({ path: "/remote/report.md", thread, federationTarget });
    await scopedApi?.openMarkdownFileViewer?.({
      context: { key: "thread-1", title: "Files", thread },
      file: { path: "/remote/report.md", label: "Report" },
    });
    expect(desktopApi.openMarkdownFileViewer).toHaveBeenCalledWith({
      context: { key: "remote:remote-instance:thread-1", title: "Files", thread, federationTarget },
      file: { path: "/remote/report.md", label: "Report" },
    });
    expect(scopedApi?.readMarkdownFileViewerSnapshot).toBeUndefined();
    expect(scopedApi?.onMarkdownFileViewerSnapshotChanged).toBeUndefined();
  });

  it("keeps the local desktop API unchanged without a remote target", () => {
    const desktopApi: DesktopApi = { openPath: vi.fn() };

    expect(scopeDesktopApiToFederationTarget(desktopApi, undefined)).toBe(
      desktopApi,
    );
  });

  it("scopes thread Research APIs and bus updates to the owner and removes local-only helpers", async () => {
    let agentListener: ((event: unknown) => void) | undefined;
    const target = { scope: "remote" as const, instanceId: "owner-mac" };
    const researchSnapshot = vi.fn(async () => ({ runs: [], writableRunIds: [] }));
    const researchChanges = vi.fn(async () => ({ runId: "r1", revision: 1, state: {} as never, items: [], writable: true }));
    const readResearchEvents = vi.fn(async () => ({ runId: "r1", revision: 1, events: [] }));
    const searchResearch = vi.fn(async () => ({ runId: "r1", revision: 1, total: 0, items: [] }));
    const readResearchItem = vi.fn(async () => ({ run: {} as never, item: {} as never }));
    const updateResearchItem = vi.fn(async () => ({ run: {} as never, item: {} as never }));
    const prepareResearch = vi.fn(async () => ({ intentId: "intent-1" }));
    const withdrawResearch = vi.fn(async () => {});
    const updateResearch = vi.fn(async () => ({ runId: "r1", revision: 2, status: "stopped" as const }));
    const researchHarnessStatus = vi.fn(async () => ({ configured: false, source: "mathos" as const }));
    const checkResearchHarness = vi.fn(async () => ({ ok: false as const, checkedAt: 1, error: "not configured" }));
    const startResearchHarness = vi.fn(async () => ({ runId: "r2", revision: 1, status: "running" as const }));
    const reconcileResearchHarness = vi.fn(async () => ({ runId: "r2", revision: 2, status: "running" as const }));
    const listMathosSwarms = vi.fn(async () => ({ ok: true as const, swarms: [], sessions: 0, truncated: false }));
    const submitThreadReply = vi.fn(async () => ({ backend: "codex" as const, threadId: "t1", queueEntryId: "q-1", queueStatus: "started" as const, turnId: "turn-1" }));
    const onAgentEvent = vi.fn((cb: (event: unknown) => void) => { agentListener = cb; return () => {}; });

    const scoped = scopeDesktopApiToFederationTarget({
      researchSnapshot, researchChanges, readResearchEvents, searchResearch, readResearchItem, updateResearchItem,
      prepareResearch, withdrawResearch, updateResearch, researchHarnessStatus, checkResearchHarness,
      startResearchHarness, reconcileResearchHarness, listMathosSwarms, submitThreadReply,
      onAgentEvent: onAgentEvent as unknown as DesktopApi["onAgentEvent"],
      onResearchChanged: vi.fn(() => () => {}),
      openResearchEvidence: vi.fn(),
      revealResearchHarnessConfig: vi.fn(),
      checkResearchHarnessBridge: vi.fn(),
      pickResearchHarnessBridge: vi.fn(),
      listMathosTeams: vi.fn(),
      researchProfileRuns: vi.fn(),
      openResearchWindow: vi.fn(),
    } as DesktopApi, target)!;

    await scoped.researchSnapshot!({ backend: "codex", threadId: "t1" });
    await scoped.researchChanges!({ backend: "codex", threadId: "t1", runId: "r1" });
    await scoped.readResearchEvents!({ backend: "codex", threadId: "t1", runId: "r1", range: { limit: 10 } });
    await scoped.searchResearch!({ backend: "codex", threadId: "t1", runId: "r1", query: {} });
    await scoped.readResearchItem!({ backend: "codex", threadId: "t1", runId: "r1", itemId: "i1" });
    await scoped.updateResearchItem!({
      backend: "codex", threadId: "t1", runId: "r1", requestId: "w1",
      command: { action: "work", itemId: "i1", expectedVersion: 1, state: "claimed", reason: "Check" },
    });
    await scoped.prepareResearch!({ backend: "codex", threadId: "t1", objective: "Obj", workers: 2, workspaceMode: "none" });
    await scoped.withdrawResearch!({ backend: "codex", threadId: "t1" });
    await scoped.updateResearch!({ backend: "codex", threadId: "t1", runId: "r1", requestId: "u1", command: { action: "stop", reason: "Stop" } });
    await scoped.researchHarnessStatus!({ backend: "codex", threadId: "t1" });
    await scoped.checkResearchHarness!({ backend: "codex", threadId: "t1" });
    await scoped.startResearchHarness!({
      backend: "codex", threadId: "t1", requestId: "h1", mode: "import",
      project: "p", session: "s", swarm: "sw", objective: "Import", budgetAcknowledged: false,
    });
    await scoped.reconcileResearchHarness!({ backend: "codex", threadId: "t1", runId: "r2" });
    await scoped.listMathosSwarms!();
    await scoped.submitThreadReply!({ backend: "codex", threadId: "t1", input: [{ type: "text", text: "Go" }] });

    for (const fn of [
      researchSnapshot, researchChanges, readResearchEvents, searchResearch, readResearchItem, updateResearchItem,
      prepareResearch, withdrawResearch, updateResearch, researchHarnessStatus, checkResearchHarness,
      startResearchHarness, reconcileResearchHarness, listMathosSwarms, submitThreadReply,
    ]) {
      expect(fn).toHaveBeenCalledWith(expect.objectContaining({ federationTarget: target }));
    }

    const received: unknown[] = [];
    scoped.onResearchChanged!((change) => received.push(change));
    agentListener!({ backend: "codex", notification: { method: "thread/research/changed", params: { backend: "codex", threadId: "t1", runId: "local", revision: 1 } } });
    agentListener!({ backend: "codex", federationTarget: { scope: "remote", instanceId: "other" }, notification: { method: "thread/research/changed", params: { backend: "codex", threadId: "t1", runId: "other", revision: 1 } } });
    agentListener!({ backend: "codex", federationTarget: target, notification: { method: "thread/research/changed", params: { backend: "codex", threadId: "t1", runId: "r1", revision: 3 } } });
    expect(received).toEqual([{ backend: "codex", threadId: "t1", runId: "r1", revision: 3 }]);

    expect(scoped.openResearchEvidence).toBeUndefined();
    expect(scoped.revealResearchHarnessConfig).toBeUndefined();
    expect(scoped.checkResearchHarnessBridge).toBeUndefined();
    expect(scoped.pickResearchHarnessBridge).toBeUndefined();
    expect(scoped.listMathosTeams).toBeUndefined();
    expect(scoped.researchProfileRuns).toBeUndefined();
    expect(scoped.openResearchWindow).toBeUndefined();
  });
});
