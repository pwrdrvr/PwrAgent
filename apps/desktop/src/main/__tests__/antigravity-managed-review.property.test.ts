import fc from "fast-check";
import { rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpSessionRuntimeState,
} from "@pwragent/shared/contracts/backend";
import type { ThreadExecutionMode } from "@pwragent/shared/contracts/normalized-app-server";
import { AcpAgentStore } from "@pwragent/sqlite-storage/acp-agent-store";
import { AcpSessionStore } from "@pwragent/sqlite-storage/acp-session-store";
import type { AcpInstalledAgentRecord, AcpRegistrySnapshot } from "../acp/acp-registry-types";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { buildManagedReviewPrompt } from "../app-server/managed-review";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb } from "./sqlite-test-utils";
import {
  callRegistryMcpTool,
  createAcpAgentStoreMock,
  createAcpSessionStoreMock,
  createKimiAgentRecord,
  createOverlayStoreMock,
  MockBackendClient,
  nonRepositoryCwd,
} from "./helpers/backend-registry-fixture";

const ANTIGRAVITY_BACKEND = "acp:antigravity" as const;
const ALL_MODES = ["default", "accept-edits", "auto", "plan"] as const;
type AntigravityMode = (typeof ALL_MODES)[number];

type ProbeOptions = {
  parentBackend: "codex" | typeof ANTIGRAVITY_BACKEND;
  parentExecutionMode: ThreadExecutionMode;
  parentMode?: AntigravityMode;
  cachedMenu?: readonly AntigravityMode[];
  sessionMenu: readonly AntigravityMode[];
  agentRequested?: boolean;
  changeParentModeBeforeDispatch?: AntigravityMode;
  startUnrelatedThread?: boolean;
  stateDb?: StateDb;
};

function buildModeConfigOption(
  offered: readonly AntigravityMode[],
  currentValue: string,
) {
  return [{
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select" as const,
    currentValue,
    options: offered.map((value) => ({ value, name: value })),
  }];
}

function buildCachedCapabilities(
  offered: readonly AntigravityMode[] | undefined,
): BackendAcpRuntimeCapabilities | undefined {
  if (!offered) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    status: "discovered",
    modes: {
      currentModeId: offered[0],
      availableModes: offered.map((id) => ({ id, label: id })),
    },
    configOptions: [{
      id: "mode",
      label: "Mode",
      category: "mode",
      type: "select",
      currentValue: offered[0],
      values: offered.map((value) => ({ value, label: value })),
    }],
  };
}

