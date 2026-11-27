import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Query as ClaudeQuery, SDKMessage as ClaudeMessage, SDKUserMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { threadLockRefusalMessage } from "@pwragent/shared/thread-lock";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { ThreadCorrespondenceStore } from "../app-server/thread-correspondence-store";
import { ClaudeTurnActiveError, type ClaudeBackend } from "../claude/claude-backend";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import {
  createOverlayStoreMock,
  emitCompletedTurn,
  emitStartedTurn,
  MockBackendClient,
} from "./helpers/backend-registry-fixture";

const sdkGetSessionInfo = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>(),
  getSessionInfo: sdkGetSessionInfo,
}));

const tempRoots: string[] = [];

afterEach(async () => {
  expect(sdkGetSessionInfo).not.toHaveBeenCalled();
  sdkGetSessionInfo.mockClear();
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const command = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  description: `${name} description`,
  argumentHint: "",
  ...extra,
});

async function makeTempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function readFirstPromptText(prompt: string | AsyncIterable<SDKUserMessage>): Promise<string> {
  if (typeof prompt === "string") return prompt;
  for await (const message of prompt) {
    const content = message.message.content;
    if (typeof content === "string") return content;
    return content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n---\n");
  }
  return "";
}

type ClaudeCommandAvailability = "unobserved" | "with-compact" | "without-compact" | "terminal-only";
type ThreadBusyKind =
  | "idle"
  | "active-turn"
  | "pending-start"
  | "managed-review"
  | "claude-rewinding"
  | "claude-rewind-query"
  | "claude-starting";

