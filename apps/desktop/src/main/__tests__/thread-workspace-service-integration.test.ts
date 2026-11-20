import {
  execFileAsync,
  expectedDir,
  createAgentOverlay,
  createDeferred,
  git,
  pathExists,
  createOverlayStoreMock,
  MockBackendClient,
  createAcpAgentStoreMock,
  createAcpSessionStoreMock,
  createKimiAgentRecord,
  type KimiStartPrompt,
  createKimiAcpRegistry,
  callRegistryMcpTool,
  answerAcpSessionCancel,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import { launchpadStorageKey } from "@pwragent/shared";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared";
import type {
  AcpBackendId,
  AgentEvent,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerThreadSummary,
  CodexThreadEnvironmentRuntime,
  HandoffThreadWorkspaceResponse,
  LinkedDirectorySummary,
  ThreadExecutionMode,
  ThreadOverlayState,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { type CodexEnvironmentCommandRunner } from "../app-server/codex-environment-runtime";
import { GitDirectoryService } from "../app-server/git-directory-service";
import { GitWorkspaceHandoffService } from "../app-server/git-workspace-handoff-service";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";
import type { AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";
import type { Query as ClaudeQuery, SDKMessage as ClaudeMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentToolMcpServerLike } from "../agent-tools/agent-tool-mcp-server";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { createResearchAgentHandler } from "../research/research-runtime";
import { ResearchService } from "@pwragent/owner-core/research-service";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { bindResearchRegistry, createResearchRegistryPorts } from "../research/research-registry";

describe("DesktopBackendRegistry", () => {
  it("exports the authoritative handoff workspace while provider cwd synchronization is pending", async () => {
    const thread: AppServerThreadSummary = {
      id: "handoff-source", title: "Source", titleSource: "explicit", source: "codex", updatedAt: 1000,
      projectKey: "/old-checkout",
      linkedDirectories: [{ id: "/old-checkout", label: "repo", path: "/old-checkout", kind: "local" }],
    };
    const exported = {
      cwd: "/old-checkout", rolloutBase64: "b3BhcXVl",
      replay: { entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } },
    };
    const client = Object.assign(new MockBackendClient({ threads: [thread] }), {
      exportThreadForHandoff: vi.fn(async () => exported),
    });
    const overlayStore = createOverlayStoreMock({ overlays: {
      "codex:handoff-source": {
        backend: "codex", threadId: "handoff-source", executionMode: "default",
        extraLinkedDirectories: [{ id: "pwragent-handoff:codex:handoff-source", label: "repo", path: "/repo", kind: "worktree", worktreePath: "/new-checkout" }],
      },
    } });
    const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore });
    onTestFinished(() => registry.close());
    expect(await registry.exportThreadForHandoff(thread.id)).toEqual({ ...exported, cwd: "/new-checkout" });
  });

  it("registers an imported handoff worktree with its repository before navigation enrichment", async () => {
    const repositoryPath = "/repo/app";
    const worktreePath = "/worktrees/handoff/app";
    const prepareLaunchpadWorkspace = vi.fn();
    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const overlayStore = createOverlayStoreMock();
    const client = new MockBackendClient({ initializeResult: { methods: ["thread/fork"] } });
    const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore,
      gitDirectoryService: { prepareLaunchpadWorkspace, recordCodexWorktreeOwnerThread } as never,
    });
    onTestFinished(() => registry.close());
    const directoryNotifications: AgentEvent[] = [];
    const visibleThreads: AppServerThreadSummary[] = [];
    registry.onEvent(async (event) => {
      if (event.notification.method !== "navigation/threadDirectories/updated") return;
      directoryNotifications.push(event);
      // The owner refreshes project membership from a cheap listing. It must
      // see the imported link without selecting or enriching the thread first.
      visibleThreads.push(...await registry.listThreads({ backend: "codex", enrichDirectories: false }));
    });
    const response = await registry.forkThread({ backend: "codex", sourceThreadId: "source",
      directoryKind: "directory", directoryLabel: "app", directoryPath: `${worktreePath}/packages`, workMode: "worktree",
      importedWorktree: { repositoryPath, worktreePath },
    });
    expect(prepareLaunchpadWorkspace).not.toHaveBeenCalled();
    expect(client.lastForkThreadParams?.cwd).toBe(`${worktreePath}/packages`);
    expect(response.linkedDirectory).toMatchObject({ kind: "worktree", path: expectedDir(repositoryPath), worktreePath: expectedDir(worktreePath) });
    expect(await overlayStore.getThreadOverlayState({ backend: "codex", threadId: response.threadId }))
      .toMatchObject({ extraLinkedDirectories: [expect.objectContaining({ path: expectedDir(repositoryPath), worktreePath: expectedDir(worktreePath) })] });
    expect(recordCodexWorktreeOwnerThread).toHaveBeenCalledWith({ threadId: response.threadId, worktreePath });
    expect(directoryNotifications).toEqual([{
      backend: "codex",
      notification: {
        method: "navigation/threadDirectories/updated",
        params: { reason: "thread-created", threadIds: [response.threadId] },
      },
    }]);
    expect(visibleThreads.find((thread) => thread.id === response.threadId)?.linkedDirectories)
      .toEqual([expect.objectContaining({ kind: "worktree", path: expectedDir(repositoryPath), worktreePath: expectedDir(worktreePath) })]);
  });

  it("reads what a handoff inherits from its source thread", async () => {
    const overlayStore = createOverlayStoreMock({ overlays: {
      "codex:sol-source": {
        backend: "codex", threadId: "sol-source", extraLinkedDirectories: [],
        executionMode: "full-access", model: "gpt-6.1-sol", reasoningEffort: "high", fastMode: false,
      },
    } });
    const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({}), overlayStore });
    onTestFinished(() => registry.close());
    await expect(registry.readThreadHandoffSettings({ backend: "codex", threadId: "sol-source" })).resolves.toEqual({
      executionMode: "full-access", model: "gpt-6.1-sol", reasoningEffort: "high", fastMode: false,
    });
  });

  it("reserves a handoff source against turn admission and releases on failure", async () => {
    const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({}), overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    const params = { backend: "codex" as const, threadId: "handoff-source", input: [{ type: "text" as const, text: "Continue" }] };
    await expect(registry.withThreadHandoff(params.threadId, async () => {
      await expect(registry.submitTurn(params)).rejects.toThrow("being handed off");
      await expect(registry.submitTurnIfIdle(params)).rejects.toThrow("being handed off");
      await expect(registry.submitThreadReply(params)).rejects.toThrow("being handed off");
      await expect(registry.submitHeldTurn({ ...params, queueEntryId: "held", holdReason: "manual" })).rejects.toThrow("being handed off");
      await expect(registry.startTurn(params)).rejects.toThrow("being handed off");
      await expect(registry.withThreadHandoff(params.threadId, async () => {})).rejects.toThrow("being handed off");
      throw new Error("transfer failed");
    })).rejects.toThrow("transfer failed");
    await expect(registry.withThreadHandoff(params.threadId, async () => "released")).resolves.toBe("released");
  });

  describe("research handoff admission", () => {
    it("research catalogs follow the live experiment and discovery gates", async () => {
      let enabled = false;
      let discovery = true;
      const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({}), overlayStore: createOverlayStoreMock(), resolveCodexToolDiscovery: () => discovery });
      onTestFinished(() => registry.close());
      registry.setResearchHandler(async () => ({}), undefined, () => enabled);
      const catalog = registry as unknown as { buildCodexParentDynamicTools: (tokenMiser: boolean) => Promise<DynamicToolSpec[]> };
      for (const [feature, discover] of [[false, true], [true, true], [true, false], [false, true]]) {
        enabled = feature; discovery = discover;
        const tools = (await catalog.buildCodexParentDynamicTools(false)).flatMap((spec) => spec.type === "namespace" ? spec.tools : [spec]).filter((tool) => tool.name.startsWith("research_"));
        expect(tools).toHaveLength(feature && discover ? 5 : 0);
        expect(tools.every((tool) => tool.deferLoading === true)).toBe(true);
      }
    });

    it("offers and accepts research on every backend; Codex Tool Discovery gates only Codex's own catalog", async () => {
      // Every combination of the two settings, through the real MCP server an ACP or Claude thread uses.
      for (const [enabled, discovery] of [[false, false], [false, true], [true, false], [true, true]] as const) {
        const backend = "acp:kimi" as const;
        const threadId = "kimi-session-1";
        const { registry } = createKimiAcpRegistry({
          resolveCodexToolDiscovery: () => discovery,
          startPrompt: vi.fn((params) => ({ sessionId: params.sessionId, turnId: params.turnId! })),
        });
        const summaries = vi.fn(() => []);
        registry.setResearchHandler(
          createResearchAgentHandler({ summaries } as unknown as ResearchService, (context) => registry.researchContextIsLive(context), () => enabled),
          undefined,
          () => enabled,
        );
        const client = new McpClient({ name: "acp-research-fixture", version: "1.0.0" });
        try {
          const catalog = registry as unknown as { buildCodexParentDynamicTools: (tokenMiser: boolean) => Promise<DynamicToolSpec[]> };
          const codexTools = (await catalog.buildCodexParentDynamicTools(false)).flatMap((spec) => spec.type === "namespace" ? spec.tools : [spec]).filter((tool) => tool.name.startsWith("research_"));
          expect(codexTools).toHaveLength(enabled && discovery ? 5 : 0);

          await registry.startThread({ backend, cwd: "/repo", executionMode: "default" });
          const turn = await registry.startTurn({ backend, threadId, input: [{ type: "text", text: "Coordinate research" }] });
          // An ACP turn keeps its `pending:<session>:<time>` ID for its whole life.
          expect(turn.turnId).toMatch(/^pending:kimi-session-1:/);
          const server = (registry as unknown as { claudeAgentToolMcpServer: AgentToolMcpServerLike }).claudeAgentToolMcpServer;
          const registration = await server.registerClient({ backend, threadId });
          await client.connect(new StreamableHTTPClientTransport(new URL(registration.server.url), {
            requestInit: { headers: Object.fromEntries(registration.server.headers.map(({ name, value }) => [name, value])) },
          }));
          const listed = (await client.listTools()).tools.map(({ name }) => name).filter((name) => name.startsWith("research_"));
          expect(listed).toHaveLength(enabled ? 5 : 0);
          expect(registry.researchContextIsLive({ backend, threadId, turnId: turn.turnId, callId: "live", transport: "mcp" })).toBe(enabled);
          expect(registry.researchContextIsLive({ backend, threadId, turnId: "ended-turn", callId: "stale", transport: "mcp" })).toBe(false);
          // Claude reaches the same MCP server; its turns carry opaque IDs.
          await registry.publishLocalEvent({ backend: "claude", notification: { method: "turn/started", params: {
            threadId: "claude-coordinator", turnId: "claude-turn", turn: { id: "claude-turn" },
          } } });
          expect(registry.researchContextIsLive({ backend: "claude", threadId: "claude-coordinator", turnId: "claude-turn", callId: "live", transport: "mcp" })).toBe(enabled);
          await registry.publishLocalEvent({ backend: "claude", notification: { method: "turn/completed", params: {
            threadId: "claude-coordinator", turnId: "claude-turn", turn: { id: "claude-turn", status: "completed" },
          } } } as AgentEvent);
          expect(registry.researchContextIsLive({ backend: "claude", threadId: "claude-coordinator", turnId: "claude-turn", callId: "ended", transport: "mcp" })).toBe(false);
          if (enabled) {
            const result = await client.callTool({ name: "research_read", arguments: {} });
            expect(result.isError).not.toBe(true);
            expect(summaries).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ backend, threadId, turnId: turn.turnId }));
          }
        } finally {
          await client.close();
          await registry.close();
        }
      }
    });

    it.each(["acp:kimi", "claude"] as const)("runs a %s research worker through first prompt and slot release", async (backend) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-research-"));
      const db = openInMemoryStateDb();
      const storage = new ResearchStore(db);
      const workerFinished = createDeferred<void>();
      const atProviderPrompt = vi.fn((threadId: string, providerTurnId?: string) => {
        const worker = { backend, threadId };
        const [run] = storage.activeRuns(worker);
        return { worker, providerTurnId, run, approach: run && storage.approaches(run.id, { worker })[0] };
      });
      const registry = backend === "claude" ? createDesktopBackendRegistry({
        codexClient: new MockBackendClient({}),
        overlayStore: createOverlayStoreMock(),
        createScratchProjectDirectory: async () => root,
        pdfToolMcpServer: null,
        claudeBackendOptions: {
          store: new ClaudeSessionStore(path.join(root, "sessions")),
          getSessionInfo: async () => undefined,
          inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
          discoverModels: async () => [],
          query: ({ options = {} }) => {
            const threadId = options.sessionId!;
            atProviderPrompt(threadId);
            async function* messages(): AsyncGenerator<ClaudeMessage> {
              yield { type: "system", subtype: "init", session_id: threadId } as ClaudeMessage;
              await workerFinished.promise;
              yield { type: "result", subtype: "success", is_error: false, result: "Done" } as ClaudeMessage;
            }
            return Object.assign(messages(), { close: vi.fn(() => workerFinished.resolve()), setPermissionMode: vi.fn() }) as unknown as ClaudeQuery;
          },
        },
      }) : createAcpResearchRegistry();

      function createAcpResearchRegistry() {
        const sessions: AcpSessionMetadata[] = [];
        return createKimiAcpRegistry({
          sessions,
          createScratchProjectDirectory: async () => root,
          startSession: async (params) => {
            const session: AcpSessionMetadata = {
              backendId: "acp:kimi", sessionId: `research-session-${sessions.length + 1}`,
              title: params.title ?? "Research coordinator", cwd: params.cwd,
              createdAt: 1000, updatedAt: 1000, executionMode: params.executionMode, status: "idle",
            };
            sessions.push(session);
            return session;
          },
          startPrompt: ({ sessionId, turnId }) => {
            atProviderPrompt(sessionId, turnId);
            return { sessionId, turnId: turnId! };
          },
        }).registry;
      }

      const enabled = () => true;
      const onError = vi.fn();
      const research = new ResearchService(storage, {
        ...createResearchRegistryPorts(registry), enabled, ownerId: "test-owner", ownerPid: process.pid,
        ownerStartedAt: 0, isOwnerAlive: () => true, onError, changed: () => {},
      });
      const unsubscribe = bindResearchRegistry(registry, research, enabled);
      const client = new McpClient({ name: "research-worker-fixture", version: "1.0.0" });
      try {
        const { threadId } = await registry.startThread({ backend, cwd: root, executionMode: "default" });
        const coordinator = { backend, threadId };
        const parentTurn = await registry.startTurn({ ...coordinator, input: [{ type: "text", text: "Coordinate research" }] });
        expect(registry.researchContextIsLive({ ...coordinator, turnId: parentTurn.turnId, callId: "start", transport: "mcp" })).toBe(true);
        atProviderPrompt.mockClear();

        const server = (registry as unknown as { claudeAgentToolMcpServer: AgentToolMcpServerLike }).claudeAgentToolMcpServer;
        const registration = await server.registerClient(coordinator);
        await client.connect(new StreamableHTTPClientTransport(new URL(registration.server.url), {
          requestInit: { headers: Object.fromEntries(registration.server.headers.map(({ name, value }) => [name, value])) },
        }));
        const started = await client.callTool({ name: "research_start", arguments: {
          objective: "Explore event ordering", workspaceMode: "none",
          approaches: [{ title: "Events", task: "Inspect the event sequence" }],
        } });
        expect(started.isError, JSON.stringify(started.content)).not.toBe(true);
        expect(atProviderPrompt).toHaveBeenCalledOnce();

        // Provider admission is the oracle: the child and its running turn
        // must already be in the run when the provider receives its first prompt.
        const { worker, run, approach, providerTurnId } = atProviderPrompt.mock.results[0]!.value;
        expect(worker.threadId).not.toBe(threadId);
        expect(run).toMatchObject({ coordinator, activeWorkers: 1 });
        const turnId = registry.getActiveTurnForThread(worker)?.turnId;
        expect(turnId).toEqual(expect.any(String));
        if (backend === "acp:kimi") {
          expect(turnId).toBe(providerTurnId);
          expect(turnId).toMatch(/^pending:research-session-2:\d+$/);
        }
        expect(approach).toMatchObject({ state: "running", worker: { ...worker, turnId } });
        expect(started).toMatchObject({ structuredContent: {
          id: run!.id, coordinator, activeWorkers: 1,
          approaches: [{ state: "running", worker: { ...worker, turnId } }],
        } });

        if (backend === "claude") {
          workerFinished.resolve();
          await vi.waitFor(() => expect(storage.header(run!.id)?.activeWorkers).toBe(0));
        } else {
          await registry.publishLocalEvent({ backend, notification: { method: "turn/completed", params: {
            threadId: worker.threadId, turnId: turnId!, turn: { id: turnId!, status: "completed", output: [] },
          } } });
        }
        expect(storage.header(run!.id)?.activeWorkers).toBe(0);
        expect(storage.approaches(run!.id, { worker })).toMatchObject([{ state: "ended", worker: { ...worker, turnId } }]);
        expect(onError).not.toHaveBeenCalled();
      } finally {
        await client.close();
        unsubscribe();
        research.close();
        workerFinished.resolve();
        await registry.close();
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    });

    async function readyResearchRegistry() {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
        startThreadResult: { threadId: "research-worker" },
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock({ overlays: {
          "codex:research-parent": { backend: "codex", threadId: "research-parent", executionMode: "full-access", extraLinkedDirectories: [] },
        } }),
        threadTitleGenerationService: null,
      });
      onTestFinished(() => registry.close());
      await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: {
        threadId: "research-parent", turnId: "research-parent-turn", turn: { id: "research-parent-turn" },
      } } });
      return { registry, codexClient };
    }
    const researchHandoff = () => ({ operation: "handoff_task" as const,
      context: { backend: "codex" as const, threadId: "research-parent", turnId: "research-parent-turn", callId: "research-start:a1" },
      args: { task: "Explore event ordering", title: "Events", workspaceMode: "none" as const, messagingAttachment: "none" as const },
    });

    it("binds a research handoff before the provider admits its first model turn", async () => {
      const { registry, codexClient } = await readyResearchRegistry();
      const startTurn = vi.spyOn(codexClient, "startTurn");
      const bound = vi.fn<Parameters<DesktopBackendRegistry["handoffResearchWorker"]>[1]>((worker) => {
        expect(worker).toEqual({ backend: "codex", threadId: "research-worker" });
        expect(startTurn).not.toHaveBeenCalled();
      });
      const result = await registry.handoffResearchWorker(researchHandoff(), bound);
      expect(result).toMatchObject({ ok: true, data: { threadId: "research-worker", turnId: expect.any(String) } });
      expect(bound).toHaveBeenCalledOnce();
      expect(startTurn).toHaveBeenCalledOnce();
    });

    it("retains a refused research handoff's child identity without starting its model", async () => {
      const { registry, codexClient } = await readyResearchRegistry();
      const startTurn = vi.spyOn(codexClient, "startTurn");
      const result = await registry.handoffResearchWorker(researchHandoff(), () => { throw new Error("The research deadline closed admission"); });
      expect(result).toMatchObject({ ok: true, data: { threadId: "research-worker", turnStartFailure: { message: "The research deadline closed admission" } } });
      expect(startTurn).not.toHaveBeenCalled();
    });

    it("refuses another managed handoff from an active research worker", async () => {
      const { registry, codexClient } = await readyResearchRegistry();
      registry.setResearchHandler(async () => ({}), () => true);
      const result = await registry.handoffResearchWorker(researchHandoff(), () => {});
      expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(codexClient.lastStartThreadParams).toBeUndefined();
    });
  });

  it("rejects handoff while a turn start is awaiting its provider", async () => {
    const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({}), overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    const started = createDeferred<{ backend: "codex"; threadId: string; turnId: string }>();
    const internal = registry as unknown as { startTurnWithoutHandoff: () => Promise<{ backend: "codex"; threadId: string; turnId: string }> };
    vi.spyOn(internal, "startTurnWithoutHandoff").mockImplementation(async () => await started.promise);
    const pending = registry.startTurn({ backend: "codex", threadId: "handoff-source", input: [{ type: "text", text: "Continue" }] });
    await expect(registry.withThreadHandoff("handoff-source", async () => {})).rejects.toThrow("Wait for source turns");
    started.resolve({ backend: "codex", threadId: "handoff-source", turnId: "turn" });
    await pending;
    await expect(registry.withThreadHandoff("handoff-source", async () => "released")).resolves.toBe("released");
  });

  it("marks Gemini ACP thread workspace handoff unavailable after conversation history", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: "acp:gemini",
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          runtimeCapabilities: {
            schemaVersion: 1,
            status: "discovered",
            source: "initialize",
            discoveredAt: 1000,
            checkedAt: 1000,
            agentCapabilities: {
              mcp: {
                http: true,
              },
            },
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock([
        {
          backendId: "acp:gemini",
          sessionId: "session-1",
          title: "ACP Thread",
          cwd: "/repo/project",
          createdAt: 1000,
          updatedAt: 3000,
          executionMode: "default",
          status: "idle",
          hasConversationHistory: true,
        },
      ]),
    });

    await expect(
      registry.listThreads({ backend: "acp:gemini" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        workspaceHandoff: {
          available: false,
          unavailableReason: expect.stringContaining("cannot hand off"),
        },
      }),
    ]);

    await registry.close();
  });

  it("resumes Codex turns in the current handoff worktree cwd", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "default",
            extraLinkedDirectories: [
              {
                id: "pwragent-handoff:codex:thread-1",
                label: "app",
                path: "/repo/app",
                worktreePath: "/repo/app/.worktrees/thread-1/app",
                kind: "worktree",
              },
            ],
          },
        },
      }),
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "What is the CWD?" }],
    });

    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-1",
      cwd: "/repo/app/.worktrees/thread-1/app",
    });

    await registry.close();
  });

  it("handles thread handoff dynamic tool calls from active Codex turns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-"));
    try {
      await git(root, ["init", "-b", "main"]);
    } catch {
      await git(root, ["init"]);
      await git(root, ["checkout", "-b", "main"]);
    }
    await writeFile(path.join(root, "README.md"), "handoff\n", "utf8");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "initial"]);

    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
      threads: [
        {
          id: "ordinary-thread",
          title: "Parent Thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [
            {
              id: expectedDir(root),
              kind: "local",
              label: "handoff",
              path: expectedDir(root),
            },
          ],
          updatedAt: 1000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:ordinary-thread": {
          backend: "codex",
          threadId: "ordinary-thread",
          executionMode: "full-access",
          model: "gpt-5.4",
          reasoningEffort: "high",
          serviceTier: "priority",
          fastMode: true,
          extraLinkedDirectories: [
            {
              id: expectedDir(root),
              kind: "local",
              label: "handoff",
              path: expectedDir(root),
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      gitDirectoryService: new GitDirectoryService({
        resolveWorktreeStorage: () => "in-repo",
      }),
      overlayStore,
      threadTitleGenerationService: null,
    });
    const messagingRequests: unknown[] = [];
    let childBindingAttached = false;
    const noticesAfterAttachment: AgentEvent[] = [];
    registry.onEvent((event) => {
      if (childBindingAttached && event.notification.method === "thread/incomingWork") noticesAfterAttachment.push(event);
    });
    registry.setMessagingAgentToolService({
      async handlePwrAgentMessagingRequest(request) {
        messagingRequests.push(request);
        childBindingAttached = true;
        return {
          ok: true,
          data: {
            binding: {
              id: "binding-child",
              backend: "codex",
              threadId: "thread-1",
              targetKind: "thread",
              displayName: "Investigate issue XYZ",
            },
            channel: "discord",
            conversation: {
              id: "thread-123",
              kind: "thread",
              title: "Investigate issue XYZ",
              parentId: "channel-1",
              parentTitle: "ops",
            },
            createdConversation: {
              id: "thread-123",
              kind: "thread",
              title: "Investigate issue XYZ",
              parentId: "channel-1",
              parentTitle: "ops",
            },
            location: {
              binding: {
                id: "binding-parent",
                backend: "codex",
                threadId: "ordinary-thread",
                targetKind: "agent_thread",
              },
              channel: "discord",
              conversation: {
                id: "channel-1",
                kind: "channel",
                title: "ops",
              },
              conversationCapabilities: {
                rename: {
                  allowed: true,
                  supported: true,
                },
              },
              managedConversation: {
                canCreateChild: true,
                operations: [],
                outcome: "ok",
                providerSupportsCreation: true,
              },
              outboundAttachments: {
                maxUploadBytes: 25 * 1024 * 1024,
                supportsFileUpload: true,
                supportsImageUpload: true,
              },
            },
            outcome: "created_and_attached",
            placement: "new_child",
          },
        };
      },
      checkDynamicToolPermission() {
        return { allowed: true };
      },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          task: "Investigate issue XYZ and report back.",
          title: "Investigate issue XYZ",
          context: "Parent already checked the latest CI run.",
          workspaceMode: "new_worktree",
          messagingAttachment: "new_child",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    expect(noticesAfterAttachment).toHaveLength(1);
    expect(noticesAfterAttachment[0]).toMatchObject({ notification: {
      method: "thread/incomingWork", params: {
        threadId: "thread-1", turnId: "turn-1", deliveryId: "start:turn-1",
        incomingWork: { recipientTitle: "Investigate issue XYZ", messages: [{
          origin: { kind: "agent", sourceThread: { backend: "codex", threadId: "ordinary-thread", title: "Parent Thread" } },
          preview: expect.stringContaining("Investigate issue XYZ"),
        }], omittedMessageCount: 0 },
      },
    } });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      title: "Investigate issue XYZ",
      seedMode: "clean",
      groupingMode: "subthread",
      groupedUnderThreadId: "ordinary-thread",
      inheritedSettings: {
        backend: "codex",
        executionMode: "full-access",
        model: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "priority",
        fastMode: true,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
      workspace: {
        mode: "new_worktree",
        cwd: expect.stringContaining("handoff"),
        branch: "HEAD",
        git: {
          kind: "git_worktree",
          worktreeCreationAvailable: true,
        },
      },
      messagingAttachment: {
        requested: true,
        outcome: "created_and_attached",
        channel: "discord",
        conversation: {
          id: "thread-123",
          kind: "thread",
          title: "Investigate issue XYZ",
        },
        createdConversation: {
          id: "thread-123",
          kind: "thread",
          title: "Investigate issue XYZ",
        },
      },
    });
    expect(messagingRequests).toEqual([
      {
        operation: "attach_thread_here",
        context: {
          backend: "codex",
          threadId: "ordinary-thread",
          turnId: "turn-1",
        },
        args: {
          backend: "codex",
          threadId: "thread-1",
          placement: "new_child",
          targetKind: "thread",
          title: "Investigate issue XYZ",
        },
      },
    ]);
    expect(codexClient.lastStartThreadParams).toMatchObject({
      cwd: expect.stringContaining("handoff"),
      model: "gpt-5.4",
      reasoningEffort: "high",
      serviceTier: "priority",
      fastMode: true,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      threadSource: "user",
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-1",
      name: "Investigate issue XYZ",
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-1",
      cwd: expect.stringContaining("handoff"),
      model: "gpt-5.4",
      reasoningEffort: "high",
      serviceTier: "priority",
      fastMode: true,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const prompt =
      codexClient.lastStartTurnParams?.input[0]?.type === "text"
        ? codexClient.lastStartTurnParams.input[0].text
        : "";
    expect(prompt).toContain("Task:\nInvestigate issue XYZ and report back.");
    expect(prompt).toContain("Use only this thread's assigned runtime workspace");
    expect(prompt).toContain("Attaching a PR does not rebind the workspace.");
    expect(prompt).toContain("Additional context from parent:");
    expect(prompt).toContain("Parent already checked the latest CI run.");
    expect(prompt).not.toContain("Source thread:");
    expect(prompt).not.toContain("Inherited settings:");
    expect(prompt).not.toContain("Workspace:");
    expect(prompt).not.toContain("Parent context reference:");
    expect(prompt).not.toContain(root);
    expect(prompt.length).toBeLessThan(1_000);
    const childOverlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(childOverlay?.agent).toBeUndefined();
    expect(childOverlay).toMatchObject({
      handoffOrigin: {
        sourceBackend: "codex",
        sourceThreadId: "ordinary-thread",
        sourceTurnId: "turn-1",
        sourceTitle: "Parent Thread",
        taskTitle: "Investigate issue XYZ",
        seedMode: "clean",
        groupingMode: "subthread",
        workspace: {
          mode: "new_worktree",
          cwd: expect.stringContaining("handoff"),
          branch: "HEAD",
        },
      },
    });

    await registry.close();
    await rm(root, { recursive: true, force: true });
  });

  it.each([false, true])("normalizes inherited handoff settings for a new model with reasoning=%s", async (supportsReasoning) => {
    const codexClient = new MockBackendClient({
      models: [
        { id: "source-model", supportsReasoning: true, reasoningEfforts: ["high"], supportsFast: true },
        { id: "child-model", supportsReasoning, reasoningEfforts: supportsReasoning ? ["low"] : [], supportsFast: false },
      ],
      threads: [{ id: "parent", title: "Parent", titleSource: "explicit", source: "codex", linkedDirectories: [], updatedAt: 1000 }],
    });
    const overlayStore = createOverlayStoreMock({ overlays: {
      "codex:parent": { backend: "codex", threadId: "parent", extraLinkedDirectories: [],
        model: "source-model", reasoningEffort: "high", fastMode: true, serviceTier: "priority" },
    } });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore,
      threadTitleGenerationService: null, createScratchProjectDirectory: async () => "/fixture/child" });
    try {
      await registry.publishLocalEvent({ backend: "codex", notification: {
        method: "turn/started", params: { threadId: "parent", turnId: "parent-turn", turn: { id: "parent-turn" } },
      } });
      const handoff = (settings: { reasoningEffort?: string; fastMode?: boolean; serviceTier?: string }) => callRegistryMcpTool({
        registry, backend: "codex", threadId: "parent", turnId: "parent-turn", tool: "handoff_task",
        callId: `model-settings:${JSON.stringify(settings)}`,
        args: { task: "Inspect the fixture", model: "child-model", workspaceMode: "none", ...settings },
      });
      for (const explicit of [{ reasoningEffort: "high" }, { fastMode: true }, { serviceTier: "priority" }]) {
        expect(await handoff(explicit)).toMatchObject({ isError: true, structuredContent: {
          code: "invalid_arguments", message: expect.stringContaining(Object.keys(explicit)[0]!),
        } });
        expect(codexClient.lastStartThreadParams).toBeUndefined();
      }
      const child = await handoff({});
      expect(child).toMatchObject({ structuredContent: { inheritedSettings: { model: "child-model" } } });
      expect(codexClient.lastStartThreadParams).toMatchObject({
        model: "child-model", reasoningEffort: supportsReasoning ? "low" : undefined,
        fastMode: false, serviceTier: undefined,
      });
      expect(codexClient.lastStartTurnParams).toMatchObject({
        model: "child-model", reasoningEffort: supportsReasoning ? "low" : undefined,
        fastMode: false, serviceTier: undefined,
      });
    } finally {
      await registry.close();
    }
  });

  it("rejects a Grok model on an inherited Codex backend and accepts an explicit Grok backend", async () => {
    const acpBackendId = "acp:grok" as AcpBackendId;
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "turn/start"] },
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
      threads: [
        {
          id: "codex-parent",
          title: "Codex parent",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 1000,
        },
      ],
    });
    const installedAgent: AcpInstalledAgentRecord = {
      ...createKimiAgentRecord(acpBackendId),
      registryId: "grok",
      name: "Grok",
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        checkedAt: 1000,
        models: {
          currentModelId: "grok-4.5",
          availableModels: [
            {
              id: "grok-4.5",
              label: "Grok 4.5",
            },
          ],
        },
      },
    };
    const { acpClient, registry } = createKimiAcpRegistry({
      acpBackendId,
      codexClient,
      installedAgent,
      sessionId: "grok-child",
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "codex-parent",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const wrongBackendResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "codex-parent",
        turnId: "turn-1",
        callId: "call-wrong-backend",
        requestId: "call-wrong-backend",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          task: "Ask Grok to investigate the issue.",
          model: "grok",
          workspaceMode: "none",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(wrongBackendResponse).toMatchObject({ success: false });
    expect(
      JSON.parse(
        (wrongBackendResponse as { contentItems: Array<{ text: string }> })
          .contentItems[0]!.text,
      ),
    ).toEqual({
      code: "invalid_arguments",
      message:
        'model="grok" is not available for backend="codex". Available models: gpt-5.6-sol. To request Grok, pass backend="acp:grok" and an exact discovered model ID such as model="grok-4.5".',
    });
    expect(codexClient.lastStartThreadParams).toBeUndefined();
    expect(acpClient.startSession).not.toHaveBeenCalled();

    const mcpWrongBackendResponse = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "codex-parent",
      turnId: "turn-1",
      tool: "handoff_task",
      args: {
        task: "Ask Grok to investigate the issue over MCP.",
        model: "grok",
        workspaceMode: "none",
      },
    });
    expect(mcpWrongBackendResponse).toMatchObject({
      isError: true,
      structuredContent: {
        code: "invalid_arguments",
        message: expect.stringContaining(
          'pass backend="acp:grok" and an exact discovered model ID',
        ),
      },
    });
    expect(codexClient.lastStartThreadParams).toBeUndefined();
    expect(acpClient.startSession).not.toHaveBeenCalled();

    const explicitGrokResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "codex-parent",
        turnId: "turn-1",
        callId: "call-explicit-grok",
        requestId: "call-explicit-grok",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          backend: acpBackendId,
          task: "Ask Grok to investigate the issue.",
          model: "grok-4.5",
          workspaceMode: "none",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(explicitGrokResponse).toMatchObject({ success: true });
    expect(
      JSON.parse(
        (explicitGrokResponse as { contentItems: Array<{ text: string }> })
          .contentItems[0]!.text,
      ),
    ).toMatchObject({
      backend: acpBackendId,
      groupingMode: "subthread",
      groupedUnderThreadId: "codex-parent",
      inheritedSettings: {
        backend: acpBackendId,
        model: "grok-4.5",
      },
    });
    expect(acpClient.startSession).toHaveBeenCalledOnce();

    await registry.close();
  });

  it.each([
    { parentMode: "default", requestedMode: undefined, expectedMode: "default" },
    { parentMode: "auto", requestedMode: undefined, expectedMode: "default" },
    { parentMode: "full-access", requestedMode: undefined, expectedMode: "full-access" },
    { parentMode: "auto", requestedMode: "default", expectedMode: "default" },
    { parentMode: "full-access", requestedMode: "full-access", expectedMode: "full-access" },
    { parentMode: "auto", requestedMode: "auto", expectedMode: undefined },
  ] as const)("resolves ACP handoff access from $parentMode with override $requestedMode", async ({ parentMode, requestedMode, expectedMode }) => {
    const parentDirectory = {
      id: expectedDir("/repo/app"),
      kind: "local" as const,
      label: "app",
      path: expectedDir("/repo/app"),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "turn/start"] },
      threads: [
        {
          id: "codex-parent",
          title: "Codex parent",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [parentDirectory],
          updatedAt: 1000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:codex-parent": {
          backend: "codex",
          threadId: "codex-parent",
          executionMode: parentMode,
          extraLinkedDirectories: [parentDirectory],
        },
      },
    });
    const { acpBackendId, acpClient, registry } = createKimiAcpRegistry({
      codexClient,
      overlayStore,
      sessionId: "kimi-child",
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "codex-parent",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "codex-parent",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          backend: acpBackendId,
          ...(requestedMode ? { executionMode: requestedMode } : {}),
          task: "Investigate the migration race.",
          title: "Migration race",
          groupingMode: "subthread",
          workspaceMode: "none",
        },
      },
    } as AppServerPendingRequestNotification);

    if (expectedMode === undefined) {
      expect(response).toMatchObject({ success: false });
      expect(JSON.stringify(response)).toContain("Auto access is supported only by Codex.");
      expect(acpClient.startSession).not.toHaveBeenCalled();
      await registry.close();
      return;
    }

    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toMatchObject({
      backend: acpBackendId,
      threadId: "kimi-child",
      groupingMode: "subthread",
      groupedUnderThreadId: "codex-parent",
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: acpBackendId,
        threadId: "kimi-child",
      }),
    ).resolves.toMatchObject({
      parentThreadId: "codex-parent",
      parentThreadBackend: "codex",
      executionMode: expectedMode,
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "codex-parent",
      }),
    ).resolves.toMatchObject({
      subthreadOrder: ["kimi-child"],
      executionMode: parentMode,
    });

    await registry.close();
  });

  it("reports the allocated worktree cwd in ACP handoff prompts", async () => {
    const acpBackendId = "acp:grok" as AcpBackendId;
    const repoPath = expectedDir("/repo/app");
    const worktreePath = expectedDir("/worktrees/grok-child");
    const parentDirectory = {
      id: repoPath,
      kind: "local" as const,
      label: "app",
      path: repoPath,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "turn/start"] },
      threads: [
        {
          id: "codex-parent",
          title: "Codex parent",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [parentDirectory],
          updatedAt: 1000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:codex-parent": {
          backend: "codex",
          threadId: "codex-parent",
          executionMode: "default",
          extraLinkedDirectories: [parentDirectory],
        },
      },
    });
    const startPrompt = vi.fn((params: Parameters<KimiStartPrompt>[0]) => ({
      sessionId: params.sessionId,
      turnId: "grok-turn-1",
    }));
    const { acpClient, registry } = createKimiAcpRegistry({
      acpBackendId,
      codexClient,
      overlayStore,
      sessionId: "grok-child",
      startPrompt,
      gitDirectoryService: {
        inspectWorkspaceGit: vi.fn(async (cwd: string) => ({
          kind: "worktree" as const,
          branch: cwd === worktreePath ? "HEAD" : "main",
          hasCommits: true,
          headHasCommit: true,
          worktreeCreationAvailable: true,
        })),
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: worktreePath,
          repositoryPath: repoPath,
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "codex-parent",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "codex-parent",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          backend: acpBackendId,
          task: "Investigate the migration race.",
          title: "Migration race",
          workspaceMode: "new_worktree",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    expect(acpClient.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: worktreePath }),
    );
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.workspace).toMatchObject({
      mode: "new_worktree",
      cwd: worktreePath,
      linkedDirectory: {
        kind: "worktree",
        path: repoPath,
        worktreePath,
      },
      git: {
        kind: "git_worktree",
        worktreeCreationAvailable: true,
      },
    });
    expect(startPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Use only this thread's assigned runtime workspace",
        ),
      }),
    );
    expect(startPrompt.mock.calls[0]?.[0].prompt).not.toContain(worktreePath);
    expect(startPrompt.mock.calls[0]?.[0].prompt).not.toContain(repoPath);

    await registry.close();
  });

  it("groups a Codex handoff under its Kimi parent", async () => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-image-"));
    const previousHome = process.env.PWRAGENT_HOME;
    const previousProfile = process.env.PWRAGENT_PROFILE;
    process.env.PWRAGENT_HOME = tempRoot;
    process.env.PWRAGENT_PROFILE = "test";
    onTestFinished(async () => {
      if (previousHome === undefined) delete process.env.PWRAGENT_HOME;
      else process.env.PWRAGENT_HOME = previousHome;
      if (previousProfile === undefined) delete process.env.PWRAGENT_PROFILE;
      else process.env.PWRAGENT_PROFILE = previousProfile;
      await rm(tempRoot, { recursive: true, force: true });
    });
    const parentDirectory = {
      id: expectedDir("/repo/app"),
      kind: "local" as const,
      label: "app",
      path: expectedDir("/repo/app"),
    };
    const parentSession: AcpSessionMetadata = {
      backendId: acpBackendId,
      sessionId: "kimi-parent",
      title: "Kimi parent",
      cwd: "/repo/app",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "acp:kimi:kimi-parent": {
          backend: acpBackendId,
          threadId: "kimi-parent",
          executionMode: "default",
          extraLinkedDirectories: [parentDirectory],
        },
      },
    });
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      codexClient,
      overlayStore,
      sessionId: "kimi-parent",
      sessions: [parentSession],
    });
    const turn = await registry.startTurn({
      backend: acpBackendId,
      threadId: "kimi-parent",
      input: [
        { type: "text", text: "Delegate the migration lock fix." },
        {
          type: "image",
          name: "migration.png",
          url: "data:image/png;base64,AQID",
        },
      ],
    });
    const remembered = registry.getTurnInputAttachments({
      backend: acpBackendId,
      threadId: "kimi-parent",
      turnId: turn.turnId,
    });
    expect(remembered).toEqual([expect.objectContaining({
      type: "localImage",
      name: "migration.png",
      path: expect.stringContaining(path.join("thread-assets", "acp%3Akimi", "kimi-parent")),
    })]);
    expect(JSON.stringify(remembered)).not.toContain("base64");
    await registry.publishLocalEvent({
      backend: acpBackendId,
      notification: {
        method: "turn/started",
        params: {
          threadId: "kimi-parent",
          turnId: turn.turnId,
          turn: { id: turn.turnId },
        },
      },
    });

    const response = await callRegistryMcpTool({
      registry,
      backend: acpBackendId,
      threadId: "kimi-parent",
      turnId: turn.turnId,
      tool: "handoff_task",
      args: {
        backend: "codex",
        task: "Fix the migration lock race.",
        title: "Migration lock",
        groupingMode: "subthread",
        workspaceMode: "none",
      },
    });

    expect(response).toMatchObject({
      structuredContent: {
        backend: "codex",
        threadId: "thread-1",
        groupingMode: "subthread",
        groupedUnderThreadId: "kimi-parent",
      },
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-1",
      input: [
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Fix the migration lock race."),
        }),
        expect.objectContaining({
          type: "localImage",
          name: "migration.png",
          path: expect.stringContaining(path.join("thread-assets", "codex", "thread-1")),
        }),
      ],
    });
    const childImage = codexClient.lastStartTurnParams?.input[1];
    expect(childImage?.type).toBe("localImage");
    if (childImage?.type === "localImage") {
      await expect(readFile(childImage.path)).resolves.toEqual(
        Buffer.from([1, 2, 3]),
      );
    }
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      parentThreadId: "kimi-parent",
      parentThreadBackend: acpBackendId,
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: acpBackendId,
        threadId: "kimi-parent",
      }),
    ).resolves.toMatchObject({
      subthreadOrder: ["thread-1"],
    });

    await registry.close();
  });

  it.each(["default", "auto"] as const)("persists supported settings on a trusted ACP handoff launchpad from %s", async (parentMode) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-cross-provider-trust-"),
    );
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "worktree");
    await mkdir(repoPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    const parentDirectory: LinkedDirectorySummary = {
      id: expectedDir(repoPath),
      kind: "worktree",
      label: "repo",
      path: expectedDir(repoPath),
      worktreePath: expectedDir(worktreePath),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "turn/start"] },
      threads: [
        {
          id: "codex-parent",
          title: "Codex parent",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [parentDirectory],
          updatedAt: 1000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:codex-parent": {
          backend: "codex",
          threadId: "codex-parent",
          executionMode: parentMode,
          extraLinkedDirectories: [parentDirectory],
        },
      },
    });
    const { acpBackendId, registry } = createKimiAcpRegistry({
      codexClient,
      overlayStore,
      sessionId: "kimi-child",
      gitDirectoryService: {
        inspectWorkspaceGit: vi.fn(async () => ({
          kind: "local" as const,
          branch: "main",
          hasCommits: true,
          headHasCommit: true,
          worktreeCreationAvailable: true,
        })),
        resolvePrimaryWorkspacePath: vi.fn(async () => repoPath),
      },
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });
    try {
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "codex-parent",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });

      const responsePromise = codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "codex-parent",
          turnId: "turn-1",
          callId: "call-1",
          requestId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            backend: acpBackendId,
            task: "Investigate the migration race.",
            groupingMode: "subthread",
            workspaceMode: "project_local",
            cwd: repoPath,
          },
        },
      } as AppServerPendingRequestNotification);

      await vi.waitFor(() => {
        expect(
          events.find(
            (event) => event.notification.method === "item/tool/requestUserInput",
          ),
        ).toBeDefined();
      });
      const inputRequest = events.find(
        (event): event is AgentEvent & {
          notification: Extract<
            AppServerNotification,
            { method: "item/tool/requestUserInput" }
          >;
        } => event.notification.method === "item/tool/requestUserInput",
      )!.notification;
      await registry.submitServerRequest({
        backend: "codex",
        threadId: "codex-parent",
        turnId: "turn-1",
        requestId: inputRequest.params.requestId,
        response: {
          answers: {
            trust_directory: {
              answers: ["Trust directory (Recommended)"],
            },
          },
        },
      });

      await expect(responsePromise).resolves.toMatchObject({ success: true });
      const realRepoPath = expectedDir(await realpath(repoPath));
      await expect(
        overlayStore.getDirectoryLaunchpad({
          directoryKey: `directory:${realRepoPath}`,
        }),
      ).resolves.toMatchObject({
        backend: acpBackendId,
        parentThreadId: "codex-parent",
        parentThreadBackend: "codex",
        executionMode: "default",
      });
    } finally {
      unsubscribe();
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores subthread grouping when a handoff targets a different project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-cross-project-"));
    const parentRepoPath = path.join(root, "PwrAgent");
    const targetRepoPath = path.join(root, "PwrSnap");
    const targetWorktreePath = path.join(root, "PwrSnap-worktree");
    try {
      for (const repoPath of [parentRepoPath, targetRepoPath]) {
        await mkdir(repoPath, { recursive: true });
        try {
          await git(repoPath, ["init", "-b", "main"]);
        } catch {
          await git(repoPath, ["init"]);
          await git(repoPath, ["checkout", "-b", "main"]);
        }
        await writeFile(path.join(repoPath, "README.md"), "handoff\n", "utf8");
        await git(repoPath, ["add", "README.md"]);
        await git(repoPath, ["commit", "-m", "initial"]);
      }

      const parentDirectory = {
        id: expectedDir(parentRepoPath),
        kind: "local" as const,
        label: "PwrAgent",
        path: expectedDir(parentRepoPath),
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
        threads: [
          {
            id: "ordinary-thread",
            title: "PwrAgent parent",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [parentDirectory],
            updatedAt: 1000,
          },
        ],
      });
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "full-access",
            extraLinkedDirectories: [parentDirectory],
          },
        },
      });
      const setThreadParent = vi.spyOn(overlayStore, "setThreadParent");
      const updateSubthreadOrder = vi.spyOn(overlayStore, "updateSubthreadOrder");
      const registry = createDesktopBackendRegistry({
        codexClient,
        gitDirectoryService: {
          inspectWorkspaceGit: vi.fn(async (cwd: string) => ({
            kind: "worktree" as const,
            branch: cwd === targetWorktreePath ? "HEAD" : "main",
            hasCommits: true,
            headHasCommit: true,
            worktreeCreationAvailable: true,
          })),
          prepareLaunchpadWorkspace: vi.fn(async () => ({
            cwd: targetWorktreePath,
            repositoryPath: targetRepoPath,
            workMode: "worktree" as const,
          })),
          recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
          resolvePrimaryWorkspacePath: vi.fn(async (cwd?: string) => {
            if (cwd?.startsWith(targetWorktreePath)) return targetRepoPath;
            if (cwd?.startsWith(targetRepoPath)) return targetRepoPath;
            if (cwd?.startsWith(parentRepoPath)) return parentRepoPath;
            return cwd;
          }),
        } as never,
        overlayStore,
        threadTitleGenerationService: null,
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "ordinary-thread",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });

      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-1",
          requestId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: "Check Codex discovery in PwrSnap.",
            title: "PwrSnap discovery check",
            cwd: targetRepoPath,
            groupingMode: "subthread",
            workspaceMode: "new_worktree",
          },
        },
      } as AppServerPendingRequestNotification);

      expect(response).toMatchObject({ success: true });
      const payload = JSON.parse(
        (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
      );
      expect(payload).toMatchObject({
        threadId: "thread-1",
        groupingMode: "none",
        origin: {
          sourceThreadId: "ordinary-thread",
          groupingMode: "none",
        },
      });
      expect(payload).not.toHaveProperty("groupedUnderThreadId");
      expect(setThreadParent).not.toHaveBeenCalled();
      expect(updateSubthreadOrder).not.toHaveBeenCalled();
      await expect(
        overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }),
      ).resolves.toMatchObject({
        handoffOrigin: expect.objectContaining({
          groupingMode: "none",
        }),
      });
      await expect(
        overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }),
      ).resolves.not.toMatchObject({
        parentThreadId: "ordinary-thread",
      });

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects same-workspace handoffs when subthread grouping crosses projects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-cross-project-same-"));
    const parentRepoPath = path.join(root, "PwrAgent");
    const targetRepoPath = path.join(root, "PwrSnap");
    try {
      for (const repoPath of [parentRepoPath, targetRepoPath]) {
        await mkdir(repoPath, { recursive: true });
        try {
          await git(repoPath, ["init", "-b", "main"]);
        } catch {
          await git(repoPath, ["init"]);
          await git(repoPath, ["checkout", "-b", "main"]);
        }
        await writeFile(path.join(repoPath, "README.md"), "handoff\n", "utf8");
        await git(repoPath, ["add", "README.md"]);
        await git(repoPath, ["commit", "-m", "initial"]);
      }

      const parentDirectory = {
        id: expectedDir(parentRepoPath),
        kind: "local" as const,
        label: "PwrAgent",
        path: expectedDir(parentRepoPath),
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
        threads: [
          {
            id: "ordinary-thread",
            title: "PwrAgent parent",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [parentDirectory],
            updatedAt: 1000,
          },
        ],
      });
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "full-access",
            extraLinkedDirectories: [parentDirectory],
          },
        },
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        gitDirectoryService: {
          inspectWorkspaceGit: vi.fn(async () => ({
            kind: "worktree" as const,
            branch: "main",
            hasCommits: true,
            headHasCommit: true,
            worktreeCreationAvailable: true,
          })),
          resolvePrimaryWorkspacePath: vi.fn(async (cwd?: string) => {
            if (cwd?.startsWith(targetRepoPath)) return targetRepoPath;
            if (cwd?.startsWith(parentRepoPath)) return parentRepoPath;
            return cwd;
          }),
        } as never,
        overlayStore,
        threadTitleGenerationService: null,
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "ordinary-thread",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });

      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-1",
          requestId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: "Check Codex discovery in PwrSnap.",
            title: "PwrSnap discovery check",
            cwd: targetRepoPath,
            groupingMode: "subthread",
            workspaceMode: "same_workspace",
          },
        },
      } as AppServerPendingRequestNotification);

      expect(response).toEqual({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify(
              {
                code: "invalid_arguments",
                message:
                  'workspaceMode="same_workspace" is only valid for same-project grouped subthread handoffs. Use workspaceMode="new_worktree" for an isolated handoff, workspaceMode="project_local" for the project checkout, or workspaceMode="none" for an unscoped local thread.',
              },
              null,
              2,
            ),
          },
        ],
      });
      expect(codexClient.lastStartThreadParams).toBeUndefined();
      expect(codexClient.lastStartTurnParams).toBeUndefined();

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rehydrates inherited Codex environment runtime when an explicit cwd is the caller worktree's repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-env-"));
    const repoPath = path.join(root, "repo");
    const callerWorktreePath = path.join(root, "caller-worktree");
    const worktreePath = path.join(root, "worktree");
    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
    } catch {
      await git(repoPath, ["init"]);
      await git(repoPath, ["checkout", "-b", "main"]);
    }
    await writeFile(path.join(repoPath, "README.md"), "handoff\n", "utf8");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "initial"]);
    await mkdir(callerWorktreePath, { recursive: true });
    await mkdir(path.join(worktreePath, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(worktreePath, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "ExampleApp"

[setup]
script = "printf setup"

[[actions]]
name = "Dev"
command = "pnpm dev"
`,
      "utf8",
    );

    const sourceRuntime: CodexThreadEnvironmentRuntime = {
      environmentId: "environment",
      environmentName: "ExampleApp",
      executionTarget: "local",
      cwd: callerWorktreePath,
      setupStatus: "completed",
      setupCommand: "printf setup",
      shellEnvironment: {
        PATH: `${callerWorktreePath}/.venv/bin:/usr/bin`,
        VIRTUAL_ENV: `${callerWorktreePath}/.venv`,
      },
      selectedActionIdByEnvironmentId: {
        environment: "dev",
      },
      actions: [
        {
          id: "dev",
          name: "Dev",
          command: "pnpm dev",
        },
      ],
    };
    const prepareLaunchpadWorkspace = vi.fn(async () => ({
      cwd: worktreePath,
      repositoryPath: repoPath,
      workMode: "worktree" as const,
    }));
    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const commandRunner: CodexEnvironmentCommandRunner = vi.fn(async (params) => {
      expect(params).toMatchObject({
        cwd: worktreePath,
        command: "printf setup",
        mode: "wait",
        captureShellEnvironment: true,
      });
      return {
        durationMs: 5,
        exitCode: 0,
        output: "setup",
        shellEnvironment: {
          PATH: `${worktreePath}/.venv/bin:/usr/bin`,
          VIRTUAL_ENV: `${worktreePath}/.venv`,
        },
      };
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
      threads: [
        {
          id: "ordinary-thread",
          title: "Parent Thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [
            {
              id: expectedDir(callerWorktreePath),
              kind: "worktree",
              label: "repo",
              path: expectedDir(repoPath),
              worktreePath: expectedDir(callerWorktreePath),
            },
          ],
          updatedAt: 1000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:ordinary-thread": {
          backend: "codex",
          threadId: "ordinary-thread",
          executionMode: "full-access",
          codexEnvironmentRuntime: sourceRuntime,
          extraLinkedDirectories: [
            {
              id: expectedDir(callerWorktreePath),
              kind: "worktree",
              label: "repo",
              path: expectedDir(repoPath),
              worktreePath: expectedDir(callerWorktreePath),
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      codexEnvironmentCommandRunner: commandRunner,
      gitDirectoryService: {
        inspectWorkspaceGit: vi.fn(async (cwd: string) => ({
          kind: "worktree" as const,
          branch: cwd === worktreePath ? "HEAD" : "main",
          hasCommits: true,
          headHasCommit: true,
          worktreeCreationAvailable: true,
        })),
        prepareLaunchpadWorkspace,
        recordCodexWorktreeOwnerThread,
      } as never,
      overlayStore,
      threadTitleGenerationService: null,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          task: "Implement the export failure alert on master.",
          title: "Swift export alert",
          workspaceMode: "new_worktree",
          cwd: repoPath,
          branchName: "origin/master",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    expect(prepareLaunchpadWorkspace).toHaveBeenCalledWith({
      backend: "codex",
      branchName: "origin/master",
      directoryKind: "directory",
      directoryLabel: "repo",
      directoryPath: repoPath,
      workMode: "worktree",
    });
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(codexClient.lastStartThreadParams?.codexEnvironmentRuntime).toMatchObject({
      environmentId: "environment",
      cwd: worktreePath,
      setupStatus: "completed",
      shellEnvironment: {
        PATH: `${worktreePath}/.venv/bin:/usr/bin`,
        VIRTUAL_ENV: `${worktreePath}/.venv`,
      },
      selectedActionIdByEnvironmentId: {
        environment: "dev",
      },
    });
    expect(
      codexClient.lastStartThreadParams?.codexEnvironmentRuntime?.shellEnvironment
        ?.VIRTUAL_ENV,
    ).not.toBe(`${repoPath}/.venv`);
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.inheritedSettings.codexEnvironmentRuntime).toMatchObject({
      environmentId: "environment",
      cwd: worktreePath,
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      codexEnvironmentRuntime: {
        environmentId: "environment",
        cwd: worktreePath,
      },
    });

    await registry.close();
    await rm(root, { recursive: true, force: true });
  });

  it.each(["terminal", "idle"] as const)("keeps one child for a repeated call id until the %s boundary ends the turn", async (boundary) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-pending-"));
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "worktree");
    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
    } catch {
      await git(repoPath, ["init"]);
      await git(repoPath, ["checkout", "-b", "main"]);
    }
    await writeFile(path.join(repoPath, "README.md"), "handoff\n", "utf8");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "initial"]);
    await mkdir(path.join(worktreePath, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(worktreePath, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "ExampleApp"

[setup]
script = "printf setup"
`,
      "utf8",
    );

    const setupStarted = createDeferred<void>();
    const setupRelease = createDeferred<void>();
    const sourceRuntime: CodexThreadEnvironmentRuntime = {
      environmentId: "environment",
      environmentName: "ExampleApp",
      executionTarget: "local",
      cwd: repoPath,
      setupStatus: "completed",
      setupCommand: "printf setup",
    };
    const commandRunner: CodexEnvironmentCommandRunner = vi.fn(async () => {
      setupStarted.resolve();
      await setupRelease.promise;
      return {
        durationMs: 5,
        exitCode: 0,
        output: "setup",
      };
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/list", "thread/read", "turn/start"] },
      threads: [
        {
          id: "ordinary-thread",
          title: "Parent Thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [
            {
              id: expectedDir(repoPath),
              kind: "local",
              label: "repo",
              path: expectedDir(repoPath),
            },
          ],
          updatedAt: 1000,
        },
      ],
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "active",
      },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:ordinary-thread": {
          backend: "codex",
          threadId: "ordinary-thread",
          executionMode: "full-access",
          codexEnvironmentRuntime: sourceRuntime,
          extraLinkedDirectories: [
            {
              id: expectedDir(repoPath),
              kind: "local",
              label: "repo",
              path: expectedDir(repoPath),
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      codexEnvironmentCommandRunner: commandRunner,
      gitDirectoryService: {
        inspectWorkspaceGit: vi.fn(async (cwd: string) => ({
          kind: "worktree" as const,
          branch: cwd === worktreePath ? "HEAD" : "main",
          hasCommits: true,
          headHasCommit: true,
          worktreeCreationAvailable: true,
        })),
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: worktreePath,
          repositoryPath: repoPath,
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
      overlayStore,
      threadTitleGenerationService: null,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const handoffCall = {
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "handoff-call-1",
        requestId: "handoff-call-1",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          task: "Make the Swift crash guard on origin/master.",
          title: "Swift crash guard",
          groupingMode: "subthread",
          workspaceMode: "new_worktree",
          branchName: "origin/master",
        },
      },
    } as AppServerPendingRequestNotification;
    const handoffPromise = codexClient.emitRequest(handoffCall);
    const repeatedHandoffPromise = codexClient.emitRequest({
      ...handoffCall,
      params: { ...handoffCall.params, requestId: "handoff-call-replayed" },
    });

    try {
      await setupStarted.promise;
      expect(codexClient.lastStartThreadParams).toBeUndefined();

      const searchResponse = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "search-call-1",
          requestId: "search-call-1",
          namespace: "pwragent",
          tool: "search_threads",
          arguments: {
            query: "Swift crash guard",
          },
        },
      } as AppServerPendingRequestNotification);
      const searchPayload = JSON.parse(
        (searchResponse as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
      );
      expect(searchPayload.pendingHandoffs).toEqual([
        expect.objectContaining({
          handoffId: "handoff:codex:ordinary-thread:turn-1:handoff-call-1",
          status: "starting",
          phase: "starting_thread",
          sourceThreadId: "ordinary-thread",
          title: "Swift crash guard",
          branchName: "origin/master",
          message: expect.stringContaining("Do not retry"),
        }),
      ]);
      expect(searchPayload.pendingHandoffs[0]).not.toHaveProperty("threadId");

      const statusResponse = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "status-call-1",
          requestId: "status-call-1",
          namespace: "pwragent",
          tool: "get_thread_status",
          arguments: {
            backend: "codex",
            threadId: "ordinary-thread",
          },
        },
      } as AppServerPendingRequestNotification);
      const statusPayload = JSON.parse(
        (statusResponse as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
      );
      expect(statusPayload.thread.pendingHandoffs).toEqual([
        expect.objectContaining({
          handoffId: "handoff:codex:ordinary-thread:turn-1:handoff-call-1",
          status: "starting",
          phase: "starting_thread",
        }),
      ]);
    } finally {
      setupRelease.resolve();
    }

    const handoffResponse = await handoffPromise;
    const repeatedHandoffResponse = await repeatedHandoffPromise;
    expect(handoffResponse).toMatchObject({ success: true });
    expect(repeatedHandoffResponse).toEqual(handoffResponse);
    const handoffPayload = JSON.parse(
      (handoffResponse as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(handoffPayload).toMatchObject({
      handoffId: "handoff:codex:ordinary-thread:turn-1:handoff-call-1",
      threadId: "thread-1",
      groupedUnderThreadId: "ordinary-thread",
      // The handoff result hands the model a finished link. Without this the
      // model paraphrases `threadId` into a bare, unclickable uuid — which is
      // exactly what this protocol exists to stop.
      threadUrl: "pwragent://thread/thread-1?backend=codex",
    });
    expect(handoffPayload.threadLink).toBe(
      `[${handoffPayload.title}](pwragent://thread/thread-1?backend=codex)`,
    );
    expect(commandRunner).toHaveBeenCalledTimes(1);
    await expect(codexClient.emitRequest(handoffCall)).resolves.toEqual(handoffResponse);

    const changedArgumentsResponse = await codexClient.emitRequest({
      ...handoffCall,
      params: {
        ...handoffCall.params,
        arguments: { task: "A different task." },
      },
    });
    expect(changedArgumentsResponse).toMatchObject({ success: false });
    const changedArgumentsPayload = JSON.parse(
      (changedArgumentsResponse as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(changedArgumentsPayload).toMatchObject({ code: "invalid_arguments" });

    const internals = registry as unknown as {
      acceptedDynamicToolCalls: Map<string, unknown>;
      acceptedHandoffTaskRequests: Map<string, unknown>;
    };
    expect(internals.acceptedDynamicToolCalls.size).toBeGreaterThan(0);
    expect(internals.acceptedHandoffTaskRequests.size).toBe(1);
    if (boundary === "terminal") {
      const cleanupStarted = createDeferred<void>();
      const cleanupRelease = createDeferred<void>();
      const flush = vi.spyOn(registryModules(registry).threadUsageLedger, "flushLiveThreadUsageLines")
        .mockImplementationOnce(async () => {
          cleanupStarted.resolve();
          await cleanupRelease.promise;
        });
      const terminal = registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "ordinary-thread",
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed", output: [] },
          },
        },
      });
      try {
        await cleanupStarted.promise;
        // Terminal persistence still yields while the live-turn marker is set.
        // A redelivery in that interval must reuse the original child.
        await expect(codexClient.emitRequest(handoffCall)).resolves.toEqual(handoffResponse);
        expect(commandRunner).toHaveBeenCalledTimes(1);
      } finally {
        cleanupRelease.resolve();
        await terminal;
        flush.mockRestore();
      }
    } else {
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "thread/status/changed",
          params: { threadId: "ordinary-thread", status: { type: "idle" } },
        },
      });
    }
    expect(internals.acceptedDynamicToolCalls.size).toBe(0);
    expect(internals.acceptedHandoffTaskRequests.size).toBe(0);
    const staleResponse = await codexClient.emitRequest(handoffCall);
    expect(staleResponse).toMatchObject({ success: false });
    const stalePayload = JSON.parse(
      (staleResponse as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(stalePayload).toMatchObject({ code: "forbidden" });
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(internals.acceptedDynamicToolCalls.size).toBe(0);
    expect(internals.acceptedHandoffTaskRequests.size).toBe(0);

    await registry.close();
    await rm(root, { recursive: true, force: true });
  });

  // The intermediate row's `parentThreadInstanceId` used to decide how far the
  // root walk climbed. Now that a child parents to its own source, it changes
  // nothing — so both shapes must produce the same answer.
  it.each([undefined, "remote-owner"])("groups a handoff from a persisted grandchild under its own source, intermediate owner %s", async (parentThreadInstanceId) => {
    const rootDirectory = {
      id: expectedDir("/repo/app"),
      kind: "local" as const,
      label: "app",
      path: expectedDir("/repo/app"),
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:root-thread": {
          backend: "codex",
          threadId: "root-thread",
          executionMode: "default",
          extraLinkedDirectories: [rootDirectory],
          subthreadOrder: ["older-child", "intermediate-child"],
        },
        "codex:intermediate-child": {
          backend: "codex",
          threadId: "intermediate-child",
          executionMode: "default",
          extraLinkedDirectories: [rootDirectory],
          parentThreadId: "root-thread",
          parentThreadInstanceId,
          subthreadOrder: ["source-grandchild"],
        },
        "codex:source-grandchild": {
          backend: "codex",
          threadId: "source-grandchild",
          executionMode: "default",
          extraLinkedDirectories: [rootDirectory],
          parentThreadId: "intermediate-child",
        },
      },
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
      threads: [
        {
          id: "root-thread",
          title: "Root Thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [rootDirectory],
          updatedAt: 1000,
        },
        {
          id: "intermediate-child",
          title: "Intermediate Child",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [rootDirectory],
          updatedAt: 2000,
        },
        {
          id: "source-grandchild",
          title: "Source Grandchild",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [rootDirectory],
          updatedAt: 3000,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      gitDirectoryService: {
        inspectWorkspaceGit: vi.fn(async () => ({ kind: "non_git" as const })),
      } as never,
      overlayStore,
      threadTitleGenerationService: null,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "source-grandchild",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "source-grandchild",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          task: "Investigate the follow-up.",
          title: "Follow-up",
          groupingMode: "subthread",
          workspaceMode: "none",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toMatchObject({
      threadId: "thread-1",
      groupedUnderThreadId: "source-grandchild",
      origin: {
        sourceThreadId: "source-grandchild",
      },
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      parentThreadId: "source-grandchild",
    });
    // The source owns its own tray, so the new child lands there — and the
    // root's order is left exactly as the operator arranged it.
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "source-grandchild",
      }),
    ).resolves.toMatchObject({
      subthreadOrder: ["thread-1"],
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "root-thread",
      }),
    ).resolves.toMatchObject({
      subthreadOrder: ["older-child", "intermediate-child"],
    });

    await registry.close();
  });

  it("queues same-thread workspace moves from a live dynamic tool call", async () => {
    const thread: AppServerThreadSummary = {
      id: "ordinary-thread",
      title: "Parent Thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          kind: "local",
          label: "app",
          path: "/repo/app",
        },
      ],
      updatedAt: 1000,
    };
    const handoff = vi.fn();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read", "turn/start"] },
      threads: [thread],
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "active",
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "default",
            extraLinkedDirectories: thread.linkedDirectories ?? [],
          },
        },
      }),
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "move-call-1",
        requestId: "move-call-1",
        namespace: "pwragent",
        tool: "move_thread_workspace",
        arguments: {
          sourcePath: "/repo/app",
          leaveLocalBranch: "main",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toMatchObject({
      workspaceMoveId: "workspace-move:codex:ordinary-thread:turn-1:move-call-1",
      status: "queued",
      phase: "waiting_for_turn_boundary",
      direction: "local-to-worktree",
      strategy: "move-branch",
      sourcePath: "/repo/app",
      leaveLocalBranch: "main",
      message: expect.stringContaining("Stop this turn"),
    });
    expect(handoff).not.toHaveBeenCalled();

    const duplicateResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "move-call-2",
        requestId: "move-call-1b",
        namespace: "pwragent",
        tool: "move_thread_workspace",
        arguments: {
          sourcePath: "/repo/app",
          leaveLocalBranch: "main",
        },
      },
    } as AppServerPendingRequestNotification);
    const duplicatePayload = JSON.parse(
      (duplicateResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]!.text,
    );
    expect(duplicatePayload).toMatchObject({
      workspaceMoveId: payload.workspaceMoveId,
      status: "queued",
      strategy: "move-branch",
      sourcePath: "/repo/app",
    });
    expect(handoff).not.toHaveBeenCalled();

    const statusResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "status-call-1",
        requestId: "status-call-1",
        namespace: "pwragent",
        tool: "get_thread_status",
        arguments: {
          backend: "codex",
          threadId: "ordinary-thread",
        },
      },
    } as AppServerPendingRequestNotification);
    const statusPayload = JSON.parse(
      (statusResponse as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(statusPayload.thread.pendingWorkspaceMoves).toEqual([
      expect.objectContaining({
        workspaceMoveId:
          "workspace-move:codex:ordinary-thread:turn-1:move-call-1",
        status: "queued",
        phase: "waiting_for_turn_boundary",
        strategy: "move-branch",
        sourcePath: "/repo/app",
      }),
    ]);

    const searchResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "search-call-1",
        requestId: "search-call-1",
        namespace: "pwragent",
        tool: "search_threads",
        arguments: {
          backend: "codex",
          query: "workspace-move",
        },
      },
    } as AppServerPendingRequestNotification);
    const searchPayload = JSON.parse(
      (searchResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]!.text,
    );
    expect(searchPayload.pendingWorkspaceMoves).toEqual([
      expect.objectContaining({
        workspaceMoveId:
          "workspace-move:codex:ordinary-thread:turn-1:move-call-1",
        status: "queued",
        strategy: "move-branch",
      }),
    ]);

    await registry.close();
  });

  it("drains same-thread workspace moves from idle status boundaries", async () => {
    const thread: AppServerThreadSummary = {
      id: "ordinary-thread",
      title: "Parent Thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          kind: "local",
          label: "app",
          path: "/repo/app",
        },
      ],
      gitBranch: "feature/handoff",
      updatedAt: 1000,
    };
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "ordinary-thread",
      direction: "local-to-worktree" as const,
      workMode: "worktree" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:codex:ordinary-thread",
        kind: "worktree" as const,
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
      },
      warnings: [],
      completedAt: 1000,
    }));
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read", "turn/start"] },
      threads: [thread],
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "default",
            extraLinkedDirectories: thread.linkedDirectories ?? [],
          },
        },
      }),
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "move-call-1",
        requestId: "move-call-1",
        namespace: "pwragent",
        tool: "move_thread_workspace",
        arguments: {
          sourcePath: "/repo/app",
          // Agents never unlock: an approval the agent invents is not forwarded.
          approvedLockReason: "release prep, do not remove",
        },
      },
    } as AppServerPendingRequestNotification);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "thread/status/changed",
        params: {
          threadId: "ordinary-thread",
          status: { type: "idle" },
        },
      },
    });

    await vi.waitFor(() => {
      expect(handoff).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "ordinary-thread",
        direction: "local-to-worktree",
        strategy: "detached-changes",
        repositoryPath: "/repo/app",
        sourcePath: "/repo/app",
      });
    });
    await registry.close();
  });

  it("carries a fresh-worktree baseRef through a queued move", async () => {
    const thread: AppServerThreadSummary = {
      id: "ordinary-thread",
      title: "Parent Thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          kind: "local",
          label: "app",
          path: "/repo/app",
        },
      ],
      gitBranch: "feature/handoff",
      updatedAt: 1000,
    };
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "ordinary-thread",
      direction: "local-to-worktree" as const,
      workMode: "worktree" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:codex:ordinary-thread",
        kind: "worktree" as const,
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
      },
      warnings: [],
      completedAt: 1000,
    }));
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read", "turn/start"] },
      threads: [thread],
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "default",
            extraLinkedDirectories: thread.linkedDirectories ?? [],
          },
        },
      }),
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "move-call-1",
        requestId: "move-call-1",
        namespace: "pwragent",
        tool: "move_thread_workspace",
        arguments: {
          sourcePath: "/repo/app",
          baseRef: "origin/main",
        },
      },
    } as AppServerPendingRequestNotification);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "thread/status/changed",
        params: {
          threadId: "ordinary-thread",
          status: { type: "idle" },
        },
      },
    });

    await vi.waitFor(() => {
      expect(handoff).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "ordinary-thread",
        direction: "local-to-worktree",
        strategy: "detached-changes",
        repositoryPath: "/repo/app",
        sourcePath: "/repo/app",
        baseRef: "origin/main",
      });
    });
    await registry.close();
  });

  it("reports running workspace moves as in-progress quit work", async () => {
    const handoffDeferred = createDeferred<{
      backend: "codex";
      threadId: string;
      direction: "local-to-worktree";
      workMode: "worktree";
      branch: string;
      repositoryPath: string;
      targetPath: string;
      linkedDirectory: LinkedDirectorySummary;
      warnings: string[];
      completedAt: number;
    }>();
    const thread: AppServerThreadSummary = {
      id: "ordinary-thread",
      title: "Parent Thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          kind: "local",
          label: "app",
          path: "/repo/app",
        },
      ],
      gitBranch: "feature/handoff",
      updatedAt: 1000,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read", "turn/start"] },
      threads: [thread],
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "default",
            extraLinkedDirectories: thread.linkedDirectories ?? [],
          },
        },
      }),
      gitWorkspaceHandoffService: {
        handoff: vi.fn(async () => await handoffDeferred.promise),
      } as never,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "move-call-1",
        requestId: "move-call-1",
        namespace: "pwragent",
        tool: "move_thread_workspace",
        arguments: {
          sourcePath: "/repo/app",
        },
      },
    } as AppServerPendingRequestNotification);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", output: [] },
        },
      },
    });

    await vi.waitFor(() => {
      expect(registry.getInProgressThreadSnapshotForQuit()).toEqual({
        count: 1,
        threadIds: ["codex:ordinary-thread"],
        threadTitles: {
          "codex:ordinary-thread": "Parent Thread",
        },
      });
    });

    handoffDeferred.resolve({
      backend: "codex",
      threadId: "ordinary-thread",
      direction: "local-to-worktree",
      workMode: "worktree",
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:codex:ordinary-thread",
        kind: "worktree",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
      },
      warnings: [],
      completedAt: 1000,
    });
    await vi.waitFor(() => {
      expect(codexClient.startTurnCallCount).toBe(1);
    });

    await registry.close();
  });

  it("rejects invalid same-thread workspace move requests before handoff", async () => {
    const thread: AppServerThreadSummary = {
      id: "ordinary-thread",
      title: "Parent Thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          kind: "local",
          label: "app",
          path: "/repo/app",
        },
        {
          id: "directory:/repo/other",
          kind: "local",
          label: "other",
          path: "/repo/other",
        },
      ],
      updatedAt: 1000,
    };
    const handoff = vi.fn();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read", "turn/start"] },
      threads: [thread],
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "active",
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "default",
            extraLinkedDirectories: thread.linkedDirectories ?? [],
          },
        },
      }),
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    async function callMove(
      callId: string,
      args: Record<string, unknown>,
      turnId = "turn-1",
    ) {
      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId,
          callId,
          requestId: callId,
          namespace: "pwragent",
          tool: "move_thread_workspace",
          arguments: args,
        },
      } as AppServerPendingRequestNotification);
      return JSON.parse(
        (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
      );
    }

    await expect(callMove("move-call-no-turn", {})).resolves.toMatchObject({
      code: "forbidden",
    });

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    await expect(
      callMove("move-call-wrong-turn", {}, "turn-2"),
    ).resolves.toMatchObject({
      code: "forbidden",
    });
    await expect(
      callMove("move-call-unlinked-path", {
        repositoryPath: "/repo/unlinked",
        sourcePath: "/repo/unlinked",
      }),
    ).resolves.toMatchObject({
      code: "unsupported_workspace",
    });
    const ambiguousPayload = await callMove("move-call-ambiguous", {});
    expect(ambiguousPayload).toMatchObject({
      code: "ambiguous_workspace",
    });
    await expect(
      callMove("move-call-backend", {
        backend: "acp:grok",
        repositoryPath: "/repo/app",
        sourcePath: "/repo/app",
      }),
    ).resolves.toMatchObject({
      code: "unsupported_backend",
    });
    await expect(
      callMove("move-call-direction", {
        direction: "worktree-to-local",
        repositoryPath: "/repo/app",
        sourcePath: "/repo/app",
      }),
    ).resolves.toMatchObject({
      code: "unsupported_workspace",
    });
    expect(handoff).not.toHaveBeenCalled();

    await registry.close();
  });

  it("runs queued same-thread workspace moves after the invoking turn ends", async () => {
    const thread: AppServerThreadSummary = {
      id: "ordinary-thread",
      title: "Parent Thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          kind: "local",
          label: "app",
          path: "/repo/app",
        },
      ],
      gitBranch: "feature/handoff",
      updatedAt: 1000,
    };
    const overlayStore = createOverlayStoreMock();
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "ordinary-thread",
      direction: "local-to-worktree" as const,
      workMode: "worktree" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:codex:ordinary-thread",
        kind: "worktree" as const,
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
      },
      warnings: [],
      completedAt: 1000,
    }));
    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read", "turn/start"] },
      threads: [thread],
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      gitDirectoryService: {
        recordCodexWorktreeOwnerThread,
      } as never,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "move-call-1",
        requestId: "move-call-1",
        namespace: "pwragent",
        tool: "move_thread_workspace",
        arguments: {
          sourcePath: "/repo/app",
          leaveLocalBranch: "main",
        },
      },
    } as AppServerPendingRequestNotification);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", output: [] },
        },
      },
    });

    await vi.waitFor(() => {
      expect(handoff).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "ordinary-thread",
        direction: "local-to-worktree",
        strategy: "move-branch",
        repositoryPath: "/repo/app",
        sourcePath: "/repo/app",
        leaveLocalBranch: "main",
      });
    });
    await vi.waitFor(() => {
      expect(recordCodexWorktreeOwnerThread).toHaveBeenCalledWith({
        threadId: "ordinary-thread",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
      });
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "ordinary-thread",
      }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [
        expect.objectContaining({
          id: "pwragent-handoff:codex:ordinary-thread",
          kind: "worktree",
          worktreePath: "/repo/app/.worktrees/app-feature-handoff",
        }),
      ],
    });
    await vi.waitFor(() => {
      expect(codexClient.lastStartTurnParams).toMatchObject({
        threadId: "ordinary-thread",
      });
    });
    const prompt =
      codexClient.lastStartTurnParams?.input[0]?.type === "text"
        ? codexClient.lastStartTurnParams.input[0].text
        : "";
    expect(prompt).toContain("PwrAgent workspace move completed");
    expect(prompt).toContain("New runtime cwd: /repo/app/.worktrees/app-feature-handoff");
    await registry.close();
  });

  it.each(["present", "removed", "redirected"] as const)("continues a same-thread existing-worktree move at the turn boundary (destination: %s)", async (destination) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-adopt-worktree-")));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, ".codex", "worktrees", "original", "demo");
    const targetPath = path.join(root, "claude-worktrees", "demo", "interesting-poitras");
    const repositoryPath = path.join(root, "github", "demo");
    await Promise.all([sourcePath, targetPath, repositoryPath].map((cwd) => mkdir(cwd, { recursive: true })));
    const thread: AppServerThreadSummary = {
      id: "ordinary-thread", title: "Adopt worktree", titleSource: "explicit", source: "codex",
      projectKey: expectedDir(sourcePath), updatedAt: 1000,
      linkedDirectories: [{
        id: "original", kind: "worktree", label: "demo", path: expectedDir(repositoryPath),
        worktreePath: expectedDir(sourcePath),
      }],
    };
    const overlayStore = createOverlayStoreMock({ overlays: {
      "codex:ordinary-thread": {
        backend: "codex", threadId: thread.id, executionMode: "full-access", extraLinkedDirectories: [],
      },
    } });
    const handoff = vi.fn(async (): Promise<HandoffThreadWorkspaceResponse> => ({
      backend: "codex", threadId: thread.id, direction: "to-project", workMode: "worktree",
      repositoryPath: expectedDir(repositoryPath), targetPath: expectedDir(targetPath), branch: "claude/feature",
      linkedDirectory: {
        id: "pwragent-handoff:codex:ordinary-thread", kind: "worktree", label: "demo",
        path: expectedDir(repositoryPath), worktreePath: expectedDir(targetPath), worktreeOwnership: "external",
      },
      warnings: [], completedAt: 1000,
    }));
    const recordCodexWorktreeOwnerThread = vi.fn();
    const codexClient = new MockBackendClient({ threads: [thread] });
    const registry = createDesktopBackendRegistry({
      codexClient, overlayStore,
      gitWorkspaceHandoffService: { handoff } as never,
      gitDirectoryService: { recordCodexWorktreeOwnerThread } as never,
    });
    onTestFinished(() => registry.close());
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: thread.id, turnId: "turn-1", turn: { id: "turn-1" } },
    } });
    const callMove = async (callId: string, destination: string) => {
      const response = await codexClient.emitRequest({ method: "item/tool/call", params: {
        threadId: thread.id, turnId: "turn-1", callId, requestId: callId, namespace: "pwragent",
        tool: "move_thread_workspace", arguments: { direction: "to-project", targetPath: destination },
      } } as AppServerPendingRequestNotification);
      return JSON.parse((response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text);
    };
    const queued = await callMove("move-1", targetPath);
    expect(queued).toMatchObject({ status: "queued", direction: "to-project", targetPath });
    expect(queued.strategy).toBeUndefined();
    expect(handoff).not.toHaveBeenCalled();
    expect(codexClient.lastUpdateThreadWorkspaceParams).toBeUndefined();
    expect(await callMove("move-2", targetPath)).toMatchObject({ workspaceMoveId: queued.workspaceMoveId });
    expect(await callMove("move-3", repositoryPath)).toMatchObject({ code: "unsupported_workspace" });
    if (destination !== "present") await rm(targetPath, { recursive: true });
    if (destination === "redirected") await symlink(repositoryPath, targetPath, "junction");
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/completed", params: {
        threadId: thread.id, turnId: "turn-1", turn: { id: "turn-1", status: "completed", output: [] },
      },
    } });
    await vi.waitFor(() => expect(codexClient.startTurnCallCount).toBe(1));
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: thread.id, cwd: expectedDir(destination !== "present" ? sourcePath : targetPath),
    });
    expect(recordCodexWorktreeOwnerThread).not.toHaveBeenCalled();
    if (destination !== "present") {
      expect(handoff).not.toHaveBeenCalled();
      expect(codexClient.lastUpdateThreadWorkspaceParams).toBeUndefined();
    } else {
      expect(handoff).toHaveBeenCalledTimes(1);
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ direction: "to-project", targetPath }));
      expect(codexClient.lastUpdateThreadWorkspaceParams).toMatchObject({ threadId: thread.id, cwd: expectedDir(targetPath) });
      expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: thread.id }))?.extraLinkedDirectories)
        .toEqual([expect.objectContaining({ path: expectedDir(repositoryPath), worktreePath: expectedDir(targetPath), worktreeOwnership: "external" })]);
    }
  });

  describe.each(["default", "auto"] as const)("existing-worktree trust in %s mode", (executionMode) => {
    it.each([
      "repository", "ancestor", "symlink", "worktree-only", "remote-only", "other-clone",
      "unregistered-primary-gitdir", "unregistered-linked-gitdir",
    ] as const)(
      "checks the destination's Git repository against %s trust",
      async (trustSource) => {
        const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-trust-")));
        onTestFinished(() => rm(root, { recursive: true, force: true }));
        const repositoryPath = path.join(root, "projects", "demo");
        const sourcePath = path.join(root, "worktrees", "source", "demo");
        const targetPath = path.join(root, "worktrees", "target", "demo");
        await mkdir(repositoryPath, { recursive: true });
        await git(repositoryPath, ["init", "-b", "main"]);
        await writeFile(path.join(repositoryPath, "README.md"), "fixture\n");
        await git(repositoryPath, ["add", "README.md"]);
        await git(repositoryPath, ["commit", "-m", "initial"]);
        await git(repositoryPath, ["worktree", "add", "--detach", sourcePath, "main"]);
        if (trustSource === "unregistered-primary-gitdir" || trustSource === "unregistered-linked-gitdir") {
          await mkdir(targetPath, { recursive: true });
          const gitDir = trustSource === "unregistered-primary-gitdir"
            ? path.join(repositoryPath, ".git")
            : await git(sourcePath, ["rev-parse", "--absolute-git-dir"]);
          await writeFile(path.join(targetPath, ".git"), `gitdir: ${expectedDir(gitDir)}\n`);
          expect(await git(targetPath, ["rev-parse", "--show-toplevel"])).toBe(expectedDir(targetPath));
          const worktreeList = await git(targetPath, ["worktree", "list", "--porcelain"]);
          expect(worktreeList).not.toContain(`worktree ${expectedDir(targetPath)}\n`);
        } else if (trustSource === "other-clone") {
          const clonePath = path.join(root, "clone");
          await git(root, ["clone", repositoryPath, clonePath]);
          await git(clonePath, ["worktree", "add", "--detach", targetPath, "HEAD"]);
        } else {
          await git(repositoryPath, ["worktree", "add", "--detach", targetPath, "main"]);
        }
        let trustedPath = repositoryPath;
        if (trustSource === "ancestor") trustedPath = path.dirname(repositoryPath);
        if (trustSource === "worktree-only") trustedPath = sourcePath;
        if (trustSource === "symlink") {
          trustedPath = path.join(root, "trusted-alias");
          await symlink(repositoryPath, trustedPath, "junction");
        }
        const thread: AppServerThreadSummary = {
          id: "ordinary-thread", title: "Move worktree", titleSource: "explicit", source: "codex",
          projectKey: expectedDir(sourcePath), updatedAt: 1000,
          linkedDirectories: [{
            id: expectedDir(sourcePath), kind: "worktree", label: "demo",
            path: expectedDir(repositoryPath), worktreePath: expectedDir(sourcePath),
          }],
        };
        const overlayStore = createOverlayStoreMock({ overlays: {
          "codex:ordinary-thread": {
            backend: "codex", threadId: thread.id, executionMode, extraLinkedDirectories: [],
          },
        } });
        await overlayStore.upsertDirectoryLaunchpad({
          directoryKey: trustSource === "remote-only"
            ? launchpadStorageKey(`directory:${expectedDir(trustedPath)}`, { scope: "remote", instanceId: "peer-instance" })
            : `directory:${expectedDir(trustedPath)}`,
          directoryKind: "directory", directoryLabel: "demo", directoryPath: expectedDir(trustedPath),
          backend: "codex", executionMode, workMode: "worktree", prompt: "", createdAt: 1000, updatedAt: 1000,
        });
        const codexClient = new MockBackendClient({ threads: [thread] });
        const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
        onTestFinished(() => registry.close());
        await registry.publishLocalEvent({ backend: "codex", notification: {
          method: "turn/started", params: { threadId: thread.id, turnId: "turn-1", turn: { id: "turn-1" } },
        } });
        let settled = false;
        const pending = codexClient.emitRequest({ method: "item/tool/call", params: {
          threadId: thread.id, turnId: "turn-1", callId: "move", requestId: "move", namespace: "pwragent",
          tool: "move_thread_workspace", arguments: { direction: "to-project", targetPath },
        } } as AppServerPendingRequestNotification).then((response) => {
          settled = true;
          return response;
        });
        await vi.waitFor(() => expect(settled || registry.getPendingRequestForThread({
          backend: "codex", threadId: thread.id,
        })).toBeTruthy());
        const inputRequest = registry.getPendingRequestForThread({ backend: "codex", threadId: thread.id });
        if (inputRequest?.method === "item/tool/requestUserInput") {
          await registry.submitServerRequest({
            backend: "codex", threadId: thread.id, turnId: "turn-1", requestId: inputRequest.params.requestId,
            response: { answers: { trust_directory: { answers: ["Cancel move"] } } },
          });
        }
        const response = await pending;
        const trusted = ["repository", "ancestor", "symlink"].includes(trustSource);
        expect(response).toMatchObject({ success: trusted });
        const payload = JSON.parse((response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text);
        expect(payload).toMatchObject(trusted
          ? { status: "queued", targetPath }
          : { code: "forbidden" });
        expect(Boolean(inputRequest)).toBe(!trusted);
      },
    );
  });

  it.each(["default", "auto"] as const)("requires trust before adopting an untrusted existing workspace in %s mode", async (executionMode) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-adopt-trust-")));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const handoff = vi.fn();
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({
      codexClient, overlayStore: createOverlayStoreMock({ overlays: { "codex:agent-thread": { ...createAgentOverlay(), executionMode } } }),
      gitWorkspaceHandoffService: { handoff } as never,
    });
    onTestFinished(() => registry.close());
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "agent-thread", turnId: "turn-1", turn: { id: "turn-1" } },
    } });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => { events.push(event); });
    onTestFinished(unsubscribe);
    const pending = codexClient.emitRequest({ method: "item/tool/call", params: {
      threadId: "agent-thread", turnId: "turn-1", callId: "move", requestId: "move", namespace: "pwragent",
      tool: "move_thread_workspace", arguments: { direction: "to-project", targetPath: root },
    } } as AppServerPendingRequestNotification);
    await vi.waitFor(() => expect(events.some((event) => event.notification.method === "item/tool/requestUserInput")).toBe(true));
    const request = events.find((event) => event.notification.method === "item/tool/requestUserInput")!.notification;
    if (request.method !== "item/tool/requestUserInput") throw new Error("Expected trust confirmation");
    expect(handoff).not.toHaveBeenCalled();
    const modeLabel = executionMode === "auto" ? "Auto" : "Default Access";
    expect(request.params.questions).toEqual([expect.objectContaining({
      question: `Trust ${expectedDir(root)} and allow ${modeLabel} agent threads to read, write, and delete files in it?`,
      options: expect.arrayContaining([expect.objectContaining({
        description: `Trust this directory for future ${modeLabel} agent work.`,
      })]),
    })]);
    await registry.submitServerRequest({ backend: "codex", threadId: "agent-thread", turnId: "turn-1",
      requestId: request.params.requestId, response: { answers: { trust_directory: { answers: ["Cancel move"] } } },
    });
    expect(await pending).toMatchObject({ success: false });
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/completed", params: { threadId: "agent-thread", turnId: "turn-1", turn: { id: "turn-1", status: "completed", output: [] } },
    } });
    expect(handoff).not.toHaveBeenCalled();
    expect(codexClient.startTurnCallCount).toBe(0);
  });

  it.each([false, true])("admits one workspace move after concurrent trust approvals (same destination: %s)", async (sameDestination) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-concurrent-move-")));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const firstPath = path.join(root, "first");
    const secondPath = sameDestination ? firstPath : path.join(root, "second");
    await mkdir(firstPath);
    if (!sameDestination) await mkdir(secondPath);
    const thread: AppServerThreadSummary = {
      id: "agent-thread", title: "Concurrent move", titleSource: "explicit", source: "codex", updatedAt: 1000,
      linkedDirectories: [],
    };
    const codexClient = new MockBackendClient({ threads: [thread] });
    const handoff = vi.fn(async (): Promise<HandoffThreadWorkspaceResponse> => ({
      backend: "codex", threadId: thread.id, direction: "to-project", workMode: "local",
      repositoryPath: expectedDir(firstPath), targetPath: expectedDir(firstPath),
      linkedDirectory: { id: "pwragent-handoff:codex:agent-thread", kind: "local", label: "first", path: expectedDir(firstPath) },
      warnings: [], completedAt: 1000,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient, overlayStore: createOverlayStoreMock({ overlays: { "codex:agent-thread": createAgentOverlay() } }),
      gitWorkspaceHandoffService: { handoff } as never,
    });
    onTestFinished(() => registry.close());
    // The workspace service reaches the launchpad through its host, which
    // delegates to the directory service.
    vi.spyOn(registryModules(registry).threadDirectoryService, "ensureDirectoryLaunchpad").mockResolvedValue({} as never);
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: thread.id, turnId: "turn-1", turn: { id: "turn-1" } },
    } });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => { events.push(event); });
    onTestFinished(unsubscribe);
    const callMove = (callId: string, targetPath: string) => codexClient.emitRequest({ method: "item/tool/call", params: {
      threadId: thread.id, turnId: "turn-1", callId, requestId: callId, namespace: "pwragent",
      tool: "move_thread_workspace", arguments: { direction: "to-project", targetPath },
    } } as AppServerPendingRequestNotification);
    const first = callMove("move-1", firstPath);
    const second = callMove("move-2", secondPath);
    await vi.waitFor(() => expect(events.filter((event) => event.notification.method === "item/tool/requestUserInput")).toHaveLength(2));
    const approve = async (callId: string) => {
      const request = events.find((event) => event.notification.method === "item/tool/requestUserInput"
        && event.notification.params.itemId === callId)!.notification;
      if (request.method !== "item/tool/requestUserInput") throw new Error("Expected trust request");
      await registry.submitServerRequest({ backend: "codex", threadId: thread.id, turnId: "turn-1",
        requestId: request.params.requestId,
        response: { answers: { trust_directory: { answers: ["Trust directory (Recommended)"] } } },
      });
    };
    const payload = (response: unknown) => JSON.parse((response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text);
    await approve("move-1");
    const firstResult = payload(await first);
    expect(firstResult.status).toBe("queued");
    await approve("move-2");
    const secondResult = payload(await second);
    expect(secondResult).toMatchObject(sameDestination
      ? { workspaceMoveId: firstResult.workspaceMoveId }
      : { code: "unsupported_workspace" });
    expect(handoff).not.toHaveBeenCalled();
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/completed", params: { threadId: thread.id, turnId: "turn-1", turn: { id: "turn-1", status: "completed", output: [] } },
    } });
    await vi.waitFor(() => expect(codexClient.startTurnCallCount).toBe(1));
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(codexClient.lastStartTurnParams).toMatchObject({ threadId: thread.id, cwd: expectedDir(firstPath) });
  });

  it("starts the workspace move continuation before queued same-thread turns", async () => {
    const thread: AppServerThreadSummary = {
      id: "ordinary-thread",
      title: "Parent Thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          kind: "local",
          label: "app",
          path: "/repo/app",
        },
      ],
      gitBranch: "feature/handoff",
      updatedAt: 1000,
    };
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "ordinary-thread",
      direction: "local-to-worktree" as const,
      workMode: "worktree" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:codex:ordinary-thread",
        kind: "worktree" as const,
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
      },
      warnings: [],
      completedAt: 1000,
    }));
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read", "turn/start"] },
      threads: [thread],
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "default",
            extraLinkedDirectories: thread.linkedDirectories ?? [],
          },
        },
      }),
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    await expect(
      registry.submitTurn({
        backend: "codex",
        threadId: "ordinary-thread",
        input: [{ type: "text", text: "queued normal turn" }],
      }),
    ).resolves.toMatchObject({ status: "queued" });
    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "move-call-1",
        requestId: "move-call-1",
        namespace: "pwragent",
        tool: "move_thread_workspace",
        arguments: {
          sourcePath: "/repo/app",
        },
      },
    } as AppServerPendingRequestNotification);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", output: [] },
        },
      },
    });

    await vi.waitFor(() => {
      expect(codexClient.startTurnCalls.length).toBe(1);
    });
    const firstInput = codexClient.startTurnCalls[0]?.input[0];
    expect(firstInput).toMatchObject({
      type: "text",
      text: expect.stringContaining("PwrAgent workspace move completed"),
    });
    expect(codexClient.startTurnCalls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: [{ type: "text", text: "queued normal turn" }],
        }),
      ]),
    );

    await registry.close();
  });

  it("reports failed same-thread workspace moves through a continuation", async () => {
    const thread: AppServerThreadSummary = {
      id: "ordinary-thread",
      title: "Parent Thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          kind: "local",
          label: "app",
          path: "/repo/app",
        },
      ],
      gitBranch: "feature/handoff",
      updatedAt: 1000,
    };
    const handoff = vi.fn(async () => {
      throw new Error("worktree setup failed");
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read", "turn/start"] },
      threads: [thread],
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "move-call-1",
        requestId: "move-call-1",
        namespace: "pwragent",
        tool: "move_thread_workspace",
        arguments: {
          sourcePath: "/repo/app",
        },
      },
    } as AppServerPendingRequestNotification);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", output: [] },
        },
      },
    });

    await vi.waitFor(() => {
      expect(codexClient.lastStartTurnParams).toMatchObject({
        threadId: "ordinary-thread",
      });
    });
    const prompt =
      codexClient.lastStartTurnParams?.input[0]?.type === "text"
        ? codexClient.lastStartTurnParams.input[0].text
        : "";
    expect(prompt).toContain("PwrAgent workspace move failed");
    expect(prompt).toContain("worktree setup failed");
    expect(prompt).toContain("original runtime workspace remains authoritative");

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-2",
          turn: { id: "turn-2" },
        },
      },
    });
    const statusResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-2",
        callId: "status-call-1",
        requestId: "status-call-1",
        namespace: "pwragent",
        tool: "get_thread_status",
        arguments: {
          backend: "codex",
          threadId: "ordinary-thread",
        },
      },
    } as AppServerPendingRequestNotification);
    const statusPayload = JSON.parse(
      (statusResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]!.text,
    );
    expect(statusPayload.thread.pendingWorkspaceMoves).toEqual([
      expect.objectContaining({
        workspaceMoveId:
          "workspace-move:codex:ordinary-thread:turn-1:move-call-1",
        status: "failed",
        phase: "failed",
        error: "worktree setup failed",
      }),
    ]);

    await registry.close();
  });

  it("keeps failed workspace move state and queued work when failure continuation cannot start", async () => {
    const thread: AppServerThreadSummary = {
      id: "ordinary-thread",
      title: "Parent Thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          kind: "local",
          label: "app",
          path: "/repo/app",
        },
      ],
      updatedAt: 1000,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read", "turn/start"] },
      threads: [thread],
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      },
      startTurnError: new Error("continuation boom"),
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      gitWorkspaceHandoffService: {
        handoff: vi.fn(async () => {
          throw new Error("worktree setup failed");
        }),
      } as never,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    await expect(
      registry.submitTurn({
        backend: "codex",
        threadId: "ordinary-thread",
        input: [{ type: "text", text: "queued normal turn" }],
      }),
    ).resolves.toMatchObject({ status: "queued" });
    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "move-call-1",
        requestId: "move-call-1",
        namespace: "pwragent",
        tool: "move_thread_workspace",
        arguments: {
          sourcePath: "/repo/app",
        },
      },
    } as AppServerPendingRequestNotification);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", output: [] },
        },
      },
    });
    await vi.waitFor(() => {
      expect(registry.getQueuedTurnsSnapshot()).toEqual({
        [buildThreadIdentityKey("codex", "ordinary-thread")]: [
          expect.objectContaining({
            displayText: "queued normal turn",
            manualReleaseRequired: true,
            position: 0,
          }),
        ],
      });
    });
    expect(codexClient.startTurnCallCount).toBe(1);
    expect(registry.canStartThreadTurnImmediately({
      backend: "codex",
      threadId: "ordinary-thread",
    })).toBe(false);
    expect(registry.getQueuedTurnsSnapshot()).toEqual({
      [buildThreadIdentityKey("codex", "ordinary-thread")]: [
        expect.objectContaining({
          displayText: "queued normal turn",
          manualReleaseRequired: true,
          position: 0,
        }),
      ],
    });
    expect(registry.getInProgressThreadSnapshotForQuit()).toEqual({
      count: 1,
      threadIds: [buildThreadIdentityKey("codex", "ordinary-thread")],
      threadTitles: {
        [buildThreadIdentityKey("codex", "ordinary-thread")]: "Parent Thread",
      },
    });

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-2",
          turn: { id: "turn-2" },
        },
      },
    });
    const statusResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-2",
        callId: "status-call-1",
        requestId: "status-call-1",
        namespace: "pwragent",
        tool: "get_thread_status",
        arguments: {
          backend: "codex",
          threadId: "ordinary-thread",
        },
      },
    } as AppServerPendingRequestNotification);
    const statusPayload = JSON.parse(
      (statusResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]!.text,
    );
    expect(statusPayload.thread.pendingWorkspaceMoves).toEqual([
      expect.objectContaining({
        status: "failed",
        phase: "failed",
        error: expect.stringContaining("Workspace handoff failed: worktree setup failed"),
        message: expect.stringContaining("failure continuation also failed"),
      }),
    ]);
    expect(statusPayload.thread.pendingWorkspaceMoves[0].error).toContain(
      "failure continuation failed: continuation boom",
    );

    await registry.close();
  });

  it("retains queued turns when success continuation cannot start", async () => {
    const thread: AppServerThreadSummary = {
      id: "ordinary-thread",
      title: "Parent Thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          kind: "local",
          label: "app",
          path: "/repo/app",
        },
      ],
      updatedAt: 1000,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read", "turn/start"] },
      threads: [thread],
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      },
      startTurnError: new Error("continuation boom"),
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      gitWorkspaceHandoffService: {
        handoff: vi.fn(async () => ({
          backend: "codex" as const,
          threadId: "ordinary-thread",
          direction: "local-to-worktree" as const,
          workMode: "worktree" as const,
          branch: "feature/handoff",
          repositoryPath: "/repo/app",
          targetPath: "/repo/app/.worktrees/app-feature-handoff",
          linkedDirectory: {
            id: "pwragent-handoff:codex:ordinary-thread",
            kind: "worktree" as const,
            label: "app",
            path: "/repo/app",
            worktreePath: "/repo/app/.worktrees/app-feature-handoff",
          },
          warnings: [],
          completedAt: 1000,
        })),
      } as never,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    await expect(
      registry.submitTurn({
        backend: "codex",
        threadId: "ordinary-thread",
        input: [{ type: "text", text: "queued normal turn" }],
      }),
    ).resolves.toMatchObject({ status: "queued" });
    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "move-call-1",
        requestId: "move-call-1",
        namespace: "pwragent",
        tool: "move_thread_workspace",
        arguments: {
          sourcePath: "/repo/app",
        },
      },
    } as AppServerPendingRequestNotification);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", output: [] },
        },
      },
    });

    await vi.waitFor(() => {
      expect(registry.getQueuedTurnsSnapshot()).toEqual({
        [buildThreadIdentityKey("codex", "ordinary-thread")]: [
          expect.objectContaining({
            displayText: "queued normal turn",
            manualReleaseRequired: true,
            position: 0,
          }),
        ],
      });
    });
    expect(codexClient.startTurnCallCount).toBe(1);
    expect(registry.canStartThreadTurnImmediately({
      backend: "codex",
      threadId: "ordinary-thread",
    })).toBe(false);
    expect(registry.getQueuedTurnsSnapshot()).toEqual({
      [buildThreadIdentityKey("codex", "ordinary-thread")]: [
        expect.objectContaining({
          displayText: "queued normal turn",
          manualReleaseRequired: true,
          position: 0,
        }),
      ],
    });
    expect(registry.getInProgressThreadSnapshotForQuit()).toEqual({
      count: 1,
      threadIds: [buildThreadIdentityKey("codex", "ordinary-thread")],
      threadTitles: {
        [buildThreadIdentityKey("codex", "ordinary-thread")]: "Parent Thread",
      },
    });

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-2",
          turn: { id: "turn-2" },
        },
      },
    });
    const statusResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-2",
        callId: "status-call-1",
        requestId: "status-call-1",
        namespace: "pwragent",
        tool: "get_thread_status",
        arguments: {
          backend: "codex",
          threadId: "ordinary-thread",
        },
      },
    } as AppServerPendingRequestNotification);
    const statusPayload = JSON.parse(
      (statusResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]!.text,
    );
    expect(statusPayload.thread.pendingWorkspaceMoves).toEqual([
      expect.objectContaining({
        status: "completed",
        phase: "completed",
        error: "continuation boom",
        message: expect.stringContaining("continuation failed"),
      }),
    ]);

    await registry.close();
  });

  it("creates new-worktree handoff threads when inherited environment setup is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-env-missing-"));
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "worktree");
    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
    } catch {
      await git(repoPath, ["init"]);
      await git(repoPath, ["checkout", "-b", "main"]);
    }
    await writeFile(path.join(repoPath, "README.md"), "handoff\n", "utf8");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "initial"]);
    await mkdir(worktreePath, { recursive: true });
    const sourceRuntime: CodexThreadEnvironmentRuntime = {
      environmentId: "environment",
      environmentName: "ExampleApp",
      executionTarget: "local",
      cwd: repoPath,
      setupStatus: "completed",
      setupCommand: "printf setup",
      selectedActionIdByEnvironmentId: {
        environment: "dev",
      },
      actions: [
        {
          id: "dev",
          name: "Dev",
          command: "pnpm dev",
        },
      ],
    };
    const prepareLaunchpadWorkspace = vi.fn(async () => ({
      cwd: worktreePath,
      repositoryPath: repoPath,
      workMode: "worktree" as const,
      rollback: vi.fn(async () => {}),
    }));
    const commandRunner: CodexEnvironmentCommandRunner = vi.fn(async () => {
      throw new Error("setup should not run without an environment file");
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
      threads: [
        {
          id: "ordinary-thread",
          title: "Parent Thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [
            {
              id: expectedDir(repoPath),
              kind: "local",
              label: "repo",
              path: expectedDir(repoPath),
            },
          ],
          updatedAt: 1000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:ordinary-thread": {
          backend: "codex",
          threadId: "ordinary-thread",
          executionMode: "full-access",
          codexEnvironmentRuntime: sourceRuntime,
          extraLinkedDirectories: [
            {
              id: expectedDir(repoPath),
              kind: "local",
              label: "repo",
              path: expectedDir(repoPath),
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      codexEnvironmentCommandRunner: commandRunner,
      gitDirectoryService: {
        inspectWorkspaceGit: vi.fn(async (cwd: string) => ({
          kind: "worktree" as const,
          branch: cwd === worktreePath ? "HEAD" : "main",
          hasCommits: true,
          headHasCommit: true,
          worktreeCreationAvailable: true,
        })),
        prepareLaunchpadWorkspace,
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
      overlayStore,
      threadTitleGenerationService: null,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          task: "Backport the fix from master.",
          title: "Backport fix",
          workspaceMode: "new_worktree",
          branchName: "origin/master",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(codexClient.lastStartThreadParams?.cwd).toBe(worktreePath);
    expect(codexClient.lastStartThreadParams?.codexEnvironmentRuntime).toMatchObject({
      environmentId: "environment",
      environmentName: "ExampleApp",
      cwd: worktreePath,
      setupStatus: "failed",
      setupOutput: expect.stringContaining("is not available in the forked worktree"),
    });
    expect(codexClient.lastStartTurnParams?.threadId).toBe("thread-1");
    const prompt =
      (codexClient.lastStartTurnParams?.input[0] as { text?: string } | undefined)
        ?.text ?? "";
    expect(prompt).toContain("Codex environment startup:");
    expect(prompt).toContain("- Status: failed");
    expect(prompt).toContain("is not available in the forked worktree");
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.codexEnvironmentStartupFailure).toMatchObject({
      phase: "setup",
      worktreeCleanupAvailable: true,
      message: expect.stringContaining("is not available in the forked worktree"),
    });
    expect(payload.inheritedSettings.codexEnvironmentRuntime).toMatchObject({
      environmentId: "environment",
      cwd: worktreePath,
      setupStatus: "failed",
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      codexEnvironmentRuntime: {
        environmentId: "environment",
        cwd: worktreePath,
        setupStatus: "failed",
      },
    });

    await registry.close();
    await rm(root, { recursive: true, force: true });
  });

  it("rejects ungrouped same-workspace thread handoff dynamic tool calls", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          task: "Investigate issue XYZ and report back.",
          groupingMode: "none",
          workspaceMode: "same_workspace",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(
            {
              code: "invalid_arguments",
              message:
                'workspaceMode="same_workspace" is only valid for grouped subthread handoffs. Use workspaceMode="new_worktree" for a delegated thread with an isolated worktree, workspaceMode="project_local" for the project checkout, or workspaceMode="none" for an unscoped local thread.',
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(codexClient.lastStartThreadParams).toBeUndefined();
    expect(codexClient.lastStartTurnParams).toBeUndefined();

    await registry.close();
  });

  it("starts project-local handoffs in the primary repo checkout instead of the caller worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-project-local-"));
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "worktree");
    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
    } catch {
      await git(repoPath, ["init"]);
      await git(repoPath, ["checkout", "-b", "main"]);
    }
    await writeFile(path.join(repoPath, "README.md"), "handoff\n", "utf8");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "initial"]);
    await git(repoPath, ["worktree", "add", "--detach", worktreePath, "main"]);

    const linkedDirectory = {
      id: expectedDir(repoPath),
      kind: "worktree" as const,
      label: "repo",
      path: expectedDir(repoPath),
      worktreePath: expectedDir(worktreePath),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
      threads: [
        {
          id: "ordinary-thread",
          title: "Parent Thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [linkedDirectory],
          updatedAt: 1000,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      gitDirectoryService: new GitDirectoryService({
        resolveWorktreeStorage: () => "in-repo",
      }),
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "full-access",
            extraLinkedDirectories: [linkedDirectory],
          },
        },
      }),
      threadTitleGenerationService: null,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          task: "Investigate issue XYZ from the project checkout.",
          title: "Project local handoff",
          workspaceMode: "project_local",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    const realRepoPath = expectedDir(await realpath(repoPath));
    const realWorktreePath = expectedDir(await realpath(worktreePath));
    expect(codexClient.lastStartThreadParams?.cwd).toBe(realRepoPath);
    expect(codexClient.lastStartThreadParams?.cwd).not.toBe(realWorktreePath);
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.workspace).toMatchObject({
      mode: "project_local",
      cwd: realRepoPath,
      branch: "main",
      git: {
        kind: "git_local",
        worktreeCreationAvailable: true,
      },
    });

    await registry.close();
    await rm(root, { recursive: true, force: true });
  });

  it("starts project-local handoffs from an explicit cwd instead of a stale parent linked directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-project-local-cwd-"));
    const parentRepoPath = path.join(root, "parent-project");
    const targetRepoPath = path.join(root, "target-project");
    try {
      for (const repoPath of [parentRepoPath, targetRepoPath]) {
        await mkdir(repoPath, { recursive: true });
        try {
          await git(repoPath, ["init", "-b", "main"]);
        } catch {
          await git(repoPath, ["init"]);
          await git(repoPath, ["checkout", "-b", "main"]);
        }
        await writeFile(path.join(repoPath, "README.md"), "handoff\n", "utf8");
        await git(repoPath, ["add", "README.md"]);
        await git(repoPath, ["commit", "-m", "initial"]);
      }

      const parentDirectory = {
        id: expectedDir(parentRepoPath),
        kind: "local" as const,
        label: "parent-project",
        path: expectedDir(parentRepoPath),
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
        threads: [
          {
            id: "ordinary-thread",
            title: "Parent Thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [parentDirectory],
            updatedAt: 1000,
          },
        ],
      });
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "default",
            extraLinkedDirectories: [parentDirectory],
          },
        },
      });
      await overlayStore.upsertDirectoryLaunchpad({
        directoryKey: `directory:${expectedDir(targetRepoPath)}`,
        directoryKind: "directory",
        directoryLabel: "target-project",
        directoryPath: expectedDir(targetRepoPath),
        backend: "codex",
        executionMode: "default",
        prompt: "",
        workMode: "local",
        registeredAt: 1000,
        createdAt: 1000,
        updatedAt: 1000,
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        gitDirectoryService: new GitDirectoryService({
          resolveWorktreeStorage: () => "in-repo",
        }),
        overlayStore,
        threadTitleGenerationService: null,
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "ordinary-thread",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });

      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-1",
          requestId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: "Investigate issue XYZ from the requested project checkout.",
            title: "Explicit project local handoff",
            workspaceMode: "project_local",
            cwd: targetRepoPath,
          },
        },
      } as AppServerPendingRequestNotification);

      expect(response).toMatchObject({ success: true });
      const realParentRepoPath = expectedDir(await realpath(parentRepoPath));
      const realTargetRepoPath = expectedDir(await realpath(targetRepoPath));
      expect(codexClient.lastStartThreadParams?.cwd).toBe(realTargetRepoPath);
      expect(codexClient.lastStartThreadParams?.cwd).not.toBe(realParentRepoPath);
      const payload = JSON.parse(
        (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
      );
      expect(payload.workspace).toMatchObject({
        mode: "project_local",
        cwd: realTargetRepoPath,
        linkedDirectory: {
          kind: "local",
          label: "target-project",
          path: realTargetRepoPath,
        },
        git: {
          kind: "git_local",
          worktreeCreationAvailable: true,
        },
      });
      expect(payload.workspace.linkedDirectory.path).not.toBe(realParentRepoPath);

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { seedMode: "clean", branchName: "develop", branchMode: undefined, occupied: false },
    { seedMode: "clean", branchName: "develop", branchMode: "attached", occupied: false },
    { seedMode: "fork", branchName: "develop", branchMode: "attached", occupied: false },
    { seedMode: "clean", branchName: "main", branchMode: "attached", occupied: true },
    { seedMode: "fork", branchName: "main", branchMode: "attached", occupied: true },
    { seedMode: "clean", branchName: "main", branchMode: "detached", occupied: true },
    { seedMode: "clean", branchName: "feature/agent@ops", branchMode: "attached", occupied: false },
    { seedMode: "clean", branchName: "sibling", branchMode: "attached", occupied: true },
    { seedMode: "clean", branchName: "refs/heads/sibling", branchMode: "detached", occupied: true },
  ])("creates new-worktree handoffs from an explicit cwd in another project ($seedMode, $branchName, $branchMode)", async ({
    seedMode, branchName, branchMode, occupied,
  }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-explicit-cwd-"));
    const scratchPath = path.join(root, "scratch-workspace");
    const repoPath = path.join(root, "other-project");
    try {
      await mkdir(scratchPath, { recursive: true });
      await mkdir(repoPath, { recursive: true });
      try {
        await git(repoPath, ["init", "-b", "main"]);
      } catch {
        await git(repoPath, ["init"]);
        await git(repoPath, ["checkout", "-b", "main"]);
      }
      await writeFile(path.join(repoPath, "README.md"), "handoff\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);
      await git(repoPath, ["branch", "develop"]);
      await git(repoPath, ["branch", "feature/agent@ops"]);
      const siblingPath = path.join(root, "sibling checkout");
      await git(repoPath, ["worktree", "add", "-b", "sibling", siblingPath]);

      const scratchDirectory = {
        id: expectedDir(scratchPath),
        kind: "local" as const,
        label: "scratch-workspace",
        path: expectedDir(scratchPath),
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
        threads: [
          {
            id: "ordinary-thread",
            title: "Parent Thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [scratchDirectory],
            updatedAt: 1000,
          },
        ],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        gitDirectoryService: new GitDirectoryService({
          resolveWorktreeStorage: () => "in-repo",
        }),
        overlayStore: createOverlayStoreMock({
          overlays: {
            "codex:ordinary-thread": {
              backend: "codex",
              threadId: "ordinary-thread",
              executionMode: "full-access",
              codexEnvironmentRuntime: {
                environmentId: "parent-env",
                environmentName: "Parent Env",
                executionTarget: "local",
                cwd: scratchPath,
                setupStatus: "completed",
              },
              extraLinkedDirectories: [scratchDirectory],
            },
          },
        }),
        threadTitleGenerationService: null,
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "ordinary-thread",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });

      const before = await git(repoPath, ["worktree", "list", "--porcelain"]);
      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-1",
          requestId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: "Investigate the export failure in the other project.",
            title: "Other project export failure",
            workspaceMode: "new_worktree",
            cwd: repoPath,
            seedMode,
            branchName,
            ...(branchMode ? { worktreeBranchMode: branchMode } : {}),
          },
        },
      } as AppServerPendingRequestNotification);

      const payload = JSON.parse(
        (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
      );
      const shouldRefuse = occupied && branchMode === "attached";
      expect(response).toMatchObject({ success: !shouldRefuse });
      expect(await git(repoPath, ["branch", "--show-current"])).toBe("main");
      if (shouldRefuse) {
        expect(payload).toMatchObject({
          code: "branch_already_checked_out",
          message: expect.stringMatching(/already checked out.*worktreeBranchMode=detached.*operator/i),
          data: {
            branchName,
            worktreePath: expectedDir(await realpath(branchName === "main" ? repoPath : siblingPath)),
          },
        });
        expect(await git(repoPath, ["worktree", "list", "--porcelain"])).toBe(before);
        expect(codexClient.lastStartThreadParams).toBeUndefined();
        expect(codexClient.lastForkThreadParams).toBeUndefined();
        await registry.close();
        return;
      }
      const started = seedMode === "fork" ? codexClient.lastForkThreadParams : codexClient.lastStartThreadParams;
      const handoffCwd = expectedDir(started?.cwd ?? "");
      expect(handoffCwd).toContain(
        expectedDir(await realpath(path.join(repoPath, ".worktrees"))),
      );
      expect(handoffCwd).not.toContain(expectedDir(scratchPath));
      expect(codexClient.lastStartThreadParams?.codexEnvironmentRuntime).toBeUndefined();
      expect(await git(handoffCwd, ["branch", "--show-current"])).toBe(branchMode === "attached" ? branchName : "");
      expect(await git(handoffCwd, ["rev-parse", "HEAD"])).toBe(await git(repoPath, ["rev-parse", branchName]));
      expect(payload.workspace).toMatchObject({
        mode: "new_worktree",
        cwd: handoffCwd,
        branch: branchMode === "attached" ? branchName : "HEAD",
        linkedDirectory: {
          kind: "worktree",
          label: "other-project",
          path: expectedDir(await realpath(repoPath)),
          worktreePath: handoffCwd,
        },
        git: {
          kind: "git_worktree",
          worktreeCreationAvailable: true,
        },
      });
      expect(payload.inheritedSettings).not.toHaveProperty(
        "codexEnvironmentRuntime",
      );

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not switch a same-project child to a nested path mentioned in the task", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-task-cwd-"));
    const scratchPath = path.join(root, "scratch-workspace");
    const repoPath = path.join(root, "PwrAgnt");
    const nestedPackagePath = path.join(repoPath, "apps", "desktop");
    const worktreePath = path.join(scratchPath, ".worktrees", "handoff-task");
    try {
      await mkdir(nestedPackagePath, { recursive: true });
      await mkdir(worktreePath, { recursive: true });
      const canonicalScratchPath = await realpath(scratchPath);
      const canonicalWorktreePath = await realpath(worktreePath);
      const prepareLaunchpadWorkspace = vi.fn(async (_launchpad: {
        directoryPath?: string;
        workMode: "local" | "worktree";
      }) => ({
        cwd: canonicalWorktreePath,
        repositoryPath: canonicalScratchPath,
        workMode: "worktree" as const,
      }));

      const scratchDirectory = {
        id: expectedDir(scratchPath),
        kind: "local" as const,
        label: "scratch-workspace",
        path: expectedDir(scratchPath),
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
        threads: [
          {
            id: "ordinary-thread",
            title: "Messaging Parent",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [scratchDirectory],
            updatedAt: 1000,
          },
        ],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        gitDirectoryService: {
          inspectWorkspaceGit: vi.fn(async (cwd: string) => ({
            kind: "worktree" as const,
            branch: cwd === canonicalWorktreePath ? "HEAD" : "main",
            hasCommits: true,
            headHasCommit: true,
            worktreeCreationAvailable: true,
          })),
          prepareLaunchpadWorkspace,
          recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
          resolvePrimaryWorkspacePath: vi.fn(async (cwd?: string) => {
            if (
              cwd?.startsWith(worktreePath)
              || cwd?.startsWith(canonicalWorktreePath)
              || cwd?.startsWith(scratchPath)
              || cwd?.startsWith(canonicalScratchPath)
            ) {
              return canonicalScratchPath;
            }
            return cwd;
          }),
        } as never,
        overlayStore: createOverlayStoreMock({
          overlays: {
            "codex:ordinary-thread": {
              backend: "codex",
              threadId: "ordinary-thread",
              executionMode: "full-access",
              extraLinkedDirectories: [scratchDirectory],
            },
          },
        }),
        threadTitleGenerationService: null,
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "ordinary-thread",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });

      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-1",
          requestId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: [
              "Investigate the messaging bug.",
              "Target repository:",
              `- "${nestedPackagePath}"`,
            ].join("\n"),
            title: "Messaging handoff target repo",
            workspaceMode: "new_worktree",
          },
        },
      } as AppServerPendingRequestNotification);

      expect(response).toMatchObject({ success: true });
      expect(prepareLaunchpadWorkspace).toHaveBeenCalledOnce();
      expect(prepareLaunchpadWorkspace.mock.calls[0]?.[0]).toMatchObject({
        workMode: "worktree",
      });
      expect(
        expectedDir(
          prepareLaunchpadWorkspace.mock.calls[0]?.[0].directoryPath ?? "",
        ),
      ).toBe(expectedDir(scratchPath));
      const handoffCwd = expectedDir(codexClient.lastStartThreadParams?.cwd ?? "");
      expect(handoffCwd).toContain(
        expectedDir(await realpath(path.join(scratchPath, ".worktrees"))),
      );
      expect(handoffCwd).not.toContain(expectedDir(nestedPackagePath));
      const payload = JSON.parse(
        (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
      );
      expect(payload.workspace).toMatchObject({
        mode: "new_worktree",
        cwd: handoffCwd,
        linkedDirectory: {
          kind: "worktree",
          label: "scratch-workspace",
          path: expectedDir(await realpath(scratchPath)),
          worktreePath: handoffCwd,
        },
      });

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires confirmation before a default new-worktree handoff uses an explicit untrusted cwd", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-new-worktree-trust-"));
    const scratchPath = path.join(root, "scratch-workspace");
    const repoPath = path.join(root, "other-project");
    try {
      await mkdir(scratchPath, { recursive: true });
      await mkdir(repoPath, { recursive: true });
      try {
        await git(repoPath, ["init", "-b", "main"]);
      } catch {
        await git(repoPath, ["init"]);
        await git(repoPath, ["checkout", "-b", "main"]);
      }
      await writeFile(path.join(repoPath, "README.md"), "handoff\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);

      const scratchDirectory = {
        id: expectedDir(scratchPath),
        kind: "local" as const,
        label: "scratch-workspace",
        path: expectedDir(scratchPath),
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
        threads: [
          {
            id: "ordinary-thread",
            title: "Parent Thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [scratchDirectory],
            updatedAt: 1000,
          },
        ],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        gitDirectoryService: new GitDirectoryService({
          resolveWorktreeStorage: () => "in-repo",
        }),
        overlayStore: createOverlayStoreMock({
          overlays: {
            "codex:ordinary-thread": {
              backend: "codex",
              threadId: "ordinary-thread",
              executionMode: "default",
              extraLinkedDirectories: [scratchDirectory],
            },
          },
        }),
        threadTitleGenerationService: null,
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "ordinary-thread",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });

      const events: AgentEvent[] = [];
      const unsubscribe = registry.onEvent((event) => {
        events.push(event);
      });
      const responsePromise = codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-1",
          requestId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: "Investigate the export failure in the other project.",
            title: "Other project export failure",
            cwd: repoPath,
          },
        },
      } as AppServerPendingRequestNotification);

      await vi.waitFor(() => {
        expect(
          events.find(
            (event) =>
              event.notification.method === "item/tool/requestUserInput" &&
              event.notification.params.threadId === "ordinary-thread",
          ),
        ).toBeDefined();
      });
      const inputRequest = events.find(
        (event): event is AgentEvent & {
          notification: Extract<
            AppServerNotification,
            { method: "item/tool/requestUserInput" }
          >;
        } =>
          event.notification.method === "item/tool/requestUserInput" &&
          event.notification.params.threadId === "ordinary-thread",
      )!.notification;
      expect(inputRequest.params.questions).toEqual([
        expect.objectContaining({
          id: "trust_directory",
          question: expect.stringContaining(expectedDir(repoPath)),
        }),
      ]);
      await registry.submitServerRequest({
        backend: "codex",
        threadId: "ordinary-thread",
        turnId: "turn-1",
        requestId: inputRequest.params.requestId,
        response: {
          answers: {
            trust_directory: {
              answers: ["Cancel handoff"],
            },
          },
        },
      });
      const response = await responsePromise;

      expect(response).toMatchObject({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: expect.stringContaining("forbidden"),
          },
        ],
      });
      expect(codexClient.lastStartThreadParams).toBeUndefined();
      expect(codexClient.lastStartTurnParams).toBeUndefined();
      unsubscribe();
      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not inherit a parent Codex environment runtime for forked cross-project handoffs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-fork-cwd-"));
    const parentPath = path.join(root, "parent-project");
    const repoPath = path.join(root, "other-project");
    const worktreePath = path.join(repoPath, ".worktrees", "forked-child");
    try {
      await mkdir(parentPath, { recursive: true });
      await mkdir(worktreePath, { recursive: true });
      const canonicalParentPath = await realpath(parentPath);
      const canonicalRepoPath = await realpath(repoPath);
      const canonicalWorktreePath = await realpath(worktreePath);
      const prepareLaunchpadWorkspace = vi.fn(async (_launchpad: {
        directoryPath?: string;
        workMode: "local" | "worktree";
      }) => ({
        cwd: canonicalWorktreePath,
        repositoryPath: canonicalRepoPath,
        workMode: "worktree" as const,
      }));

      const parentRuntime: CodexThreadEnvironmentRuntime = {
        environmentId: "parent-env",
        environmentName: "Parent Env",
        executionTarget: "local",
        cwd: parentPath,
        setupStatus: "completed",
      };
      const parentDirectory = {
        id: expectedDir(parentPath),
        kind: "local" as const,
        label: "parent-project",
        path: expectedDir(parentPath),
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/fork", "thread/list", "turn/start"] },
        threads: [
          {
            id: "ordinary-thread",
            title: "Parent Thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [parentDirectory],
            updatedAt: 1000,
          },
        ],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        gitDirectoryService: {
          inspectWorkspaceGit: vi.fn(async (cwd: string) => ({
            kind: "worktree" as const,
            branch: cwd === canonicalWorktreePath ? "HEAD" : "main",
            hasCommits: true,
            headHasCommit: true,
            worktreeCreationAvailable: true,
          })),
          prepareLaunchpadWorkspace,
          recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
          resolvePrimaryWorkspacePath: vi.fn(async (cwd?: string) => {
            if (
              cwd?.startsWith(worktreePath)
              || cwd?.startsWith(canonicalWorktreePath)
              || cwd?.startsWith(repoPath)
              || cwd?.startsWith(canonicalRepoPath)
            ) {
              return canonicalRepoPath;
            }
            if (
              cwd?.startsWith(parentPath)
              || cwd?.startsWith(canonicalParentPath)
            ) {
              return canonicalParentPath;
            }
            return cwd;
          }),
        } as never,
        overlayStore: createOverlayStoreMock({
          overlays: {
            "codex:ordinary-thread": {
              backend: "codex",
              threadId: "ordinary-thread",
              executionMode: "full-access",
              codexEnvironmentRuntime: parentRuntime,
              extraLinkedDirectories: [parentDirectory],
            },
          },
        }),
        threadTitleGenerationService: null,
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "ordinary-thread",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });

      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-1",
          requestId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: "Fork a child for the other project.",
            title: "Other project fork",
            seedMode: "fork",
            workspaceMode: "new_worktree",
            cwd: repoPath,
          },
        },
      } as AppServerPendingRequestNotification);

      expect(response).toMatchObject({ success: true });
      expect(prepareLaunchpadWorkspace).toHaveBeenCalledOnce();
      expect(prepareLaunchpadWorkspace.mock.calls[0]?.[0]).toMatchObject({
        workMode: "worktree",
      });
      expect(
        expectedDir(
          prepareLaunchpadWorkspace.mock.calls[0]?.[0].directoryPath ?? "",
        ),
      ).toBe(expectedDir(repoPath));
      expect(expectedDir(codexClient.lastForkThreadParams?.cwd ?? "")).toBe(
        expectedDir(canonicalWorktreePath),
      );
      expect(codexClient.lastForkThreadParams?.codexEnvironmentRuntime).toBeUndefined();
      const payload = JSON.parse(
        (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
      );
      expect(payload.inheritedSettings).not.toHaveProperty(
        "codexEnvironmentRuntime",
      );

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires confirmation before an explicit worktree repo cwd expands Default Access write scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-cwd-confirm-"));
    const repoPath = path.join(root, "other-project");
    const worktreePath = path.join(root, "other-project-worktree");
    try {
      await mkdir(repoPath, { recursive: true });
      try {
        await git(repoPath, ["init", "-b", "main"]);
      } catch {
        await git(repoPath, ["init"]);
        await git(repoPath, ["checkout", "-b", "main"]);
      }
      await writeFile(path.join(repoPath, "README.md"), "handoff\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);
      await git(repoPath, ["worktree", "add", "--detach", worktreePath, "main"]);

      const linkedDirectory = {
        id: expectedDir(repoPath),
        kind: "worktree" as const,
        label: "other-project",
        path: expectedDir(repoPath),
        worktreePath: expectedDir(worktreePath),
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
        threads: [
          {
            id: "ordinary-thread",
            title: "Parent Thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [linkedDirectory],
            updatedAt: 1000,
          },
        ],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        gitDirectoryService: new GitDirectoryService({
          resolveWorktreeStorage: () => "in-repo",
        }),
        overlayStore: createOverlayStoreMock({
          overlays: {
            "codex:ordinary-thread": {
              backend: "codex",
              threadId: "ordinary-thread",
              executionMode: "default",
              extraLinkedDirectories: [linkedDirectory],
            },
          },
        }),
        threadTitleGenerationService: null,
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "ordinary-thread",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });

      const events: AgentEvent[] = [];
      const unsubscribe = registry.onEvent((event) => {
        events.push(event);
      });
      const responsePromise = codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-1",
          requestId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: "Investigate the export failure in the other project.",
            title: "Other project export failure",
            workspaceMode: "project_local",
            cwd: repoPath,
          },
        },
      } as AppServerPendingRequestNotification);

      await vi.waitFor(() => {
        expect(
          events.find(
            (event) =>
              event.notification.method === "item/tool/requestUserInput" &&
              event.notification.params.threadId === "ordinary-thread",
          ),
        ).toBeDefined();
      });
      const inputRequest = events.find(
        (event): event is AgentEvent & {
          notification: Extract<
            AppServerNotification,
            { method: "item/tool/requestUserInput" }
          >;
        } =>
          event.notification.method === "item/tool/requestUserInput" &&
          event.notification.params.threadId === "ordinary-thread",
      )!.notification;
      expect(inputRequest.params.questions).toEqual([
        expect.objectContaining({
          id: "trust_directory",
          question: expect.stringContaining(expectedDir(repoPath)),
        }),
      ]);
      await registry.submitServerRequest({
        backend: "codex",
        threadId: "ordinary-thread",
        turnId: "turn-1",
        requestId: inputRequest.params.requestId,
        response: {
          answers: {
            trust_directory: {
              answers: ["Cancel handoff"],
            },
          },
        },
      });
      const response = await responsePromise;

      expect(response).toMatchObject({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: expect.stringContaining("forbidden"),
          },
        ],
      });
      const payload = JSON.parse(
        (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
      );
      expect(payload).toMatchObject({
        code: "forbidden",
        data: {
          cwd: expectedDir(repoPath),
        },
      });
      expect(codexClient.lastStartThreadParams).toBeUndefined();
      expect(codexClient.lastStartTurnParams).toBeUndefined();
      unsubscribe();

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a confirmed Default Access handoff cwd as a trusted directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-cwd-trust-"));
    const parentPath = path.join(root, "parent-project");
    const repoPath = path.join(root, "trusted-project");
    try {
      for (const repo of [parentPath, repoPath]) {
        await mkdir(repo, { recursive: true });
        try {
          await git(repo, ["init", "-b", "main"]);
        } catch {
          await git(repo, ["init"]);
          await git(repo, ["checkout", "-b", "main"]);
        }
        await writeFile(path.join(repo, "README.md"), "handoff\n", "utf8");
        await git(repo, ["add", "README.md"]);
        await git(repo, ["commit", "-m", "initial"]);
      }

      const parentDirectory = {
        id: expectedDir(parentPath),
        kind: "local" as const,
        label: "parent-project",
        path: expectedDir(parentPath),
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
        threads: [
          {
            id: "ordinary-thread",
            title: "Parent Thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [parentDirectory],
            updatedAt: 1000,
          },
        ],
      });
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "default",
            extraLinkedDirectories: [parentDirectory],
          },
        },
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        gitDirectoryService: new GitDirectoryService({
          resolveWorktreeStorage: () => "in-repo",
        }),
        overlayStore,
        threadTitleGenerationService: null,
      });
      const events: AgentEvent[] = [];
      const unsubscribe = registry.onEvent((event) => {
        events.push(event);
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "ordinary-thread",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });

      const responsePromise = codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-1",
          requestId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: "Investigate the trusted project.",
            title: "Trusted project handoff",
            workspaceMode: "project_local",
            cwd: repoPath,
          },
        },
      } as AppServerPendingRequestNotification);

      await vi.waitFor(() => {
        expect(
          events.find(
            (event) => event.notification.method === "item/tool/requestUserInput",
          ),
        ).toBeDefined();
      });
      const inputRequest = events.find(
        (event): event is AgentEvent & {
          notification: Extract<
            AppServerNotification,
            { method: "item/tool/requestUserInput" }
          >;
        } => event.notification.method === "item/tool/requestUserInput",
      )!.notification;
      await registry.submitServerRequest({
        backend: "codex",
        threadId: "ordinary-thread",
        turnId: "turn-1",
        requestId: inputRequest.params.requestId,
        response: {
          answers: {
            trust_directory: {
              answers: ["Trust directory (Recommended)"],
            },
          },
        },
      });

      const response = await responsePromise;

      expect(response).toMatchObject({ success: true });
      const realRepoPath = expectedDir(await realpath(repoPath));
      expect(codexClient.lastStartThreadParams?.cwd).toBe(realRepoPath);
      await expect(
        overlayStore.getDirectoryLaunchpad({
          directoryKey: `directory:${realRepoPath}`,
        }),
      ).resolves.toMatchObject({
        directoryKind: "directory",
        directoryLabel: "trusted-project",
        directoryPath: realRepoPath,
      });
      unsubscribe();
      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not inherit a project Codex environment runtime for no-workspace handoffs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-none-env-"));
    const repoPath = path.join(root, "catalog-review");
    const ignoredCwd = path.join(root, "other-project");
    const scratchPath = path.join(root, "profiles", "work", "projects", "2026-06-30-c2acd2");
    try {
      await mkdir(repoPath, { recursive: true });
      await mkdir(ignoredCwd, { recursive: true });
      await mkdir(scratchPath, { recursive: true });
      try {
        await git(repoPath, ["init", "-b", "main"]);
      } catch {
        await git(repoPath, ["init"]);
        await git(repoPath, ["checkout", "-b", "main"]);
      }
      await writeFile(path.join(repoPath, "README.md"), "handoff\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);

      const sourceRuntime: CodexThreadEnvironmentRuntime = {
        environmentId: "environment",
        environmentName: "catalog-review",
        executionTarget: "local",
        cwd: repoPath,
        setupStatus: "completed",
        setupCommand: "pnpm install",
      };
      const linkedDirectory = {
        id: expectedDir(repoPath),
        kind: "local" as const,
        label: "catalog-review",
        path: expectedDir(repoPath),
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
        threads: [
          {
            id: "ordinary-thread",
            title: "Parent Thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [linkedDirectory],
            updatedAt: 1000,
          },
        ],
      });
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "full-access",
            codexEnvironmentRuntime: sourceRuntime,
            extraLinkedDirectories: [linkedDirectory],
          },
        },
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        createScratchProjectDirectory: async () => scratchPath,
        overlayStore,
        threadTitleGenerationService: null,
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "ordinary-thread",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });

      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-1",
          requestId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: "Use /Users/example/Projects/catalog-service from the prompt only.",
            title: "Prompt-only target",
            groupingMode: "subthread",
            workspaceMode: "none",
            cwd: ignoredCwd,
          },
        },
      } as AppServerPendingRequestNotification);

      expect(response).toMatchObject({ success: true });
      expect(codexClient.lastStartThreadParams).toMatchObject({
        cwd: scratchPath,
      });
      expect(codexClient.lastStartThreadParams?.codexEnvironmentRuntime).toBeUndefined();
      const payload = JSON.parse(
        (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
      );
      expect(payload.workspace).toMatchObject({
        mode: "none",
        cwd: expectedDir(scratchPath),
        git: {
          kind: "non_git",
          worktreeCreationAvailable: false,
        },
      });
      expect(payload).toMatchObject({
        groupingMode: "subthread",
        groupedUnderThreadId: "ordinary-thread",
      });
      await expect(
        overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }),
      ).resolves.toMatchObject({
        parentThreadId: "ordinary-thread",
      });
      expect(payload.inheritedSettings).not.toHaveProperty(
        "codexEnvironmentRuntime",
      );

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects new-worktree handoffs when workspace preparation falls back to the source cwd", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-fallback-"));
    try {
      await git(root, ["init", "-b", "main"]);
    } catch {
      await git(root, ["init"]);
      await git(root, ["checkout", "-b", "main"]);
    }
    await writeFile(path.join(root, "README.md"), "handoff\n", "utf8");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "initial"]);

    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
      threads: [
        {
          id: "ordinary-thread",
          title: "Parent Thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [
            {
              id: expectedDir(root),
              kind: "local",
              label: "handoff",
              path: expectedDir(root),
            },
          ],
          updatedAt: 1000,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      gitDirectoryService: new GitDirectoryService({
        resolveWorktreeStorage: () => "in-repo",
      }),
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "full-access",
            extraLinkedDirectories: [
              {
                id: expectedDir(root),
                kind: "local",
                label: "handoff",
                path: expectedDir(root),
              },
            ],
          },
        },
      }),
      threadTitleGenerationService: null,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          task: "Investigate issue XYZ and report back.",
          title: "Investigate issue XYZ",
          workspaceMode: "new_worktree",
          branchName: "codex/agent-intended-child-branch",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: false });
    const failurePayload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(failurePayload).toMatchObject({
      code: "unsupported_workspace",
      message: expect.stringMatching(
        /cwd was omitted[\s\S]*retry with cwd set to that project path[\s\S]*Omit branchName[\s\S]*Do not switch to a shared checkout or ask the child to create a worktree/,
      ),
    });
    expect(codexClient.lastStartThreadParams).toBeUndefined();
    expect(codexClient.lastStartTurnParams).toBeUndefined();

    await registry.close();
    await rm(root, { recursive: true, force: true });
  });

  it("marks required-worktree handoffs failed when Git inspection fails", async () => {
    const sourceDirectory = {
      id: "directory:/repo/app",
      kind: "local" as const,
      label: "app",
      path: "/repo/app",
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
      threads: [
        {
          id: "ordinary-thread",
          title: "Parent Thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [sourceDirectory],
          updatedAt: 1000,
        },
      ],
    });
    const inspectError = new Error("fatal: bad object refs/heads/main");
    const registry = createDesktopBackendRegistry({
      codexClient,
      gitDirectoryService: {
        inspectWorkspaceGit: vi.fn(async () => {
          throw inspectError;
        }),
      } as never,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "full-access",
            extraLinkedDirectories: [sourceDirectory],
          },
        },
      }),
      threadTitleGenerationService: null,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "handoff-call-1",
        requestId: "handoff-call-1",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          task: "Repair the malformed repository.",
          title: "Malformed repository repair",
          workspaceMode: "new_worktree",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: expect.stringContaining("Git workspace inspection failed"),
        },
      ],
    });
    expect(codexClient.lastStartThreadParams).toBeUndefined();

    const searchResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "search-call-1",
        requestId: "search-call-1",
        namespace: "pwragent",
        tool: "search_threads",
        arguments: { query: "Malformed repository repair" },
      },
    } as AppServerPendingRequestNotification);
    const searchPayload = JSON.parse(
      (searchResponse as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(searchPayload.pendingHandoffs).toEqual([
      expect.objectContaining({
        status: "failed",
        phase: "failed",
        error: expect.stringContaining("Git workspace inspection failed"),
      }),
    ]);

    await registry.close();
  });

  it("continues a no-workspace handoff when Git inspection is unavailable", async () => {
    const sourceDirectory = {
      id: "directory:/repo/app",
      kind: "local" as const,
      label: "app",
      path: "/repo/app",
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
      threads: [
        {
          id: "ordinary-thread",
          title: "Parent Thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [sourceDirectory],
          updatedAt: 1000,
        },
      ],
    });
    const inspectWorkspaceGit = vi.fn(async () => {
      throw new Error("EACCES: cannot inspect child workspace");
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      createScratchProjectDirectory: async () => "/repo/scratch",
      gitDirectoryService: {
        inspectWorkspaceGit,
      } as never,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "full-access",
            extraLinkedDirectories: [sourceDirectory],
          },
        },
      }),
      threadTitleGenerationService: null,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "ordinary-thread",
        turnId: "turn-1",
        callId: "handoff-call-1",
        requestId: "handoff-call-1",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          task: "Continue even if Git metadata cannot be read.",
          title: "Unavailable child metadata",
          workspaceMode: "none",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.workspace).toMatchObject({
      mode: "none",
      cwd: expectedDir("/repo/scratch"),
    });
    expect(payload.workspace.git).toEqual({
      kind: "unavailable",
      worktreeCreationAvailable: false,
      unavailableReason:
        "Git workspace inspection failed: EACCES: cannot inspect child workspace",
    });
    expect(inspectWorkspaceGit).toHaveBeenCalledTimes(2);
    expect(codexClient.lastStartTurnParams?.threadId).toBe("thread-1");
    expect(codexClient.lastStartTurnParams?.parentTurnId).toBe("turn-1");
    expect(codexClient.lastStartTurnParams?.rootTurnId).toBeUndefined();
    const prompt =
      (codexClient.lastStartTurnParams?.input[0] as { text?: string } | undefined)
        ?.text ?? "";
    expect(prompt).not.toContain("- Git:");
    expect(prompt).not.toContain("EACCES: cannot inspect child workspace");

    await registry.close();
  });

  it("refuses a Claude workspace move before touching any files", async () => {
    const handoff = vi.fn();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      gitWorkspaceHandoffService: { handoff } as never,
    });
    const internals = registry as unknown as { claudeBackend: { assertWorkspaceMovable: (threadId: string) => void } };
    vi.spyOn(internals.claudeBackend, "assertWorkspaceMovable").mockImplementation(() => {
      throw new Error("Stop Claude's background tasks before moving this thread.");
    });

    await expect(registry.handoffThreadWorkspace({
      backend: "claude", threadId: "claude-1", direction: "local-to-worktree",
      repositoryPath: "/repo/app", sourcePath: "/repo/app",
    })).rejects.toThrow("Stop Claude's background tasks");
    expect(handoff).not.toHaveBeenCalled();
    await registry.close();
  });

  it("keeps an owned worktree after a fresh-start move and checkpoints it on archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-fresh-start-archive-"));
    let registry: DesktopBackendRegistry | undefined;
    try {
      const repoPath = path.join(root, "PwrGit");
      await mkdir(repoPath);
      await git(repoPath, ["init", "-b", "main"]);
      await writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);
      const handoffService = new GitWorkspaceHandoffService({ resolveWorktreeStorage: () => "in-repo" });
      // An earlier move created this worktree, so the thread owns it.
      const created = await handoffService.handoff({
        backend: "codex", threadId: "thread-1", direction: "to-project", targetPath: repoPath,
        sourceWorkMode: "worktree", now: 1000,
      });
      const oldWorktree = created.targetPath;
      await writeFile(path.join(oldWorktree, "README.md"), "uncommitted\n", "utf8");
      const overlayStore = createOverlayStoreMock();
      await overlayStore.replaceWorkspaceLinkedDirectory({
        backend: "codex", threadId: "thread-1", directory: created.linkedDirectory,
      });
      // The provider reports no directory: only PwrAgent's records find the old worktree.
      const thread: AppServerThreadSummary = {
        id: "thread-1", title: "Fresh start", titleSource: "explicit", source: "codex",
        linkedDirectories: [], gitBranch: "HEAD", updatedAt: 2,
      };
      registry = createDesktopBackendRegistry({
        codexClient: new MockBackendClient({ threads: [thread] }), overlayStore, gitWorkspaceHandoffService: handoffService,
      });

      const moved = await registry.handoffThreadWorkspace({
        backend: "codex", threadId: thread.id, direction: "worktree-to-worktree", baseRef: "main",
        repositoryPath: repoPath, sourcePath: oldWorktree,
      });

      expect(moved.targetPath).not.toBe(oldWorktree);
      expect(moved.warnings).toContain("The previous worktree stays on disk. Archiving this thread checkpoints and removes it.");
      // Nothing was moved or discarded from the old worktree.
      await expect(readFile(path.join(oldWorktree, "README.md"), "utf8")).resolves.toBe("uncommitted\n");
      // Git for Windows checks the committed file out with CRLF.
      await expect(readFile(path.join(moved.targetPath, "README.md"), "utf8")).resolves.toMatch(/^base\r?\n$/);
      const overlay = await overlayStore.getThreadOverlayState({ backend: "codex", threadId: thread.id });
      // The new worktree is the thread's only workspace; the old one is kept aside.
      expect(overlay?.extraLinkedDirectories).toEqual([moved.linkedDirectory]);
      expect(overlay?.retainedWorktrees).toEqual([
        expect.objectContaining({ kind: "worktree", path: moved.repositoryPath, worktreePath: oldWorktree }),
      ]);

      const archived = await registry.archiveThread({ backend: "codex", threadId: thread.id });

      // The provider reports no directory, so the retained worktree is the
      // only candidate. Paths are not compared: Windows can spell them differently.
      expect(archived.cleanup).toEqual([expect.objectContaining({ removedWorktree: true })]);
      expect(await pathExists(oldWorktree)).toBe(false);
      expect(await git(repoPath, ["worktree", "list", "--porcelain"])).not.toContain(oldWorktree);
      // The old worktree's uncommitted change survives in its checkpoint.
      const snapshots = (await overlayStore.getThreadOverlayState({ backend: "codex", threadId: thread.id }))
        ?.worktreeSnapshots ?? [];
      expect(snapshots).toHaveLength(1);
      expect(await git(repoPath, ["show", `${snapshots[0]!.snapshotCommit}:README.md`])).toBe("uncommitted");
    } finally {
      await registry?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { source: "an owned worktree", direction: "worktree-to-worktree", external: false, retained: true },
    { source: "an adopted worktree", direction: "worktree-to-worktree", external: true, retained: false },
    { source: "the local checkout", direction: "local-to-worktree", external: false, retained: false },
  ] as const)("tracks $source after a fresh-start move only when the thread owns it", async ({ direction, external, retained }) => {
    const sourcePath = direction === "local-to-worktree" ? "/repo/app" : "/repo/app/.worktrees/old";
    const targetPath = "/repo/app/.worktrees/new";
    const source: LinkedDirectorySummary = direction === "local-to-worktree"
      ? { id: "/repo/app", label: "app", path: "/repo/app", kind: "local" }
      : {
          id: "pwragent-handoff:codex:thread-1", label: "app", path: "/repo/app", kind: "worktree", worktreePath: sourcePath,
          ...(external ? { worktreeOwnership: "external" as const } : {}),
        };
    const handoff = vi.fn(async () => ({
      backend: "codex" as const, threadId: "thread-1", direction, strategy: "detached-changes" as const,
      workMode: "worktree" as const, baseSha: "abc123", repositoryPath: "/repo/app", targetPath,
      linkedDirectory: { id: "pwragent-handoff:codex:thread-1", label: "app", path: "/repo/app", kind: "worktree" as const, worktreePath: targetPath },
      warnings: [], completedAt: 1000,
    }));
    const overlayStore = createOverlayStoreMock({ overlays: { "codex:thread-1": {
      backend: "codex", threadId: "thread-1", executionMode: "default", extraLinkedDirectories: [source],
    } } });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [{
        id: "thread-1", title: "Fresh start", titleSource: "explicit", source: "codex", linkedDirectories: [source], updatedAt: 1,
      }] }),
      overlayStore,
      gitDirectoryService: { recordCodexWorktreeOwnerThread: vi.fn(async () => {}) } as never,
      gitWorkspaceHandoffService: { handoff } as never,
    });
    try {
      await registry.handoffThreadWorkspace({
        backend: "codex", threadId: "thread-1", direction, baseRef: "origin/main", repositoryPath: "/repo/app", sourcePath,
      });

      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ baseRef: "origin/main", sourcePath }));
      expect((handoff.mock.calls[0] as unknown as [{ keepSourceWorktree?: boolean }])[0].keepSourceWorktree)
        .toBe(external ? true : undefined);
      const overlay = await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" });
      expect(overlay?.retainedWorktrees).toEqual(retained ? [{
        id: `pwragent-retained-worktree:codex:thread-1:${sourcePath}`,
        label: "app", path: "/repo/app", kind: "worktree", worktreePath: sourcePath,
      }] : undefined);
    } finally {
      await registry.close();
    }
  });

  it.each(["directory", "pr", "relinked-pr", "overlay"])("passes existing worktrees and source isolation to a project move: %s", async (provenance) => {
    const directories: LinkedDirectorySummary[] = [{
      id: "source", label: "Workspaces", path: "/repo/Workspaces", kind: "worktree", worktreePath: "/worktrees/Workspaces",
    }, {
      id: "target", label: "PwrGit", path: "/repo/PwrGit", kind: "worktree", worktreePath: "/worktrees/PwrGit",
    }];
    const thread: AppServerThreadSummary = {
      id: "thread-1", title: "Move", titleSource: "explicit", source: "codex",
      projectKey: provenance === "relinked-pr" ? "/repo/PwrGit" : "/worktrees/Workspaces",
      linkedDirectories: provenance === "directory" ? directories : provenance === "relinked-pr" ? [] : directories.slice(0, 1), updatedAt: 2,
    };
    const handoff = vi.fn(async () => ({
      backend: "codex" as const, threadId: thread.id, direction: "to-project" as const,
      workMode: "worktree" as const, branch: "HEAD", repositoryPath: "/repo/PwrGit", targetPath: "/worktrees/new-PwrGit",
      linkedDirectory: { id: "pwragent-handoff:codex:thread-1", label: "PwrGit", path: "/repo/PwrGit", kind: "worktree" as const, worktreePath: "/worktrees/new-PwrGit" },
      warnings: [], completedAt: 1000,
    }));
    const recordCodexWorktreeOwnerThread = vi.fn();
    const overlayDirectories = [
      { ...directories[0]!, id: "pwragent-handoff:codex:thread-1" },
      directories[1]!,
    ];
    const overlayStore = createOverlayStoreMock(provenance === "overlay" ? {
      overlays: { "codex:thread-1": {
        backend: "codex", threadId: thread.id, executionMode: "default", extraLinkedDirectories: overlayDirectories,
      } },
    } : undefined);
    if (provenance === "pr" || provenance === "relinked-pr") await overlayStore.addThreadPullRequestReference({
      backend: "codex", threadId: thread.id,
      pr: { provider: "github.com", org: "example", repo: "PwrGit", number: 461, state: "passing", url: "https://github.com/example/PwrGit/pull/461", linkedDirectoryPaths: ["/worktrees/PwrGit"] },
    });
    await overlayStore.setThreadParent({ backend: "codex", threadId: thread.id, parentThreadId: "parent", parentThreadBackend: "acp:grok", parentThreadInstanceId: "remote-instance" });
    const replaceWorkspace = vi.spyOn(overlayStore, "replaceWorkspaceLinkedDirectory");
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [thread] }), overlayStore,
      gitDirectoryService: { recordCodexWorktreeOwnerThread } as never,
      gitWorkspaceHandoffService: { handoff } as never,
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => { events.push(event); });
    try {
      await registry.handoffThreadWorkspace({ backend: "codex", threadId: thread.id, direction: "to-project", targetPath: "/repo/PwrGit" });
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        sourceWorkMode: provenance === "relinked-pr" ? "local" : "worktree",
        workspacePaths: expect.arrayContaining(provenance === "relinked-pr" ? ["/worktrees/PwrGit"] : ["/worktrees/Workspaces", "/worktrees/PwrGit"]),
      }));
      if (provenance === "overlay") expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        workspaceDirectories: expect.arrayContaining(overlayDirectories),
      }));
      expect(replaceWorkspace).toHaveBeenCalledWith(expect.objectContaining({ resetProjectState: true }));
      expect(events).toContainEqual(expect.objectContaining({
        backend: "codex", notification: { method: "thread/parent/cleared", params: { threadId: thread.id } },
      }));
      expect(recordCodexWorktreeOwnerThread).toHaveBeenCalledWith({ threadId: thread.id, worktreePath: "/worktrees/new-PwrGit" });
    } finally {
      unsubscribe();
      await registry.close();
    }
  });

  it.each(["local", "worktree"] as const)("moves a scratch Codex conversation to another project and starts its next turn there: %s", async (workMode) => {
    const targetPath = workMode === "local" ? "/projects/demo" : "/worktrees/demo";
    const thread: AppServerThreadSummary = {
      id: "thread-1", title: "Research", titleSource: "explicit", source: "codex",
      projectKey: "/scratch/research", linkedDirectories: [], updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock();
    const codexClient = new MockBackendClient({ threads: [thread] });
    const handoff = vi.fn(async () => ({
      backend: "codex" as const, threadId: thread.id, direction: "to-project" as const,
      workMode, branch: "main", repositoryPath: "/projects/demo",
      targetPath,
      linkedDirectory: {
        id: "pwragent-handoff:codex:thread-1", label: "demo", path: "/projects/demo", kind: workMode,
        ...(workMode === "worktree" ? { worktreePath: targetPath, worktreeOwnership: "external" as const } : {}),
      },
      warnings: [], completedAt: 1000,
    }));
    const recordCodexWorktreeOwnerThread = vi.fn();
    const registry = createDesktopBackendRegistry({
      gitDirectoryService: { recordCodexWorktreeOwnerThread } as never,
      codexClient, overlayStore, gitWorkspaceHandoffService: { handoff } as never,
    });
    try {
      await registry.handoffThreadWorkspace({
        backend: "codex", threadId: thread.id, direction: "to-project", targetPath,
      });
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        direction: "to-project", targetPath,
      }));
      expect(codexClient.lastUpdateThreadWorkspaceParams).toEqual({
        threadId: thread.id, cwd: targetPath,
      });
      expect(recordCodexWorktreeOwnerThread).not.toHaveBeenCalled();
      await registry.startTurn({
        backend: "codex", threadId: thread.id, input: [{ type: "text", text: "Continue" }],
      });
      expect(codexClient.lastStartTurnParams).toMatchObject({
        threadId: thread.id, cwd: targetPath,
      });
    } finally {
      await registry.close();
    }
  });

  it("hands off a local thread to a worktree and records the new workspace overlay", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Move me",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "feature/handoff",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock();
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      direction: "local-to-worktree" as const,
      workMode: "worktree" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:codex:thread-1",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
        kind: "worktree" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [thread],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      gitDirectoryService: {
        recordCodexWorktreeOwnerThread,
      } as never,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    const publish = vi.spyOn(registry, "publishLocalEvent");

    const response = await registry.handoffThreadWorkspace({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      leaveLocalBranch: "main",
    });

    expect(handoff).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      leaveLocalBranch: "main",
      repositoryPath: "/repo/app",
      sourcePath: "/repo/app",
      sourceBranch: undefined,
    });
    expect(publish).toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "navigation/threadDirectories/updated",
        params: { reason: "selected-thread", threadIds: ["thread-1"] },
      },
    });
    expect(response.workMode).toBe("worktree");
    expect(recordCodexWorktreeOwnerThread).toHaveBeenCalledWith({
      worktreePath: "/repo/app/.worktrees/app-feature-handoff",
      threadId: "thread-1",
    });
    expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
      threadId: "thread-1",
      gitInfo: {
        branch: "feature/handoff",
      },
    });
    expect(codexClient.lastUpdateThreadWorkspaceParams).toEqual({
      threadId: "thread-1",
      cwd: "/repo/app/.worktrees/app-feature-handoff",
    });
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      gitBranch: "feature/handoff",
      observedGitBranch: "feature/handoff",
      extraLinkedDirectories: [
        expect.objectContaining({
          id: "pwragent-handoff:codex:thread-1",
          kind: "worktree",
        }),
      ],
    });

    await registry.close();
  });

  it.each([
    "Codex connection dropped",
    "json-rpc error (-32600): thread not found: thread-1",
  ])("finishes committed handoff bookkeeping when CWD synchronization fails: %s", async (error) => {
    const worktreePath = "/repo/app/.worktrees/app-feature-handoff";
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Move me back",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "pwragent-handoff:codex:thread-1",
          label: "app",
          path: "/repo/app",
          worktreePath,
          kind: "worktree",
        },
      ],
      source: "codex",
      gitBranch: "feature/handoff",
      updatedAt: 2,
    };
    const archivedSourceWorktree: WorktreeSnapshotSummary = {
      id: "snapshot-handoff",
      backend: "codex",
      threadId: "thread-1",
      worktreePath,
      repositoryPath: "/repo/app",
      snapshotRef: "refs/pwragent/snapshots/snapshot-handoff",
      snapshotCommit: "abc123",
      sourceBranch: "feature/handoff",
      sourceHead: "abc123",
      createdAt: 1_000,
      archivedAt: 1_000,
      state: "archived",
      ignoredFilesExcluded: true,
    };
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      direction: "worktree-to-local" as const,
      strategy: "move-branch" as const,
      workMode: "local" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app",
      linkedDirectory: {
        id: "pwragent-handoff:codex:thread-1",
        label: "app",
        path: "/repo/app",
        kind: "local" as const,
      },
      archivedSourceWorktree,
      warnings: [],
      completedAt: 1_000,
    }));
    const codexClient = new MockBackendClient({
      threads: [thread],
      updateThreadWorkspaceError: new Error(error),
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      gitWorkspaceHandoffService: { handoff } as never,
    });

    const response = await registry.handoffThreadWorkspace({
      backend: "codex",
      threadId: "thread-1",
      direction: "worktree-to-local",
    });

    expect(response.warnings).toContain(
      "Codex workspace CWD synchronization is pending and will retry automatically.",
    );
    expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
      threadId: "thread-1",
      gitInfo: { branch: "feature/handoff" },
    });
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [
        expect.objectContaining({
          id: "pwragent-handoff:codex:thread-1",
          kind: "local",
          path: "/repo/app",
        }),
      ],
      worktreeSnapshots: [archivedSourceWorktree],
    });

    await registry.close();
  });

  it("rebinds ACP protocol sessions when the thread workspace overlay changes cwd", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessionStore = createAcpSessionStoreMock([
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "ACP session",
        cwd: "/repo/app",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      },
    ]);
    const overlayStore = createOverlayStoreMock();
    await overlayStore.replaceWorkspaceLinkedDirectory({
      backend: acpBackendId as never,
      threadId: "session-1",
      directory: {
        id: "pwragent-handoff:acp:gemini:session-1",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
        kind: "worktree",
      },
      gitBranch: "feature/handoff",
    });
    const startSession = vi.fn(async (params: {
      sessionId?: string;
      cwd?: string;
      executionMode: ThreadExecutionMode;
      title?: string;
      createdAt?: number;
    }) => {
      const metadata: AcpSessionMetadata = {
        backendId: acpBackendId,
        sessionId: params.sessionId ?? "agent-session-2",
        agentSessionId: "agent-session-2",
        title: params.title ?? "ACP session",
        cwd: params.cwd,
        createdAt: params.createdAt ?? 1000,
        updatedAt: 2000,
        executionMode: params.executionMode,
        status: "idle",
      };
      sessionStore.upsertSession(metadata);
      return metadata;
    });
    const ensureSession = vi.fn(async () => undefined);
    const startPrompt = vi.fn((params: {
      sessionId: string;
      prompt: string;
      turnId?: string;
    }) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? "pending:session-1:1001",
    }));
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      startSession,
      ensureSession,
      startPrompt,
      cancelSession: vi.fn(async (sessionId: string) => {
        answerAcpSessionCancel(registry, acpBackendId, sessionId);
      }),
      readReplay: vi.fn(),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: sessionStore,
      createAcpClient: () => acpClient,
    });

    await registry.startTurn({
      backend: acpBackendId,
      threadId: "session-1",
      input: [{ type: "text", text: "What is the CWD?" }],
    });

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        cwd: "/repo/app/.worktrees/app-feature-handoff",
      }),
    );
    expect(sessionStore.getSession(acpBackendId, "session-1")).toMatchObject({
      agentSessionId: "agent-session-2",
      cwd: "/repo/app/.worktrees/app-feature-handoff",
    });
    expect(ensureSession).not.toHaveBeenCalled();

    await registry.close();
  });

  it("rebinds ACP protocol sessions when the provider no longer recognizes the stored session id", async () => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const sessionStore = createAcpSessionStoreMock([
      {
        backendId: acpBackendId,
        sessionId: "stable-thread-id",
        title: "Kimi Test Thread",
        cwd: "/repo/app",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      },
    ]);
    const startSession = vi.fn(async (params: {
      sessionId?: string;
      cwd?: string;
      executionMode: ThreadExecutionMode;
      title?: string;
      createdAt?: number;
    }) => {
      const metadata: AcpSessionMetadata = {
        backendId: acpBackendId,
        sessionId: params.sessionId ?? "session-new",
        agentSessionId: "session-new",
        title: params.title ?? "ACP session",
        cwd: params.cwd,
        createdAt: params.createdAt ?? 1000,
        updatedAt: 2000,
        executionMode: params.executionMode,
        status: "idle",
      };
      sessionStore.upsertSession(metadata);
      return metadata;
    });
    const ensureSession = vi.fn(async () => {
      throw new Error(
        'json-rpc error (-32602): Invalid params: Unknown sessionId: stable-thread-id: {"sessionId":"stable-thread-id"}',
      );
    });
    const startPrompt = vi.fn((params: {
      sessionId: string;
      prompt: string;
      turnId?: string;
    }) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? "pending:stable-thread-id:1001",
    }));
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      startSession,
      ensureSession,
      startPrompt,
      cancelSession: vi.fn(async (sessionId: string) => {
        answerAcpSessionCancel(registry, acpBackendId, sessionId);
      }),
      readReplay: vi.fn(),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "kimi",
          name: "Kimi CLI",
          distributionKind: "local",
          distributionSource: "kimi --acp",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-kimi-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "kimi",
            distributionKind: "local",
            command: "kimi",
            args: ["--acp"],
            env: {},
          },
        },
      ]),
      acpSessionStore: sessionStore,
      createAcpClient: () => acpClient,
    });

    await registry.startTurn({
      backend: acpBackendId,
      threadId: "stable-thread-id",
      input: [{ type: "text", text: "That worked!" }],
    });

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "stable-thread-id",
        cwd: "/repo/app",
        title: "Kimi Test Thread",
      }),
    );
    expect(startPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "stable-thread-id",
        prompt: "That worked!",
      }),
    );
    expect(sessionStore.getSession(acpBackendId, "stable-thread-id")).toMatchObject({
      agentSessionId: "session-new",
    });

    await registry.close();
  });

  it("updates stored ACP session cwd on workspace handoff before the next turn", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessionStore = createAcpSessionStoreMock([
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "ACP session",
        cwd: "/repo/app",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      },
    ]);
    const startSession = vi.fn(async (params: {
      sessionId?: string;
      cwd?: string;
      executionMode: ThreadExecutionMode;
      title?: string;
      createdAt?: number;
    }) => {
      const metadata: AcpSessionMetadata = {
        backendId: acpBackendId,
        sessionId: params.sessionId ?? "agent-session-2",
        agentSessionId: "agent-session-2",
        title: params.title ?? "ACP session",
        cwd: params.cwd,
        createdAt: params.createdAt ?? 1000,
        updatedAt: 2000,
        executionMode: params.executionMode,
        status: "idle",
      };
      sessionStore.upsertSession(metadata);
      return metadata;
    });
    const ensureSession = vi.fn(async () => undefined);
    const startPrompt = vi.fn((params: {
      sessionId: string;
      prompt: string;
      turnId?: string;
    }) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? "pending:session-1:1001",
    }));
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      startSession,
      ensureSession,
      startPrompt,
      cancelSession: vi.fn(async (sessionId: string) => {
        answerAcpSessionCancel(registry, acpBackendId, sessionId);
      }),
      readReplay: vi.fn(),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
    };
    const handoff = vi.fn(async () => ({
      backend: acpBackendId,
      threadId: "session-1",
      direction: "local-to-worktree" as const,
      workMode: "worktree" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:acp:gemini:session-1",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
        kind: "worktree" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: sessionStore,
      createAcpClient: () => acpClient,
      gitDirectoryService: {
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    await registry.handoffThreadWorkspace({
      backend: acpBackendId,
      threadId: "session-1",
      direction: "local-to-worktree",
      leaveLocalBranch: "main",
    });
    await registry.startTurn({
      backend: acpBackendId,
      threadId: "session-1",
      input: [{ type: "text", text: "What is the CWD?" }],
    });

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        cwd: "/repo/app/.worktrees/app-feature-handoff",
      }),
    );
    expect(sessionStore.getSession(acpBackendId, "session-1")).toMatchObject({
      agentSessionId: "agent-session-2",
      cwd: "/repo/app/.worktrees/app-feature-handoff",
    });
    expect(ensureSession).not.toHaveBeenCalled();
    expect(startPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        prompt: "What is the CWD?",
      }),
    );

    await registry.close();
  });

  it("reloads an existing Grok conversation in the destination project before the next turn", async () => {
    const acpBackendId = "acp:grok" as AcpBackendId;
    const sessionStore = createAcpSessionStoreMock([
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "ACP session",
        cwd: "/repo/app",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
        hasConversationHistory: true,
        agentSessionId: "original-agent-session",
      },
    ]);
    const startSession = vi.fn(async (params: {
      sessionId?: string;
      cwd?: string;
      executionMode: ThreadExecutionMode;
      title?: string;
      createdAt?: number;
    }) => {
      const metadata: AcpSessionMetadata = {
        backendId: acpBackendId,
        sessionId: params.sessionId ?? "agent-session-2",
        agentSessionId: "agent-session-2",
        title: params.title ?? "ACP session",
        cwd: params.cwd,
        createdAt: params.createdAt ?? 1000,
        updatedAt: 2000,
        executionMode: params.executionMode,
        status: "idle",
      };
      sessionStore.upsertSession(metadata);
      return metadata;
    });
    const ensureSession = vi.fn(async () => undefined);
    const startPrompt = vi.fn((params: {
      sessionId: string;
      prompt: string;
      turnId?: string;
    }) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? "pending:session-1:1001",
    }));
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      startSession,
      ensureSession,
      startPrompt,
      cancelSession: vi.fn(async (sessionId: string) => {
        answerAcpSessionCancel(registry, acpBackendId, sessionId);
      }),
      readReplay: vi.fn(),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
    };
    const handoff = vi.fn(async () => ({
      backend: acpBackendId,
      threadId: "session-1",
      direction: "to-project" as const,
      workMode: "local" as const,
      branch: "feature/handoff",
      repositoryPath: "/projects/demo",
      targetPath: "/projects/demo",
      linkedDirectory: {
        id: "pwragent-handoff:acp:grok:session-1",
        label: "app",
        path: "/projects/demo",
        kind: "local" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
    const overlayStore = createOverlayStoreMock();
    await overlayStore.setThreadParent({
      backend: acpBackendId, threadId: "session-1", parentThreadId: "parent", parentThreadBackend: "codex",
    });
    const replaceWorkspace = vi.spyOn(overlayStore, "replaceWorkspaceLinkedDirectory");
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "grok",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          runtimeCapabilities: {
            schemaVersion: 1, status: "discovered", discoveredAt: 1000,
            checkedAt: 1000, source: "initialize",
            agentCapabilities: { loadSession: true },
          },
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "grok",
            distributionKind: "local",
            command: "grok",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: sessionStore,
      createAcpClient: () => acpClient,
      gitDirectoryService: {
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    await registry.handoffThreadWorkspace({
      backend: acpBackendId,
      threadId: "session-1",
      direction: "to-project",
      targetPath: "/projects/demo",
    });
    expect(replaceWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      backend: acpBackendId, threadId: "session-1", resetProjectState: true,
    }));
    await registry.startTurn({
      backend: acpBackendId,
      threadId: "session-1",
      input: [{ type: "text", text: "What is the CWD?" }],
    });

    expect(startSession).not.toHaveBeenCalled();
    expect(ensureSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1", agentSessionId: "original-agent-session", cwd: "/projects/demo",
    }));
    expect(sessionStore.getSession(acpBackendId, "session-1")).toMatchObject({
      agentSessionId: "original-agent-session", cwd: "/projects/demo",
    });
    expect(startPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        prompt: "What is the CWD?",
      }),
    );

    await expect(registry.handoffThreadWorkspace({
      backend: acpBackendId, threadId: "session-1", direction: "to-project", targetPath: "/projects/other",
    })).rejects.toThrow("while a turn is in progress");

    await registry.close();
  });

  it.each(["local-to-worktree", "to-project"] as const)("rejects Gemini ACP workspace handoff after the first message: %s", async (direction) => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const handoff = vi.fn();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock([
        {
          backendId: acpBackendId,
          sessionId: "session-1",
          title: "ACP session",
          cwd: "/repo/app",
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: "default",
          status: "idle",
          hasConversationHistory: true,
        },
      ]),
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    await expect(
      registry.handoffThreadWorkspace({
        backend: acpBackendId,
        threadId: "session-1",
        direction,
        targetPath: "/projects/demo",
        leaveLocalBranch: "main",
      }),
    ).rejects.toThrow("cannot hand off a workspace after the first message");
    expect(handoff).not.toHaveBeenCalled();

    await registry.close();
  });

  it("rejects rebinding legacy Gemini ACP sessions after conversation history exists", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessionStore = createAcpSessionStoreMock([
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "ACP session",
        cwd: "/repo/app/.worktrees/app-feature-handoff",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
        hasConversationHistory: true,
      },
    ]);
    const ensureSession = vi.fn(async () => {
      throw new Error(
        'json-rpc error (-32603): Internal error: {"details":"No previous sessions found for this project."}',
      );
    });
    const startSession = vi.fn(async (params: {
      sessionId?: string;
      cwd?: string;
      executionMode: ThreadExecutionMode;
      title?: string;
      createdAt?: number;
    }) => {
      const metadata: AcpSessionMetadata = {
        backendId: acpBackendId,
        sessionId: params.sessionId ?? "agent-session-2",
        agentSessionId: "agent-session-2",
        title: params.title ?? "ACP session",
        cwd: params.cwd,
        createdAt: params.createdAt ?? 1000,
        updatedAt: 2000,
        executionMode: params.executionMode,
        status: "idle",
      };
      sessionStore.upsertSession(metadata);
      return metadata;
    });
    const startPrompt = vi.fn((params: {
      sessionId: string;
      prompt: string;
      turnId?: string;
    }) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? "pending:session-1:1001",
    }));
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      startSession,
      ensureSession,
      startPrompt,
      cancelSession: vi.fn(),
      readReplay: vi.fn(),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: sessionStore,
      createAcpClient: () => acpClient,
    });

    await expect(
      registry.startTurn({
        backend: acpBackendId,
        threadId: "session-1",
        input: [{ type: "text", text: "What is the CWD now?" }],
      }),
    ).rejects.toThrow("cannot hand off a workspace after the first message");

    expect(ensureSession).toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(sessionStore.getSession(acpBackendId, "session-1")).toMatchObject({
      cwd: "/repo/app/.worktrees/app-feature-handoff",
    });
    expect(startPrompt).not.toHaveBeenCalled();

    await registry.close();
  });

  it("rejects workspace handoff while the thread has an active turn", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Move me later",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "feature/handoff",
      updatedAt: 2,
    };
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      direction: "local-to-worktree" as const,
      workMode: "worktree" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:codex:thread-1",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
        kind: "worktree" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "turn/start"] },
      threads: [thread],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "keep working" }],
    });

    await expect(
      registry.handoffThreadWorkspace({
        backend: "codex",
        threadId: "thread-1",
        direction: "local-to-worktree",
      }),
    ).rejects.toThrow(
      "Worktree/local migration is not available while a turn is in progress. Resubmit when the turn completes.",
    );
    expect(handoff).not.toHaveBeenCalled();

    await registry.close();
  });

  it("rejects workspace handoff for active turns learned from backend notifications", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Notification active turn",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "feature/handoff",
      updatedAt: 2,
    };
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      direction: "local-to-worktree" as const,
      workMode: "worktree" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:codex:thread-1",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
        kind: "worktree" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [thread],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    await codexClient.emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-from-notification",
        turn: {
          id: "turn-from-notification",
          status: "inProgress",
        },
      },
    });

    await expect(
      registry.handoffThreadWorkspace({
        backend: "codex",
        threadId: "thread-1",
        direction: "local-to-worktree",
      }),
    ).rejects.toThrow(
      "Worktree/local migration is not available while a turn is in progress. Resubmit when the turn completes.",
    );

    await codexClient.emit({
      method: "turn/failed",
      params: {
        threadId: "thread-1",
        turnId: "turn-from-notification",
        turn: {
          id: "turn-from-notification",
          status: "failed",
          error: {
            message: "boom",
          },
        },
      },
    });

    await registry.handoffThreadWorkspace({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
    });
    expect(handoff).toHaveBeenCalledTimes(1);

    await registry.close();
  });

  it("records detached handoff results as HEAD immediately", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Detached handoff",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "pwragent-handoff:codex:thread-1",
          label: "app",
          path: "/repo/app",
          worktreePath: "/repo/app/.worktrees/app-main-detached",
          kind: "worktree",
        },
      ],
      source: "codex",
      gitBranch: "main",
      observedGitBranch: "HEAD",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock();
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      direction: "worktree-to-local" as const,
      strategy: "detached-changes" as const,
      workMode: "local" as const,
      baseSha: "abc123",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app",
      linkedDirectory: {
        id: "pwragent-handoff:codex:thread-1",
        label: "app",
        path: "/repo/app",
        kind: "local" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [thread],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    await registry.handoffThreadWorkspace({
      backend: "codex",
      threadId: "thread-1",
      direction: "worktree-to-local",
    });

    expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
      threadId: "thread-1",
      gitInfo: {
        branch: "HEAD",
      },
    });
    expect(codexClient.lastUpdateThreadWorkspaceParams).toEqual({
      threadId: "thread-1",
      cwd: "/repo/app",
    });
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      gitBranch: "HEAD",
      observedGitBranch: "HEAD",
      extraLinkedDirectories: [
        expect.objectContaining({
          id: "pwragent-handoff:codex:thread-1",
          kind: "local",
        }),
      ],
    });

    await registry.close();
  });

  it("records a detached local handoff with the current destination branch when available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-registry-handoff-branch-"));
    const repoPath = path.join(root, "PwrAgnt");

    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
      await writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);

      const thread: AppServerThreadSummary = {
        id: "thread-1",
        title: "Detached handoff",
        titleSource: "explicit",
        linkedDirectories: [
          {
            id: "pwragent-handoff:codex:thread-1",
            label: "PwrAgnt",
            path: repoPath,
            worktreePath: path.join(root, ".codex", "worktrees", "old", "PwrAgnt"),
            kind: "worktree",
          },
        ],
        source: "codex",
        gitBranch: "HEAD",
        observedGitBranch: "HEAD",
        updatedAt: 2,
      };
      const overlayStore = createOverlayStoreMock();
      const handoff = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        direction: "worktree-to-local" as const,
        strategy: "detached-changes" as const,
        workMode: "local" as const,
        baseSha: "abc123",
        repositoryPath: repoPath,
        targetPath: repoPath,
        linkedDirectory: {
          id: "pwragent-handoff:codex:thread-1",
          label: "PwrAgnt",
          path: repoPath,
          kind: "local" as const,
        },
        warnings: [],
        completedAt: 1000,
      }));
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [thread],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore,
        gitWorkspaceHandoffService: {
          handoff,
        } as never,
      });

      await registry.handoffThreadWorkspace({
        backend: "codex",
        threadId: "thread-1",
        direction: "worktree-to-local",
      });

      expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
        threadId: "thread-1",
        gitInfo: {
          branch: "main",
        },
      });
      await expect(
        overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
      ).resolves.toMatchObject({
        gitBranch: "main",
        observedGitBranch: "main",
        extraLinkedDirectories: [
          expect.objectContaining({
            id: "pwragent-handoff:codex:thread-1",
            kind: "local",
          }),
        ],
      });

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("repairs stale detached branch state from the current local handoff workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-registry-drift-local-"));
    const repoPath = path.join(root, "PwrAgnt");

    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
      await writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);

      const staleWorktreePath = path.join(root, ".codex", "worktrees", "old", "PwrAgnt");
      const thread: AppServerThreadSummary = {
        id: "thread-1",
        title: "Moved thread",
        titleSource: "explicit",
        linkedDirectories: [
          {
            id: "directory:stale-worktree",
            label: "PwrAgnt",
            path: repoPath,
            worktreePath: staleWorktreePath,
            kind: "worktree",
          },
        ],
        source: "codex",
        gitBranch: "HEAD",
        observedGitBranch: "HEAD",
        updatedAt: 2,
      };
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "full-access",
            gitBranch: "HEAD",
            observedGitBranch: "HEAD",
            extraLinkedDirectories: [
              {
                id: "pwragent-handoff:codex:thread-1",
                kind: "local",
                label: "PwrAgnt",
                path: repoPath,
              },
            ],
          },
        },
      });
      const registry = createDesktopBackendRegistry({
        codexClient: new MockBackendClient({
          initializeResult: { methods: ["thread/list"] },
          threads: [thread],
        }),
        overlayStore,
      });

      const response = await registry.checkThreadBranchDrift({
        backend: "codex",
        expectedBranch: "HEAD",
        threadId: "thread-1",
      });

      expect(response).toMatchObject({
        expectedBranch: "main",
        observedBranch: "main",
        drifted: false,
      });
      await expect(
        overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
      ).resolves.toMatchObject({
        gitBranch: "main",
        observedGitBranch: "main",
      });

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("DesktopBackendRegistry workspace recovery", () => {
  async function mainCheckout(): Promise<{ root: string; repo: string; worktree: string }> {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-recovery-registry-")));
    const repo = path.join(root, "atlas");
    await mkdir(repo);
    await execFileAsync("git", ["-C", repo, "init", "-b", "main"]);
    await execFileAsync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--allow-empty", "-m", "initial"]);
    return { root, repo, worktree: path.join(root, "worktrees", "mf3k2q", "atlas") };
  }

  function worktreeThread(repo: string, worktree: string): AppServerThreadSummary {
    return {
      id: "thread-1",
      title: "Retry backoff",
      titleSource: "explicit",
      linkedDirectories: [{ id: "directory:wt", label: "atlas", path: repo, worktreePath: worktree, kind: "worktree" }],
      source: "codex",
      gitBranch: "fix/retry-backoff",
      updatedAt: 2,
    };
  }

  function registryFor(thread: AppServerThreadSummary, services: {
    recovery?: Record<string, unknown>;
    archive?: Record<string, unknown>;
  }) {
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "thread-1": {
          backend: "codex",
          threadId: "thread-1",
          extraLinkedDirectories: [...thread.linkedDirectories],
        } as ThreadOverlayState,
      },
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [thread],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      worktreeRecoveryService: services.recovery as never,
      worktreeArchiveService: services.archive as never,
    });
    return { registry, overlayStore, codexClient };
  }

  it("moves a thread whose worktree is gone to the main checkout without switching it", async () => {
    const { root, repo, worktree } = await mainCheckout();
    const releaseMissingWorktree = vi.fn(async () => true);
    const archive = vi.fn();
    const { registry, overlayStore, codexClient } = registryFor(worktreeThread(repo, worktree), {
      recovery: { releaseMissingWorktree },
      archive: { archive },
    });
    const publish = vi.spyOn(registry, "publishLocalEvent");
    try {
      const response = await registry.moveThreadToMainCheckout({
        backend: "codex", threadId: "thread-1", worktreePath: worktree,
      });

      expect(response).toMatchObject({ repositoryPath: repo, branch: "main", warnings: [] });
      // The renderer gates workspace actions on exactly this directory.
      expect(response.linkedDirectory).toEqual({
        id: "pwragent-handoff:codex:thread-1", kind: "local", label: "atlas", path: repo,
      });
      expect(releaseMissingWorktree).toHaveBeenCalledWith({ repositoryPath: repo, worktreePath: worktree });
      expect(archive).not.toHaveBeenCalled();
      expect((await execFileAsync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("main");
      expect(codexClient.lastUpdateThreadWorkspaceParams).toEqual({ threadId: "thread-1", cwd: repo });
      await expect(overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))
        .resolves.toMatchObject({
          extraLinkedDirectories: [expect.objectContaining({
            id: "pwragent-handoff:codex:thread-1", kind: "local", path: repo,
          })],
        });
      expect(publish).toHaveBeenCalledWith({
        backend: "codex",
        notification: {
          method: "navigation/threadDirectories/updated",
          params: { reason: "selected-thread", threadIds: ["thread-1"] },
        },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records a detached main checkout as HEAD, not the worktree's branch", async () => {
    // Git names a detached checkout HEAD, so the thread stops claiming the worktree's branch.
    const { root, repo, worktree } = await mainCheckout();
    await execFileAsync("git", ["-C", repo, "switch", "--detach", "-q"]);
    const { registry, codexClient } = registryFor(worktreeThread(repo, worktree), {
      recovery: { releaseMissingWorktree: vi.fn(async () => true) },
    });
    try {
      const response = await registry.moveThreadToMainCheckout({
        backend: "codex", threadId: "thread-1", worktreePath: worktree,
      });

      expect(response.branch).toBe("HEAD");
      expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
        threadId: "thread-1", gitInfo: { branch: "HEAD" },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("archives a present worktree with a checkpoint when the thread keeps Local's branch", async () => {
    const { root, repo, worktree } = await mainCheckout();
    await mkdir(worktree, { recursive: true });
    const snapshot = {
      id: "s1", backend: "codex" as const, threadId: "thread-1", worktreePath: worktree, repositoryPath: repo,
      snapshotRef: "refs/codex/snapshots/s1", snapshotCommit: "abc", createdAt: 1, archivedAt: 1,
      state: "archived" as const, ignoredFilesExcluded: true,
    };
    const archive = vi.fn(async () => snapshot);
    const releaseMissingWorktree = vi.fn();
    const { registry, overlayStore } = registryFor(worktreeThread(repo, worktree), {
      recovery: { releaseMissingWorktree },
      archive: { archive },
    });
    try {
      const response = await registry.moveThreadToMainCheckout({
        backend: "codex", threadId: "thread-1", worktreePath: worktree,
      });

      expect(archive).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1", repositoryPath: repo, worktreePath: worktree });
      expect(releaseMissingWorktree).not.toHaveBeenCalled();
      expect(response.archivedWorktree).toEqual(snapshot);
      await expect(overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))
        .resolves.toMatchObject({ worktreeSnapshots: [snapshot] });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recreates the recorded worktree and returns a refusal untouched", async () => {
    const { root, repo, worktree } = await mainCheckout();
    const refusal = {
      status: "failed" as const, backend: "codex" as const, threadId: "thread-1", worktreePath: worktree,
      reason: "branch-checked-out" as const, message: "checked out elsewhere", steps: [],
    };
    const recreate = vi.fn(async () => refusal);
    const { registry } = registryFor(worktreeThread(repo, worktree), { recovery: { recreate } });
    const publish = vi.spyOn(registry, "publishLocalEvent");
    try {
      await expect(registry.recreateThreadWorktree({
        backend: "codex", threadId: "thread-1", worktreePath: worktree, detached: true,
      })).resolves.toEqual(refusal);
      expect(recreate).toHaveBeenCalledWith(expect.objectContaining({
        repositoryPath: repo, worktreePath: worktree, branch: "fix/retry-backoff", detached: true,
      }));
      expect(publish).not.toHaveBeenCalled();

      await expect(registry.recreateThreadWorktree({
        backend: "codex", threadId: "thread-1", worktreePath: path.join(root, "some-other-folder"),
      })).rejects.toThrow(/no longer works in that worktree/);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