async function runAntigravityManagedReview(options: ProbeOptions) {
  const parentThreadId = "review-parent-thread";
  const childSessionId = "antigravity-review-child";
  const agentBase = createKimiAgentRecord(ANTIGRAVITY_BACKEND);
  const installedAgent = {
    ...agentBase,
    registryId: "antigravity",
    name: "Antigravity",
    version: "1.5.15",
    launchDescriptor: {
      ...agentBase.launchDescriptor!,
      registryId: "antigravity",
      command: "agy",
      args: ["acp", "--process-per-session"],
    },
    runtimeCapabilities: buildCachedCapabilities(options.cachedMenu),
  };

  const parentAcpRuntime: BackendAcpSessionRuntimeState | undefined =
    options.parentBackend === ANTIGRAVITY_BACKEND && options.parentMode
      ? {
          currentModeId: options.parentMode,
          configValues: { mode: options.parentMode },
          updatedAt: 1_000,
        }
      : undefined;

  const sessions = options.stateDb ? new AcpSessionStore(options.stateDb) : createAcpSessionStoreMock([]);
  if (options.parentBackend === ANTIGRAVITY_BACKEND) {
    sessions.upsertSession({
      backendId: ANTIGRAVITY_BACKEND,
      sessionId: parentThreadId,
      title: "Antigravity parent",
      cwd: nonRepositoryCwd,
      createdAt: 1_000,
      updatedAt: 1_000,
      executionMode: options.parentExecutionMode === "full-access" ? "full-access" : "default",
      ...(options.parentExecutionMode === "full-access" ? { antigravityFullAccessConfirmed: true } : {}),
      ...(parentAcpRuntime ? { acpRuntime: parentAcpRuntime } : {}),
      status: "idle",
    });
  }
  const agents = options.stateDb
    ? new AcpAgentStore<AcpRegistrySnapshot, AcpInstalledAgentRecord>(options.stateDb)
    : createAcpAgentStoreMock([]);
  agents.upsertInstalledAgent(installedAgent);
  const overlayStore = options.stateDb ? new SqliteOverlayStore(options.stateDb) : createOverlayStoreMock({
    overlays: {
      [`${options.parentBackend}:${parentThreadId}`]: {
        backend: options.parentBackend,
        threadId: parentThreadId,
        executionMode: options.parentExecutionMode,
        extraLinkedDirectories: [],
      },
    },
  });

  const spawnedFullAccess: boolean[] = [];
  const promptModes: string[] = [];
  const promptTexts: string[] = [];
  const agentReviewStatuses: string[] = [];
  const closedChildSessions: string[] = [];
  const modeAtPrompt = Promise.withResolvers<void>();
  const finishPrompt = Promise.withResolvers<void>();
  let sessionCount = 0;

  const registry = createDesktopBackendRegistry({
    codexClient: new MockBackendClient({
      threads: options.parentBackend === "codex"
        ? [{
            id: parentThreadId,
            title: "Codex parent",
            titleSource: "explicit",
            linkedDirectories: [],
            source: "codex",
            createdAt: 1_000,
            updatedAt: 1_000,
          }]
        : [],
    }),
    overlayStore,
    acpAgentStore: agents,
    acpSessionStore: sessions,
    createAcpTransport: (agent) => {
      const fullAccess = agent.launchDescriptor?.args.includes(
        "--dangerously-skip-permissions",
      ) === true;
      spawnedFullAccess.push(fullAccess);
      const transport = new class extends FakeAcpAgentTransport {
        mode: string = options.sessionMenu[0] ?? "default";

        override async request(
          method: string,
          params?: Record<string, unknown>,
        ): Promise<unknown> {
          if (method === "initialize") {
            return {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                sessionCapabilities: { close: {} },
              },
            };
          }
          if (method === "session/new") {
            sessionCount += 1;
            const sessionId = `${childSessionId}-${sessionCount}`;
            this.mode = options.sessionMenu[0] ?? "default";
            return {
              sessionId,
              modes: {
                currentModeId: this.mode,
                availableModes: options.sessionMenu.map((id) => ({ id, name: id })),
              },
              configOptions: buildModeConfigOption(options.sessionMenu, this.mode),
            };
          }
          if (method === "session/set_config_option" && params?.configId === "mode") {
            const requested = String(params.value);
            if (!options.sessionMenu.includes(requested as AntigravityMode)) {
              throw new Error(`ACP request failed (-32602): Unknown mode: ${requested}`);
            }
            this.mode = requested;
            this.emitSessionUpdate(String(params.sessionId), {
              sessionUpdate: "current_mode_update",
              currentModeId: this.mode,
            });
            return { configOptions: buildModeConfigOption(options.sessionMenu, this.mode) };
          }
          if (method === "session/set_mode") {
            const requested = String(params?.modeId);
            if (!options.sessionMenu.includes(requested as AntigravityMode)) {
              throw new Error(`ACP request failed (-32602): Unknown mode: ${requested}`);
            }
            this.mode = requested;
            this.emitSessionUpdate(String(params?.sessionId), {
              sessionUpdate: "current_mode_update",
              currentModeId: this.mode,
            });
            return {};
          }
          const isReviewChild = String(params?.sessionId).startsWith(childSessionId);
          if (method === "session/close" && isReviewChild) {
            closedChildSessions.push(String(params?.sessionId));
          }
          if (method === "session/prompt" && isReviewChild) {
            promptModes.push(this.mode);
            modeAtPrompt.resolve();
            if (options.stateDb) await finishPrompt.promise;
            const promptBlocks = Array.isArray(params?.prompt)
              ? params.prompt as Array<{ text?: string }>
              : [];
            promptTexts.push(promptBlocks.map((block) => block.text ?? "").join("\n"));
            this.emitSessionUpdate(String(params?.sessionId), {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: JSON.stringify({
                  findings: [],
                  overall_correctness: "patch is correct",
                  overall_explanation: "No issues found.",
                  overall_confidence_score: 0.9,
                }),
              },
            });
            return { stopReason: "end_turn" };
          }
          return await super.request(method, params);
        }
      }();
      return transport;
    },
  });
  registry.onEvent(({ notification }) => {
    if (notification.method === "thread/reviewStart/updated"
      && typeof notification.params.status === "string") {
      agentReviewStatuses.push(notification.params.status);
    }
  });

  try {
    const review = {
      backend: options.parentBackend,
      threadId: parentThreadId,
      reviewBackend: ANTIGRAVITY_BACKEND,
      runMode: "pwragent-sub-agent" as const,
      delivery: "inline" as const,
      cwd: nonRepositoryCwd,
      target: { type: "uncommittedChanges" as const },
    };
    let writes;
    if (options.agentRequested) {
      const { backend, threadId } = review;
      const turnId = "requesting-turn";
      await registry.publishLocalEvent({ backend, notification: {
        method: "turn/started", params: { threadId, turnId, turn: { id: turnId } },
      } });
      const result = await callRegistryMcpTool({ registry, backend, threadId, turnId, tool: "start_review",
        args: { target: review.target, runMode: review.runMode },
      });
      expect(result?.structuredContent?.status).toBe("scheduled");
      const nextMode = options.changeParentModeBeforeDispatch;
      if (nextMode) {
        const parent = sessions.getSession(ANTIGRAVITY_BACKEND, threadId)!;
        sessions.upsertSession({ ...parent, acpRuntime: {
          currentModeId: nextMode, configValues: { mode: nextMode }, updatedAt: 2_000,
        } });
      }
      await registry.publishLocalEvent({ backend, notification: {
        method: "turn/completed", params: { threadId, turnId, turn: { id: turnId, status: "completed", output: [] } },
      } });
    } else if (options.stateDb) {
      ({ writes } = await measureSqliteWrites(async () => {
        await registry.startReview(review);
        await modeAtPrompt.promise;
      }));
    } else {
      await registry.startReview(review);
    }
    const cachedMode = agents.getInstalledAgent(ANTIGRAVITY_BACKEND)?.runtimeCapabilities?.configOptions
      ?.find((option) => option.id === "mode")?.currentValue;
    const unrelatedThreadId = options.startUnrelatedThread
      ? (await registry.startThread({ backend: ANTIGRAVITY_BACKEND, cwd: nonRepositoryCwd, workMode: "local" })).threadId
      : undefined;
    return { spawnedFullAccess, promptModes, promptTexts, cachedMode, writes, agentReviewStatuses, closedChildSessions,
      unrelatedMode: typeof unrelatedThreadId === "string"
        ? sessions.getSession(ANTIGRAVITY_BACKEND, unrelatedThreadId)?.acpRuntime?.currentModeId
        : undefined,
    };
  } finally {
    finishPrompt.resolve();
    await registry.close();
  }
}