describe("DesktopBackendRegistry.compactThread routing and admission", () => {
  // Rule: compactThread routes strictly to params.backend, enforces thread locks,
  // refuses concurrent/busy operations, and honors observed Claude command availability.
  it("routes and admits compaction according to backend, lock, busy, and command availability rules", async () => {
    const root = await makeTempRoot("pwragent-compact-prop-");
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read", "thread/resume", "thread/compact/start"] },
    });
    const overlayStore = createOverlayStoreMock({ executionMode: "default" });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      pdfToolMcpServer: null,
      agentToolMcpServer: null,
      threadTitleGenerationService: null,
      claudeBackendOptions: {
        store: new ClaudeSessionStore(path.join(root, "sessions")),
        getSessionInfo: vi.fn().mockResolvedValue(undefined),
        inspectInstallation: async () => ({
          executable: "/fixture/claude",
          version: "2.1.330",
          authStatus: "signed-in",
        }),
        discoverModels: async () => [],
      },
    });

    const internal = registry as unknown as {
      claudeBackend: {
        startTurn: ClaudeBackend["startTurn"];
        catalogByCwd: Map<string, {
          commands: Array<{ name: string; backend: "claude"; scope: "session"; source: "provider" }>;
          skills: [];
        }>;
        terminalCommands: Set<string>;
        rewinding: Set<string>;
        rewindQueries: Map<string, Promise<void>>;
        starting: Map<string, AbortController>;
      };
      threadStarts: { hasPending: (identity: { backend: AppServerBackendKind; threadId: string }) => boolean };
      managedReviewService: { findReviewForParentTurn: (params: { backend: AppServerBackendKind; parentThreadId: string }) => unknown };
    };

    const codexCompact = vi.spyOn(codexClient, "compactThread");
    const claudeStartTurn = vi.spyOn(internal.claudeBackend, "startTurn");

    const { threadId: claudeThreadId } = await registry.startThread({
      backend: "claude",
      cwd: root,
      executionMode: "default",
    });

    try {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:kimi", "acp:grok"),
          fc.boolean(),
          fc.constantFrom<ThreadBusyKind>(
            "idle",
            "active-turn",
            "pending-start",
            "managed-review",
            "claude-rewinding",
            "claude-rewind-query",
            "claude-starting",
          ),
          fc.constantFrom<ClaudeCommandAvailability>("unobserved", "with-compact", "without-compact", "terminal-only"),
          async (backend, locked, busyKind, commandAvailability) => {
            const threadId = backend === "claude" ? claudeThreadId : `thread-${backend}`;
            codexCompact.mockClear();
            claudeStartTurn.mockReset();

            // Configure lock state for this target thread.
            const lockNote = "Paused for review";
            if (locked) {
              await overlayStore.setThreadLock({
                backend,
                threadId,
                lock: { lockedAt: 1_000, note: lockNote, source: "operator" },
              });
            } else {
              await overlayStore.setThreadLock({ backend, threadId, lock: undefined });
            }

            // Configure observed Claude command availability.
            internal.claudeBackend.catalogByCwd.clear();
            internal.claudeBackend.terminalCommands = new Set(["doctor", "color", "focus", "reload-plugins"]);
            if (commandAvailability === "with-compact") {
              internal.claudeBackend.catalogByCwd.set(root, { commands: [
                { name: "compact", backend: "claude", scope: "session", source: "provider" },
                { name: "init", backend: "claude", scope: "session", source: "provider" },
              ], skills: [] });
            } else if (commandAvailability === "without-compact") {
              internal.claudeBackend.catalogByCwd.set(root, { commands: [
                { name: "init", backend: "claude", scope: "session", source: "provider" },
              ], skills: [] });
            } else if (commandAvailability === "terminal-only") {
              internal.claudeBackend.terminalCommands.add("compact");
            }

            // Configure busy state.
            const hasPendingSpy = vi.spyOn(internal.threadStarts, "hasPending")
              .mockImplementation((identity) =>
                busyKind === "pending-start" && identity.backend === backend && identity.threadId === threadId,
              );
            const reviewSpy = vi.spyOn(internal.managedReviewService, "findReviewForParentTurn")
              .mockImplementation((params) =>
                busyKind === "managed-review" && params.backend === backend && params.parentThreadId === threadId
                  ? { mode: "managed" }
                  : undefined,
              );

            if (busyKind === "active-turn" && (backend === "codex" || backend === "claude")) {
              await emitStartedTurn(registry, backend, threadId, "active-turn-1");
            }
            if (backend === "claude") {
              if (busyKind === "claude-rewinding") internal.claudeBackend.rewinding.add(threadId);
              if (busyKind === "claude-rewind-query") internal.claudeBackend.rewindQueries.set(threadId, new Promise<void>(() => {}));
              if (busyKind === "claude-starting") internal.claudeBackend.starting.set(threadId, new AbortController());
            }

            claudeStartTurn.mockImplementation(async (turnParams) => ({
              backend: "claude",
              threadId: turnParams.threadId,
              turnId: "claude-compact-turn",
            }));

            try {
              const call = registry.compactThread({ backend, threadId });

              if (locked) {
                await expect(call).rejects.toThrow(threadLockRefusalMessage({ note: lockNote }));
                expect(codexCompact).not.toHaveBeenCalled();
                expect(claudeStartTurn).not.toHaveBeenCalled();
                return;
              }

              const isBusyForBackend =
                (busyKind === "active-turn" && !backend.startsWith("acp:"))
                || busyKind === "managed-review"
                || (backend === "claude" && (
                  busyKind === "pending-start"
                  || busyKind === "claude-rewinding"
                  || busyKind === "claude-rewind-query"
                  || busyKind === "claude-starting"
                ));

              if (isBusyForBackend) {
                await expect(call).rejects.toThrow("Cannot compact a thread while another operation is running");
                expect(codexCompact).not.toHaveBeenCalled();
                expect(claudeStartTurn).not.toHaveBeenCalled();
                return;
              }

              if (backend.startsWith("acp:")) {
                await expect(call).rejects.toThrow(`ACP backend ${backend} does not support thread compaction`);
                expect(codexCompact).not.toHaveBeenCalled();
                expect(claudeStartTurn).not.toHaveBeenCalled();
                return;
              }

              if (backend === "claude"
                && (commandAvailability === "without-compact" || commandAvailability === "terminal-only")) {
                await expect(call).rejects.toThrow(/does not support thread compaction/i);
                expect(codexCompact).not.toHaveBeenCalled();
                expect(claudeStartTurn).not.toHaveBeenCalled();
                return;
              }

              const response = await call;
              if (backend === "claude") {
                expect(response).toEqual({
                  backend: "claude",
                  threadId,
                  turnId: "claude-compact-turn",
                });
                expect(codexCompact).not.toHaveBeenCalled();
                expect(claudeStartTurn).toHaveBeenCalledTimes(1);
                expect(claudeStartTurn.mock.calls[0]![0].input).toEqual([{ type: "text", text: "/compact" }]);
              } else {
                expect(response).toMatchObject({
                  backend: "codex",
                  threadId,
                  turnId: "compact-turn-1",
                });
                expect(codexCompact).toHaveBeenCalledTimes(1);
                expect(claudeStartTurn).not.toHaveBeenCalled();
                // Settle the Codex compaction retry entry so subsequent runs start clean.
                await codexClient.emit({
                  method: "turn/completed",
                  params: {
                    threadId,
                    turnId: response.turnId,
                    turn: { id: response.turnId, status: "completed", output: [] },
                  },
                });
              }
            } finally {
              hasPendingSpy.mockRestore();
              reviewSpy.mockRestore();
              internal.claudeBackend.rewinding.delete(threadId);
              internal.claudeBackend.rewindQueries.delete(threadId);
              internal.claudeBackend.starting.delete(threadId);
              if (busyKind === "active-turn" && (backend === "codex" || backend === "claude")) {
                await emitCompletedTurn(registry, backend, threadId, "active-turn-1");
              }
            }
          },
        ),
        { numRuns: 50 },
      );
    } finally {
      await registry.close();
    }
  });

  it("compacts a Claude thread by running /compact through ClaudeBackend without touching Codex", async () => {
    const root = await makeTempRoot("pwragent-claude-compact-");
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read", "thread/resume", "thread/compact/start"] },
    });
    const codexCompact = vi.spyOn(codexClient, "compactThread");
    const observedPrompts: string[] = [];
    const turnFinished = Promise.withResolvers<AgentEvent>();
    const events: AgentEvent[] = [];

    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
      pdfToolMcpServer: null,
      agentToolMcpServer: null,
      threadTitleGenerationService: null,
      claudeBackendOptions: {
        store: new ClaudeSessionStore(path.join(root, "sessions")),
        getSessionInfo: vi.fn().mockResolvedValue(undefined),
        inspectInstallation: async () => ({
          executable: "/fixture/claude",
          version: "2.1.330",
          authStatus: "signed-in",
        }),
        discoverModels: async () => [],
        query: ({ prompt, options = {} }) => {
          async function* messages(): AsyncGenerator<ClaudeMessage> {
            observedPrompts.push(await readFirstPromptText(prompt));
            yield {
              type: "system",
              subtype: "init",
              session_id: options.sessionId ?? options.resume ?? "claude-session-1",
            } as ClaudeMessage;
            yield {
              type: "system",
              subtype: "status",
              status: "compacting",
            } as ClaudeMessage;
            yield {
              type: "system",
              subtype: "compact_boundary",
              uuid: "boundary-claude-1",
              compact_metadata: { trigger: "manual", pre_tokens: 90_000, post_tokens: 8_000 },
            } as unknown as ClaudeMessage;
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "",
            } as ClaudeMessage;
          }
          return Object.assign(messages(), {
            initializationResult: async () => ({ mcp_servers_applied: true }),
            supportedCommands: async () => [command("compact", { builtin: true })],
            close: vi.fn(),
            setPermissionMode: vi.fn(),
          }) as unknown as ClaudeQuery;
        },
      },
    });
    registry.onEvent((event) => {
      events.push(event);
      if (["turn/completed", "turn/failed", "turn/cancelled"].includes(event.notification.method)) {
        turnFinished.resolve(event);
      }
    });

    try {
      const { threadId } = await registry.startThread({
        backend: "claude",
        cwd: root,
        executionMode: "default",
      });

      const response = await registry.compactThread({ backend: "claude", threadId });
      expect(response).toEqual({
        backend: "claude",
        threadId,
        turnId: expect.any(String),
      });
      expect(codexCompact).not.toHaveBeenCalled();

      const terminal = await turnFinished.promise;
      expect(terminal.backend).toBe("claude");
      expect(terminal.notification.method).toBe("turn/completed");
      expect(observedPrompts).toEqual(["/compact"]);
      expect(events).toContainEqual({
        backend: "claude",
        notification: {
          method: "thread/compacted",
          params: { threadId, itemId: "boundary-claude-1" },
        },
      });
    } finally {
      await registry.close();
    }
  });

  it("refuses to compact a locked Claude thread without starting a turn or touching Codex", async () => {
    const root = await makeTempRoot("pwragent-claude-compact-locked-");
    const codexClient = new MockBackendClient({});
    const codexCompact = vi.spyOn(codexClient, "compactThread");
    const query = vi.fn();
    const overlayStore = createOverlayStoreMock({ executionMode: "default" });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      pdfToolMcpServer: null,
      agentToolMcpServer: null,
      threadTitleGenerationService: null,
      claudeBackendOptions: {
        store: new ClaudeSessionStore(path.join(root, "sessions")),
        getSessionInfo: vi.fn().mockResolvedValue(undefined),
        inspectInstallation: async () => ({
          executable: "/fixture/claude",
          version: "2.1.330",
          authStatus: "signed-in",
        }),
        discoverModels: async () => [],
        query,
      },
    });

    try {
      const { threadId } = await registry.startThread({
        backend: "claude",
        cwd: root,
        executionMode: "default",
      });
      await registry.setThreadLock(
        { backend: "claude", threadId, locked: true, note: "Waiting on release" },
        { source: "operator" },
      );

      await expect(registry.compactThread({ backend: "claude", threadId }))
        .rejects.toThrow("This thread is locked: Waiting on release. Unlock it before starting a turn.");
      expect(query).not.toHaveBeenCalled();
      expect(codexCompact).not.toHaveBeenCalled();
    } finally {
      await registry.close();
    }
  });

  it("allows at most one concurrent Claude compaction and refuses while a turn is active", async () => {
    const root = await makeTempRoot("pwragent-claude-compact-busy-");
    const codexClient = new MockBackendClient({});
    const releaseTurn = Promise.withResolvers<void>();
    let queryCalls = 0;

    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
      pdfToolMcpServer: null,
      agentToolMcpServer: null,
      threadTitleGenerationService: null,
      claudeBackendOptions: {
        store: new ClaudeSessionStore(path.join(root, "sessions")),
        getSessionInfo: vi.fn().mockResolvedValue(undefined),
        inspectInstallation: async () => ({
          executable: "/fixture/claude",
          version: "2.1.330",
          authStatus: "signed-in",
        }),
        discoverModels: async () => [],
        query: ({ options = {} }) => {
          queryCalls += 1;
          async function* messages(): AsyncGenerator<ClaudeMessage> {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.sessionId ?? options.resume ?? "claude-session-busy",
            } as ClaudeMessage;
            await releaseTurn.promise;
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "",
            } as ClaudeMessage;
          }
          return Object.assign(messages(), {
            initializationResult: async () => ({ mcp_servers_applied: true }),
            supportedCommands: async () => [command("compact", { builtin: true })],
            close: vi.fn(),
            setPermissionMode: vi.fn(),
          }) as unknown as ClaudeQuery;
        },
      },
    });

    try {
      const { threadId } = await registry.startThread({
        backend: "claude",
        cwd: root,
        executionMode: "default",
      });

      const [first, second] = await Promise.allSettled([
        registry.compactThread({ backend: "claude", threadId }),
        registry.compactThread({ backend: "claude", threadId }),
      ]);
      const fulfilled = [first, second].filter((entry) => entry.status === "fulfilled");
      const rejected = [first, second].filter((entry) => entry.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        message: "Cannot compact a thread while another operation is running",
      });
      expect(queryCalls).toBe(1);

      // While the first compaction turn is still active, another call also fails as busy.
      await expect(registry.compactThread({ backend: "claude", threadId }))
        .rejects.toThrow("Cannot compact a thread while another operation is running");
    } finally {
      releaseTurn.resolve();
      await registry.close();
    }
  });

  it("refuses Claude compaction when observed commands omit compact or mark it terminal-only", async () => {
    const root = await makeTempRoot("pwragent-claude-compact-cmd-");
    const codexClient = new MockBackendClient({});
    const turnFinished = Promise.withResolvers<void>();
    let queryCalls = 0;

    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
      pdfToolMcpServer: null,
      agentToolMcpServer: null,
      threadTitleGenerationService: null,
      claudeBackendOptions: {
        store: new ClaudeSessionStore(path.join(root, "sessions")),
        getSessionInfo: vi.fn().mockResolvedValue(undefined),
        inspectInstallation: async () => ({
          executable: "/fixture/claude",
          version: "2.1.330",
          authStatus: "signed-in",
        }),
        discoverModels: async () => [],
        query: ({ options = {} }) => {
          queryCalls += 1;
          async function* messages(): AsyncGenerator<ClaudeMessage> {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.sessionId ?? options.resume ?? "claude-session-cmd",
              terminal_slash_commands: ["compact"],
            } as unknown as ClaudeMessage;
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "Ready.",
            } as ClaudeMessage;
          }
          return Object.assign(messages(), {
            initializationResult: async () => ({ mcp_servers_applied: true }),
            supportedCommands: async () => [command("init", { builtin: true }), command("compact", { builtin: true })],
            close: vi.fn(),
            setPermissionMode: vi.fn(),
          }) as unknown as ClaudeQuery;
        },
      },
    });
    registry.onEvent((event) => {
      if (event.notification.method === "turn/completed") turnFinished.resolve();
    });

    try {
      const { threadId } = await registry.startThread({
        backend: "claude",
        cwd: root,
        executionMode: "default",
      });
      // Run one normal turn so Claude publishes terminal_slash_commands: ["compact"].
      await registry.startTurn({
        backend: "claude",
        threadId,
        input: [{ type: "text", text: "Hello" }],
      });
      await turnFinished.promise;
      expect(queryCalls).toBe(1);

      await expect(registry.compactThread({ backend: "claude", threadId }))
        .rejects.toThrow(/does not support thread compaction/i);
      expect(queryCalls).toBe(1);
    } finally {
      await registry.close();
    }
  });

  it("does not prepend pending stack notices to a Claude /compact prompt", async () => {
    const root = await makeTempRoot("pwragent-claude-compact-stack-");
    const codexClient = new MockBackendClient({});
    const observedPrompts: string[] = [];
    const turnFinished = Promise.withResolvers<void>();
    const correspondenceStore = new ThreadCorrespondenceStore(path.join(root, "correspondence"));

    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
      correspondenceStore,
      pdfToolMcpServer: null,
      agentToolMcpServer: null,
      threadTitleGenerationService: null,
      claudeBackendOptions: {
        store: new ClaudeSessionStore(path.join(root, "sessions")),
        getSessionInfo: vi.fn().mockResolvedValue(undefined),
        inspectInstallation: async () => ({
          executable: "/fixture/claude",
          version: "2.1.330",
          authStatus: "signed-in",
        }),
        discoverModels: async () => [],
        query: ({ prompt, options = {} }) => {
          async function* messages(): AsyncGenerator<ClaudeMessage> {
            observedPrompts.push(await readFirstPromptText(prompt));
            yield {
              type: "system",
              subtype: "init",
              session_id: options.sessionId ?? options.resume ?? "claude-session-stack",
            } as ClaudeMessage;
            yield {
              type: "system",
              subtype: "compact_boundary",
              uuid: "boundary-stack-1",
              compact_metadata: { trigger: "manual", pre_tokens: 50_000, post_tokens: 5_000 },
            } as unknown as ClaudeMessage;
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "",
            } as ClaudeMessage;
          }
          return Object.assign(messages(), {
            initializationResult: async () => ({ mcp_servers_applied: true }),
            supportedCommands: async () => [command("compact", { builtin: true })],
            close: vi.fn(),
            setPermissionMode: vi.fn(),
          }) as unknown as ClaudeQuery;
        },
      },
    });
    registry.onEvent((event) => {
      if (event.notification.method === "turn/completed") turnFinished.resolve();
    });

    try {
      const { threadId } = await registry.startThread({
        backend: "claude",
        cwd: root,
        executionMode: "default",
      });
      correspondenceStore.record({
        id: "notice-1",
        source: { backend: "claude", threadId },
        destination: { backend: "claude", threadId },
        input: [{ type: "text", text: "Branch rebased" }],
        createdAt: 1_000,
        state: "queued",
        stackNotice: {
          opId: "op-1",
          kind: "restack",
          stack: "feat-stack",
          by: { threadId, actor: "operator" },
          branch: "feat",
          from: "111111111111",
          to: "222222222222",
          parent: "main",
          changedFiles: ["src/index.ts"],
          undo: "undo-1",
        },
      });

      await registry.compactThread({ backend: "claude", threadId });
      await turnFinished.promise;

      expect(observedPrompts).toEqual(["/compact"]);
      // The stack notice must remain pending for the next work turn.
      expect(correspondenceStore.pendingStackNotices({ backend: "claude", threadId })).toHaveLength(1);
    } finally {
      await registry.close();
    }
  });

  it("does not wait on Codex recovery barrier and refuses compaction once closed", async () => {
    const root = await makeTempRoot("pwragent-claude-compact-closed-");
    const codexClient = new MockBackendClient({});
    const turnFinished = Promise.withResolvers<void>();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
      pdfToolMcpServer: null,
      agentToolMcpServer: null,
      threadTitleGenerationService: null,
      claudeBackendOptions: {
        store: new ClaudeSessionStore(path.join(root, "sessions")),
        getSessionInfo: vi.fn().mockResolvedValue(undefined),
        inspectInstallation: async () => ({
          executable: "/fixture/claude",
          version: "2.1.330",
          authStatus: "signed-in",
        }),
        discoverModels: async () => [],
        query: ({ options = {} }) => {
          async function* messages(): AsyncGenerator<ClaudeMessage> {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.sessionId ?? options.resume ?? "claude-session-barrier",
            } as ClaudeMessage;
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "",
            } as ClaudeMessage;
          }
          return Object.assign(messages(), {
            initializationResult: async () => ({ mcp_servers_applied: true }),
            close: vi.fn(),
            setPermissionMode: vi.fn(),
          }) as unknown as ClaudeQuery;
        },
      },
    });
    registry.onEvent((event) => {
      if (event.notification.method === "turn/completed") turnFinished.resolve();
    });
    const { threadId } = await registry.startThread({
      backend: "claude",
      cwd: root,
      executionMode: "default",
    });
    // Hold Codex's recovery barrier open; Claude compaction must not block on it.
    const internal = registry as unknown as {
      codexRuntimeSupervisor: { readonly invalidIdRecoveryBarrier: Promise<void> };
    };
    const barrier = Promise.withResolvers<void>();
    vi.spyOn(internal.codexRuntimeSupervisor, "invalidIdRecoveryBarrier", "get").mockReturnValue(barrier.promise);

    try {
      const result = await registry.compactThread({ backend: "claude", threadId });
      expect(result).toEqual({ backend: "claude", threadId, turnId: expect.any(String) });
      await turnFinished.promise;

      await registry.close();
      await expect(registry.compactThread({ backend: "claude", threadId }))
        .rejects.toThrow("Desktop backend registry is closed");
    } finally {
      barrier.resolve();
      await registry.close();
    }
  });

  it("maps a racing ClaudeTurnActiveError during compaction start to the busy error", async () => {
    const root = await makeTempRoot("pwragent-claude-compact-race-");
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
      pdfToolMcpServer: null,
      agentToolMcpServer: null,
      threadTitleGenerationService: null,
      claudeBackendOptions: {
        store: new ClaudeSessionStore(path.join(root, "sessions")),
        getSessionInfo: vi.fn().mockResolvedValue(undefined),
        inspectInstallation: async () => ({
          executable: "/fixture/claude",
          version: "2.1.330",
          authStatus: "signed-in",
        }),
        discoverModels: async () => [],
      },
    });
    const internal = registry as unknown as {
      claudeBackend: { startTurn: ClaudeBackend["startTurn"] };
    };
    const startTurn = vi.spyOn(internal.claudeBackend, "startTurn")
      .mockRejectedValueOnce(new ClaudeTurnActiveError("A Claude turn is already active for this thread."));

    try {
      const { threadId } = await registry.startThread({
        backend: "claude",
        cwd: root,
        executionMode: "default",
      });
      await expect(registry.compactThread({ backend: "claude", threadId }))
        .rejects.toThrow("Cannot compact a thread while another operation is running");
      expect(startTurn).toHaveBeenCalledTimes(1);
    } finally {
      await registry.close();
    }
  });
});