describe("Antigravity managed review mode and access", () => {
  it("uses Antigravity Auto mode when offered, falls back safely when absent, and never escalates to Full Access", async () => {
    const modeSubsetArb = fc.uniqueArray(fc.constantFrom(...ALL_MODES), {
      minLength: 1,
      maxLength: ALL_MODES.length,
    });
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"codex" | typeof ANTIGRAVITY_BACKEND>(
          "codex",
          ANTIGRAVITY_BACKEND,
        ),
        fc.constantFrom<ThreadExecutionMode>("default", "auto", "full-access"),
        fc.option(fc.constantFrom(...ALL_MODES), { nil: undefined }),
        fc.option(modeSubsetArb, { nil: undefined }),
        modeSubsetArb,
        async (parentBackend, parentExecutionMode, parentMode, cachedMenu, sessionMenu) => {
          fc.pre(!(parentBackend === ANTIGRAVITY_BACKEND && parentExecutionMode === "auto"));
          const result = await runAntigravityManagedReview({
            parentBackend,
            parentExecutionMode,
            parentMode,
            cachedMenu,
            sessionMenu,
          });
          const expectFullAccess =
            parentBackend === ANTIGRAVITY_BACKEND
            && parentExecutionMode === "full-access";
          expect(result.spawnedFullAccess).toEqual([expectFullAccess]);
          // Full Access sessions run with --dangerously-skip-permissions and
          // normalize their native session mode to Default (#4338). Non-Full-Access
          // review children run in native Auto when offered, else fall back.
          const expectedMode = expectFullAccess
            ? (cachedMenu?.includes("default") && sessionMenu.includes("default")
                ? "default"
                : sessionMenu[0])
            : sessionMenu.includes("auto")
              ? "auto"
              : sessionMenu.includes("default")
                ? "default"
                : sessionMenu[0];
          expect(result.promptModes).toEqual([expectedMode]);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("runs a cross-provider Codex Auto thread review on Antigravity in Auto mode without Full Access", async () => {
    const result = await runAntigravityManagedReview({
      parentBackend: "codex",
      parentExecutionMode: "auto",
      cachedMenu: ALL_MODES,
      sessionMenu: ALL_MODES,
    });
    expect(result.spawnedFullAccess).toEqual([false]);
    expect(result.promptModes).toEqual(["auto"]);
  });

  it("runs a same-provider Antigravity Default or Plan thread review in Auto mode without Full Access", async () => {
    for (const parentMode of ["default", "plan"] as const) {
      const result = await runAntigravityManagedReview({
        parentBackend: ANTIGRAVITY_BACKEND,
        parentExecutionMode: "default",
        parentMode,
        cachedMenu: ALL_MODES,
        sessionMenu: ALL_MODES,
      });
      expect(result.spawnedFullAccess).toEqual([false]);
      expect(result.promptModes).toEqual(["auto"]);
    }
  });

  it.each(["default", "plan", "accept-edits", "auto"] as const)("keeps an agent-requested review in its caller's %s mode", async (parentMode) => {
    // An agent's tool call carries its existing access to the child.
    const result = await runAntigravityManagedReview({
      parentBackend: ANTIGRAVITY_BACKEND, parentExecutionMode: "default", parentMode,
      agentRequested: true, cachedMenu: ALL_MODES, sessionMenu: ALL_MODES,
    });
    expect(result.spawnedFullAccess).toEqual([false]);
    expect(result.promptModes).toEqual([parentMode]);
  });

  it("keeps the requesting turn's access when its parent switches to Auto before dispatch", async () => {
    const result = await runAntigravityManagedReview({
      parentBackend: ANTIGRAVITY_BACKEND, parentExecutionMode: "default", parentMode: "plan",
      agentRequested: true, changeParentModeBeforeDispatch: "auto", cachedMenu: ALL_MODES, sessionMenu: ALL_MODES,
    });
    expect(result.promptModes).toEqual(["plan"]);
  });

  it("refuses to prompt when the agent review child cannot confirm the caller's mode", async () => {
    const result = await runAntigravityManagedReview({
      parentBackend: ANTIGRAVITY_BACKEND, parentExecutionMode: "default", parentMode: "plan",
      agentRequested: true, cachedMenu: ALL_MODES, sessionMenu: ["auto", "default"],
    });
    expect(result.agentReviewStatuses).toEqual(["failed"]);
    expect(result.promptModes).toEqual([]);
    expect(result.closedChildSessions).toEqual(["antigravity-review-child-1"]);
  });

  it("keeps an Auto review's mode out of subsequent threads' defaults", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<"codex" | typeof ANTIGRAVITY_BACKEND>("codex", ANTIGRAVITY_BACKEND),
      fc.constantFrom("default", "plan", "accept-edits"),
      async (parentBackend, currentMode) => {
        const modes = [currentMode, ...ALL_MODES.filter((mode) => mode !== currentMode)];
        const result = await runAntigravityManagedReview({
          parentBackend, parentExecutionMode: "default", cachedMenu: modes,
          sessionMenu: modes, startUnrelatedThread: true,
        });
        expect(result.promptModes).toEqual(["auto"]);
        expect(result.cachedMode).toBe(currentMode);
        expect(result.unrelatedMode).toBe(currentMode);
      },
    ), { numRuns: 10 });
  });

  it("budgets SQLite writes from a cross-provider Antigravity Auto review start", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { tempDir, dbPath } = createTempStateDb("pwragent-antigravity-review-budget-");
    const stateDb = StateDb.open(dbPath);
    try {
      const result = await runAntigravityManagedReview({
        parentBackend: "codex", parentExecutionMode: "default", cachedMenu: ALL_MODES,
        sessionMenu: ALL_MODES, stateDb,
      });
      expect(result.promptModes).toEqual(["auto"]);
      expectSqliteWriteBudget({ scenario: "antigravity-auto-review-start",
        note: "Cross-provider review through the first hidden Antigravity prompt with real SQLite stores. About 1.61 MB/day at 10 review starts/day.",
        writes: result.writes!,
      });
    } finally {
      stateDb.close();
      rmSync(tempDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("falls back cleanly to Default when an Antigravity review session does not offer Auto", async () => {
    const result = await runAntigravityManagedReview({
      parentBackend: "codex",
      parentExecutionMode: "auto",
      cachedMenu: ALL_MODES,
      sessionMenu: ["default", "accept-edits", "plan"],
    });
    expect(result.spawnedFullAccess).toEqual([false]);
    expect(result.promptModes).toEqual(["default"]);
  });

  it("instructs managed reviewers to stay within read-only inspection without requiring elevated permissions", () => {
    const prompt = buildManagedReviewPrompt({ type: "uncommittedChanges" });
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toMatch(/read-only/i);
    expect(prompt).toMatch(/elevated permissions|approval/i);
  });
});
