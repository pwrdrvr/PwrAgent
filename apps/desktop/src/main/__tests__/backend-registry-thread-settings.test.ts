import {
  flushAsync,
  createDeferred,
  nonRepositoryCwd,
  waitForCondition,
  createOverlayStoreMock,
  MockBackendClient,
  createAcpAgentStoreMock,
  createAcpSessionStoreMock,
  createKimiAgentRecord,
  createKimiAcpRegistry,
  answerAcpSessionCancel,
  emitCompletedTurn,
  discoverCodexBackendForTest,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import fc from "fast-check";
import type { ClaudeBackend } from "../claude/claude-backend";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  AcpBackendId,
  AppServerPendingRequestNotification,
  AppServerThreadReplay,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeOptionSource,
  BackendAcpSessionRuntimeState,
} from "@pwragent/shared/contracts/backend";
import type { DesktopProviderThreadModelMigration } from "@pwragent/shared/contracts/settings";
import { buildCodexFastModeMismatchNotificationParams, getCodexFastModeMismatchWarning } from "../app-server/thread-model-options";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";
import * as desktopSettings from "../settings/desktop-settings-singleton";

describe("DesktopBackendRegistry", () => {
  it.each([false, true])("only attaches a skill profile after its snapshot is saved (write fails: %s)", async (writeFails) => {
    const profile = { id: "deploy", name: "Deploy", hiddenSkills: ["publish"] };
    const snapshot = { profileId: profile.id, profileName: profile.name, hiddenSkills: profile.hiddenSkills };
    const settings = vi.spyOn(desktopSettings, "getDesktopSettingsService").mockReturnValue({
      readModelsConfig: () => ({ codex: { skillProfiles: [profile] } }),
    } as ReturnType<typeof desktopSettings.getDesktopSettingsService>);
    const codexClient = new MockBackendClient({ threads: [] });
    const overlayStore = createOverlayStoreMock();
    const persist = vi.spyOn(overlayStore, "setThreadExecutionMode");
    if (writeFails) persist.mockRejectedValueOnce(new Error("disk full"));
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    try {
      if (!writeFails) {
        // A submitted ID can go stale between the remote picker and the owner.
        await expect(registry.startThread({ backend: "codex", codexSkillProfileId: "deleted" }))
          .rejects.toThrow(/skill profile is no longer available/i);
        expect(codexClient.lastStartThreadParams).toBeUndefined();
        expect(persist).not.toHaveBeenCalled();
      }
      const result = await registry.materializeDirectoryLaunchpad({
        directoryKey: "subthread:codex:parent:skill-profile",
        launchpad: {
          directoryKey: "subthread:codex:parent:skill-profile",
          directoryKind: "directory", directoryLabel: "Fixture",
          backend: "codex", codexSkillProfileId: profile.id, executionMode: "default",
          prompt: "Deploy the release.", workMode: "local", createdAt: 1, updatedAt: 1,
        },
      });
      expect(result.threadId).toBe("thread-1");
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({ codexSkillProfile: snapshot }));
      expect(result.codexSkillProfile).toEqual(writeFails ? undefined : snapshot);
      if (writeFails) {
        expect(result.turnStartFailure?.message).toMatch(/thread was created.*skill profile could not be saved/i);
        expect(codexClient.lastStartTurnParams).toBeUndefined();
      } else {
        expect(result.turnStartFailure).toBeUndefined();
        expect(codexClient.lastStartTurnParams?.threadId).toBe(result.threadId);
      }
    } finally {
      await registry.close();
      settings.mockRestore();
    }
  });

  it("passes the Codex default-mode question toggle to new and resumed threads", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      resolveCodexDefaultModeRequestUserInput: () => true,
    });

    try {
      await registry.startThread({
        backend: "codex",
        cwd: nonRepositoryCwd,
      });
      expect(codexClient.lastStartThreadParams?.defaultModeRequestUserInput).toBe(
        true,
      );

      await registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "continue" }],
      });
      expect(codexClient.lastStartTurnParams?.defaultModeRequestUserInput).toBe(
        true,
      );
    } finally {
      await registry.close();
    }
  });

  it("does not record an explicit thought level the session's model does not offer", async () => {
    // K2.7 Coding offers only `on`. The client skips any other level unless
    // told to refuse it, and a skip resolves with the unchanged state.
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const sessionRuntime: BackendAcpSessionRuntimeState = {
      configValues: { model: "kimi-code/kimi-for-coding", thinking: "on" },
      updatedAt: 1000,
    };
    const overlayStore = createOverlayStoreMock();
    const { acpClient, registry, sessions } = createKimiAcpRegistry({
      acpBackendId,
      overlayStore,
      sessions: [
        {
          backendId: acpBackendId,
          sessionId: "kimi-session-1",
          title: "Untitled thread",
          cwd: "/repo/project",
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: "default",
          status: "idle",
          acpRuntime: sessionRuntime,
        },
      ],
    });
    acpClient.setRuntimeOption.mockImplementation(async (params: {
      sessionId: string;
      optionId?: string;
      value?: string;
      rejectUnofferedThoughtLevel?: boolean;
    }) => {
      if (params.optionId === "thinking" && params.value !== "on") {
        if (params.rejectUnofferedThoughtLevel) {
          throw new Error(
            `The session's model does not offer "${params.value}" for thinking`,
          );
        }
        return sessionRuntime;
      }
      throw new Error(`unexpected write: ${params.optionId}=${params.value}`);
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => { events.push(event); });

    await expect(
      registry.setAcpSessionRuntimeOption({
        backend: acpBackendId,
        threadId: "kimi-session-1",
        source: "configOption",
        optionId: "thinking",
        value: "low",
      }),
    ).rejects.toThrow('does not offer "low" for thinking');
    expect(sessions[0]?.acpRuntime).toEqual({
      configValues: { model: "kimi-code/kimi-for-coding", thinking: "on" },
      updatedAt: 1000,
    });
    expect(
      events.filter(
        (event) => event.notification.method === "thread/acpRuntime/updated",
      ),
    ).toEqual([]);
    expect(
      (
        await overlayStore.getThreadOverlayState({
          backend: acpBackendId,
          threadId: "kimi-session-1",
        })
      )?.permissionTransitionLog,
    ).toBeUndefined();

    // The same request during a turn is queued, and its flush must record
    // nothing either. The queue's own retry decides what happens next.
    await registry.publishLocalEvent({
      backend: acpBackendId,
      notification: {
        method: "turn/started",
        params: {
          threadId: "kimi-session-1",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    await registry.setAcpSessionRuntimeOption({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      source: "configOption",
      optionId: "thinking",
      value: "low",
    });
    await emitCompletedTurn(registry, acpBackendId, "kimi-session-1");

    expect(sessions[0]?.acpRuntime).toEqual({
      configValues: { model: "kimi-code/kimi-for-coding", thinking: "on" },
      updatedAt: 1000,
    });
    expect(
      events.filter(
        (event) => event.notification.method === "thread/acpRuntime/updated",
      ),
    ).toEqual([]);
    expect(
      (
        await overlayStore.getThreadOverlayState({
          backend: acpBackendId,
          threadId: "kimi-session-1",
        })
      )?.permissionTransitionLog?.map((transition) => transition.status),
    ).toEqual(["queued"]);
    // The flush ran and was refused: the direct write plus one attempt.
    expect(acpClient.setRuntimeOption).toHaveBeenCalledTimes(2);

    unsubscribe();
    await registry.close();
  });

  it("applies Grok ACP reasoning effort without racing turn startup", async () => {
    const sessions: AcpSessionMetadata[] = [];
    const acpBackendId = "acp:grok" as AcpBackendId;
    const setRuntimeOption = vi.fn(
      async (params: {
        value: string;
        reasoningEffort?: string;
      }): Promise<BackendAcpSessionRuntimeState> => ({
        currentModelId: params.value,
        reasoningEffort: params.reasoningEffort,
        updatedAt: 2000,
      }),
    );
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async (params: {
        cwd?: string;
        executionMode: ThreadExecutionMode;
        acpRuntime?: BackendAcpSessionRuntimeState;
      }) => {
        const metadata: AcpSessionMetadata = {
          backendId: acpBackendId,
          sessionId: "grok-session",
          title: "Untitled thread",
          cwd: params.cwd,
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: params.executionMode,
          acpRuntime: params.acpRuntime,
          status: "idle",
        };
        sessions.push(metadata);
        return metadata;
      }),
      startPrompt: vi.fn((params: {
        sessionId: string;
        turnId?: string;
      }) => ({
        sessionId: params.sessionId,
        turnId: params.turnId ?? "grok-turn",
      })),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(async (sessionId: string) => {
        answerAcpSessionCancel(registry, acpBackendId, sessionId);
      }),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
      setRuntimeOption,
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "grok",
          name: "Grok",
          distributionKind: "local",
          distributionSource: "grok --acp",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-grok-cli",
          installedAt: 1000,
          updatedAt: 1000,
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
                  defaultReasoningEffort: "high",
                  reasoningEfforts: ["low", "medium", "high"],
                  supportsReasoning: true,
                },
              ],
            },
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    await registry.startThread({
      backend: acpBackendId,
      cwd: "/repo/project",
      model: "grok-4.5",
      reasoningEffort: "medium",
    });

    expect(setRuntimeOption).toHaveBeenLastCalledWith({
      sessionId: "grok-session",
      source: "model",
      optionId: "model",
      value: "grok-4.5",
      reasoningEffort: "medium",
    });

    await registry.setThreadModelSettings({
      backend: acpBackendId,
      threadId: "grok-session",
      reasoningEffort: "low",
    });

    expect(setRuntimeOption).toHaveBeenLastCalledWith({
      sessionId: "grok-session",
      source: "model",
      optionId: "model",
      value: "grok-4.5",
      reasoningEffort: "low",
    });

    const turnStartupReachedEnsureSession = createDeferred<void>();
    const releaseTurnStartup = createDeferred<void>();
    acpClient.ensureSession.mockImplementationOnce(async () => {
      turnStartupReachedEnsureSession.resolve();
      await releaseTurnStartup.promise;
    });
    const turnPromise = registry.startTurn({
      backend: acpBackendId,
      threadId: "grok-session",
      input: [{ type: "text", text: "start work" }],
    });
    await turnStartupReachedEnsureSession.promise;

    const settingsPromise = registry.setThreadModelSettings({
      backend: acpBackendId,
      threadId: "grok-session",
      reasoningEffort: "high",
    });
    await flushAsync();
    expect(acpClient.startPrompt).not.toHaveBeenCalled();

    releaseTurnStartup.resolve();
    const turn = await turnPromise;
    const runtimeUpdatesAfterPromptStarted = setRuntimeOption.mock.calls.length;
    await settingsPromise;

    expect(acpClient.startPrompt).toHaveBeenCalledTimes(1);
    expect(setRuntimeOption).toHaveBeenCalledTimes(
      runtimeUpdatesAfterPromptStarted,
    );

    // This fixture owns the turn's terminal and branch adoption too. Drain
    // them before close starts its shutdown deadline.
    await emitCompletedTurn(registry, acpBackendId, "grok-session", turn.turnId);
    await registry.close();
    expect(acpClient.cancelSession).not.toHaveBeenCalled();
  });

  describe("Kimi turn-start model writes", () => {
    // Measured on Kimi Code 2.0.0: a session keeps its thinking level across
    // a model switch, and ignores a level its model does not offer. Either way
    // the level it records never matches the composer's, so a comparison that
    // counts it re-sends the model on every turn.
    const k27 = "kimi-code/kimi-for-coding";
    const k3 = "kimi-code/k3";
    const sessionId = "kimi-session-1";

    function createThinkingRegistry(params: {
      recorded: { model: string; thinking: string };
      offersThoughtLevel?: (sessionId: string, level: string) => boolean;
    }) {
      const acpBackendId = "acp:kimi" as AcpBackendId;
      return createKimiAcpRegistry({
        acpBackendId,
        offersThoughtLevel: params.offersThoughtLevel,
        runtimeCapabilities: {
          schemaVersion: 1,
          status: "discovered",
          source: "session-load",
          configOptions: [
            {
              id: "model",
              label: "Model",
              type: "select",
              category: "model",
              currentValue: params.recorded.model,
              values: [{ value: k27 }, { value: k3 }],
            },
            {
              id: "thinking",
              label: "Thinking",
              type: "select",
              category: "thought_level",
              currentValue: params.recorded.thinking,
              values: [
                { value: "low" },
                { value: "high" },
                { value: "max" },
                { value: "on" },
              ],
            },
          ],
          models: {
            currentModelId: params.recorded.model,
            availableModels: [
              { id: k27, label: "K2.7 Coding", supportsReasoning: false },
              {
                id: k3,
                label: "K3",
                supportsReasoning: true,
                // Discovery's catalog pollution: K3 does not offer `on`.
                reasoningEfforts: ["low", "high", "max", "on"],
                defaultReasoningEffort: "high",
              },
            ],
          },
        },
        sessions: [
          {
            backendId: acpBackendId,
            sessionId,
            title: "Breakfast plans",
            cwd: "/repo/app",
            createdAt: 1000,
            updatedAt: 2000,
            executionMode: "default",
            status: "idle",
            acpRuntime: {
              configValues: {
                model: params.recorded.model,
                thinking: params.recorded.thinking,
              },
              reasoningEffort: params.recorded.thinking,
              updatedAt: 2000,
            },
          },
        ],
      });
    }

    async function runTurns(
      registry: DesktopBackendRegistry,
      acpBackendId: AcpBackendId,
      settings: { model: string; reasoningEffort?: string },
      count: number,
    ): Promise<void> {
      for (let turn = 0; turn < count; turn += 1) {
        await registry.startTurn({
          backend: acpBackendId,
          threadId: sessionId,
          input: [{ type: "text", text: "Plan breakfast" }],
          ...settings,
        });
        await emitCompletedTurn(registry, acpBackendId, sessionId);
      }
    }

    it("does not re-send the model for a level kept from the previous model", async () => {
      const { acpBackendId, acpClient, registry } = createThinkingRegistry({
        recorded: { model: k27, thinking: "low" },
      });

      await runTurns(registry, acpBackendId, { model: k27 }, 2);

      expect(acpClient.startPrompt).toHaveBeenCalledTimes(2);
      expect(acpClient.setRuntimeOption).toHaveBeenCalledTimes(0);

      await registry.close();
    });

    it("does not re-send the model for a level the session does not offer", async () => {
      const offersThoughtLevel = vi.fn(
        (_sessionId: string, level: string) => level !== "on",
      );
      const { acpBackendId, acpClient, registry } = createThinkingRegistry({
        recorded: { model: k3, thinking: "high" },
        offersThoughtLevel,
      });

      await runTurns(registry, acpBackendId, { model: k3, reasoningEffort: "on" }, 2);

      expect(acpClient.startPrompt).toHaveBeenCalledTimes(2);
      expect(acpClient.setRuntimeOption).toHaveBeenCalledTimes(0);
      expect(offersThoughtLevel).toHaveBeenCalledWith(sessionId, "on");

      await registry.close();
    });

    it("still writes a level when the session's menu is unknown", async () => {
      // No menu has been reported for this session yet, so nothing can prove
      // the write is a no-op. The client answers for a level it may yet apply.
      const { acpBackendId, acpClient, registry } = createThinkingRegistry({
        recorded: { model: k3, thinking: "high" },
      });

      await runTurns(registry, acpBackendId, { model: k3, reasoningEffort: "on" }, 2);

      expect(acpClient.setRuntimeOption).toHaveBeenCalledTimes(2);

      await registry.close();
    });

    it("still writes a level the session offers", async () => {
      const { acpBackendId, acpClient, registry } = createThinkingRegistry({
        recorded: { model: k3, thinking: "high" },
        offersThoughtLevel: (_sessionId, level) => level !== "on",
      });

      await runTurns(registry, acpBackendId, { model: k3, reasoningEffort: "max" }, 1);

      expect(acpClient.setRuntimeOption).toHaveBeenCalledTimes(1);
      expect(acpClient.setRuntimeOption).toHaveBeenCalledWith({
        sessionId,
        source: "model",
        optionId: "model",
        value: k3,
        reasoningEffort: "max",
      });

      await registry.close();
    });
  });

  it("runs Kimi ACP execution mode changes through slash control prompts", async () => {
    const sessions: AcpSessionMetadata[] = [];
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const sendControlPrompt = vi
      .fn()
      .mockResolvedValueOnce({
        text: "You only live once! All actions will be auto-approved.",
      })
      .mockResolvedValueOnce({
        text: "You only die once! Actions will require approval.",
      });
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async (params: {
        cwd?: string;
        executionMode: "default" | "auto" | "full-access";
      }) => {
        const metadata: AcpSessionMetadata = {
          backendId: acpBackendId,
          sessionId: "kimi-session-1",
          title: "Untitled thread",
          cwd: params.cwd,
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: params.executionMode,
          status: "idle",
        };
        sessions.push(metadata);
        return metadata;
      }),
      startPrompt: vi.fn(),
      sendControlPrompt,
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(async (): Promise<AppServerThreadReplay> => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
    };
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "kimi",
          name: "Kimi Code CLI",
          version: "1.44.0",
          distributionKind: "local",
          distributionSource: "kimi acp",
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
            args: ["acp"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    const backends = await registry.listBackends({ includeUnavailable: true });
    expect(backends.backends.find((backend) => backend.kind === acpBackendId))
      .toMatchObject({
        executionModes: [
          { mode: "default", available: true },
          { mode: "full-access", available: true },
        ],
      });

    await expect(
      registry.startThread({
        backend: acpBackendId,
        cwd: "/repo/project",
        executionMode: "full-access",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      executionMode: "full-access",
    });

    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "kimi-session-1",
      prompt: "/yolo",
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: acpBackendId,
        threadId: "kimi-session-1",
      }),
    ).resolves.toMatchObject({
      executionMode: "full-access",
    });

    sendControlPrompt.mockClear();
    await expect(
      registry.setThreadExecutionMode({
        backend: acpBackendId,
        threadId: "kimi-session-1",
        executionMode: "default",
      }),
    ).resolves.toEqual({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      executionMode: "default",
    });
    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "kimi-session-1",
      prompt: "/yolo",
    });
    expect(sessions[0]?.executionMode).toBe("default");
    await expect(
      overlayStore.getThreadOverlayState({
        backend: acpBackendId,
        threadId: "kimi-session-1",
      }),
    ).resolves.toMatchObject({
      executionMode: "default",
    });

    await registry.close();
  });

  it.each(["kimi", "grok"])("uses the native %s permission selector without legacy slash commands", async (registryId) => {
    const sessions: AcpSessionMetadata[] = [];
    const acpBackendId = `acp:${registryId}` as AcpBackendId;
    const optionId = registryId === "grok" ? "permission_mode" : "approval-mode";
    const sendControlPrompt = vi.fn(async () => ({ text: "" }));
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async (params: { cwd?: string; executionMode: "default" | "auto" | "full-access" }) => {
        const metadata: AcpSessionMetadata = {
          backendId: acpBackendId,
          sessionId: "native-permission-session",
          title: "Untitled thread",
          cwd: params.cwd,
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: params.executionMode,
          status: "idle",
        };
        sessions.push(metadata);
        return metadata;
      }),
      startPrompt: vi.fn(),
      sendControlPrompt,
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(async (): Promise<AppServerThreadReplay> => ({
        entries: [],
        messages: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
        threadStatus: "idle",
      })),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      setRuntimeOption: vi.fn(
        async (): Promise<BackendAcpSessionRuntimeState> => ({
          configValues: { [optionId]: "yolo" },
          currentModeId: registryId === "grok" ? "default" : "yolo",
          updatedAt: 2000,
        }),
      ),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
        threadStatus: "idle",
      })),
    };
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId,
          name: registryId,
          version: "1.44.0",
          distributionKind: "local",
          distributionSource: `${registryId} acp`,
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: `local-${registryId}-cli`,
          installedAt: 1000,
          updatedAt: 2000,
          runtimeCapabilities: {
            schemaVersion: 1,
            status: "discovered",
            checkedAt: 1000,
            configOptions: [
              {
                id: optionId,
                label: "Permission mode",
                type: "select",
                category: "mode",
                currentValue: "default",
                values: [
                  { value: "default", label: "Default" },
                  { value: "auto", label: "Auto" },
                  { value: "yolo", label: "Yolo" },
                ],
              },
            ],
          },
          launchDescriptor: {
            backendId: acpBackendId,
            registryId,
            distributionKind: "local",
            command: registryId,
            args: ["acp"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    // The hardcoded Default/Full Access modes are gone — only the runtime
    // modes remain (one dropdown in the UI).
    const backends = await registry.listBackends({ includeUnavailable: true });
    expect(
      backends.backends.find((backend) => backend.kind === acpBackendId)
        ?.executionModes,
    ).toEqual([]);

    // A stored Full Access selection must not drive the legacy slash path.
    await registry.startThread({
      backend: acpBackendId,
      cwd: "/repo/project",
      executionMode: "full-access",
    });
    await registry.setThreadExecutionMode({
      backend: acpBackendId,
      threadId: "native-permission-session",
      executionMode: "default",
    });
    await registry.setAcpSessionRuntimeOption({
      backend: acpBackendId,
      threadId: "native-permission-session",
      source: "configOption",
      optionId,
      value: "yolo",
    });
    expect(sendControlPrompt).not.toHaveBeenCalled();
    expect(acpClient.setRuntimeOption).toHaveBeenCalledWith({
      sessionId: "native-permission-session",
      source: "configOption",
      optionId,
      value: "yolo",
      rejectUnofferedThoughtLevel: true,
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: acpBackendId,
        threadId: "native-permission-session",
      }),
    ).resolves.toMatchObject({
      executionMode: "full-access",
    });

    acpClient.setRuntimeOption.mockResolvedValueOnce({
      configValues: { [optionId]: "auto" },
      currentModeId: registryId === "grok" ? "default" : "auto",
      updatedAt: 3000,
    });
    await registry.setAcpSessionRuntimeOption({
      backend: acpBackendId,
      threadId: "native-permission-session",
      source: "configOption",
      optionId,
      value: "auto",
    });
    expect(sendControlPrompt).not.toHaveBeenCalled();
    expect(sessions[0]?.acpRuntime?.currentModeId).toBe(registryId === "grok" ? "default" : "auto");
    expect(sessions[0]?.acpRuntime?.configValues?.[optionId]).toBe("auto");
    await expect(
      overlayStore.getThreadOverlayState({
        backend: acpBackendId,
        threadId: "native-permission-session",
      }),
    ).resolves.toMatchObject({ executionMode: "default" });

    acpClient.setRuntimeOption.mockResolvedValueOnce({
      configValues: { [optionId]: "default" },
      currentModeId: "default",
      updatedAt: 4000,
    });
    await registry.setAcpSessionRuntimeOption({
      backend: acpBackendId,
      threadId: "native-permission-session",
      source: "configOption",
      optionId,
      value: "default",
    });
    expect(acpClient.setRuntimeOption).toHaveBeenLastCalledWith({
      sessionId: "native-permission-session",
      source: "configOption",
      optionId,
      value: "default",
      rejectUnofferedThoughtLevel: true,
    });
    expect(sessions[0]?.acpRuntime?.configValues?.[optionId]).toBe("default");

    await registry.close();
  });

  it.each(["default", "plan"])("restores Grok Auto independently of inherited %s planning mode", async (planningMode) => {
    const backend = "acp:grok" as AcpBackendId;
    const runtimeCapabilities: BackendAcpRuntimeCapabilities = {
      schemaVersion: 1,
      status: "discovered",
      modes: {
        currentModeId: planningMode,
        availableModes: [{ id: "default", label: "Default" }, { id: "plan", label: "Plan" }],
      },
      configOptions: [{
        id: "permission_mode",
        label: "Permissions",
        category: "mode",
        type: "select",
        currentValue: "default",
        values: [
          { value: "default", label: "Default Access" },
          { value: "auto", label: "Auto" },
          { value: "yolo", label: "Full Access" },
        ],
      }],
    };
    const { registry, acpClient, sendControlPrompt } = createKimiAcpRegistry({
      acpBackendId: backend,
      installedAgent: {
        ...createKimiAgentRecord(backend, runtimeCapabilities),
        registryId: "grok",
        name: "Grok",
      },
    });
    await registry.startThread({
      backend,
      cwd: "/repo/project",
      acpRuntime: {
        currentModeId: planningMode,
        configValues: { permission_mode: "auto" },
        updatedAt: 1000,
      },
    });
    expect(acpClient.setRuntimeOption.mock.calls).toEqual([[{
      sessionId: "kimi-session-1",
      source: "configOption",
      optionId: "permission_mode",
      value: "auto",
      sessionStartMode: true,
    }], [{
      sessionId: "kimi-session-1",
      source: "mode",
      optionId: "mode",
      value: planningMode,
      sessionStartMode: true,
    }]]);
    expect(sendControlPrompt).not.toHaveBeenCalled();
    await registry.close();
  });

  // A native mode below Full Access records the thread at Default Access
  // (thread-todo-access's recordedNativeMode). The start can lower the native
  // mode when the new session does not list Yolo.
  it.each([
    { sessionPermission: "auto", recorded: "default" },
    { sessionPermission: "yolo", recorded: "full-access" },
  ] as const)("records $recorded when a Grok Full Access start applies $sessionPermission", async ({ sessionPermission, recorded }) => {
    const backend = "acp:grok" as AcpBackendId;
    const runtimeCapabilities: BackendAcpRuntimeCapabilities = {
      schemaVersion: 1,
      status: "discovered",
      configOptions: [{
        id: "permission_mode",
        label: "Permissions",
        category: "mode",
        type: "select",
        currentValue: "default",
        values: [
          { value: "default", label: "Default Access" },
          { value: "auto", label: "Auto" },
          { value: "yolo", label: "Full Access" },
        ],
      }],
    };
    const sessions: AcpSessionMetadata[] = [];
    const { registry, acpClient } = createKimiAcpRegistry({
      acpBackendId: backend,
      sessions,
      installedAgent: {
        ...createKimiAgentRecord(backend, runtimeCapabilities),
        registryId: "grok",
        name: "Grok",
      },
    });
    // The client records the permission the session applied: `auto` when
    // the new session's own reply lists no `yolo`.
    acpClient.setRuntimeOption.mockImplementation(async (params: { sessionId: string }) => {
      const session = sessions.find((candidate) => candidate.sessionId === params.sessionId)!;
      session.acpRuntime = {
        ...session.acpRuntime,
        configValues: { ...session.acpRuntime?.configValues, permission_mode: sessionPermission },
        updatedAt: 1001,
      };
      return session.acpRuntime;
    });
    const response = await registry.startThread({
      backend,
      cwd: "/repo/project",
      executionMode: "full-access",
      acpRuntime: { configValues: { permission_mode: "yolo" }, updatedAt: 1000 },
    });
    expect(response.executionMode).toBe(recorded);
    expect(sessions[0]?.executionMode).toBe(recorded);
    await registry.close();
  });

  it.each([false, true])("runs Grok slash permission controls with planning modes advertised=%s", async (planningModes) => {
    // Regression test for the Grok-ACP Full Access bug: creating a Grok
    // thread with executionMode="full-access" must persist that mode to
    // session metadata AND surface it via listThreads, so the chip and
    // composer dropdown both read "Full Access" right after thread
    // creation. The slash command itself is fire-and-forget — Grok
    // returns no text confirmation, unlike Kimi's /yolo — so we trust a
    // clean resolve from sendControlPrompt.
    const sessions: AcpSessionMetadata[] = [];
    const acpBackendId = "acp:grok" as AcpBackendId;
    const sendControlPrompt = vi
      .fn(async () => ({ text: "" }));
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async (params: {
        cwd?: string;
        executionMode: "default" | "auto" | "full-access";
      }) => {
        const metadata: AcpSessionMetadata = {
          backendId: acpBackendId,
          sessionId: "grok-session-1",
          title: "Untitled thread",
          cwd: params.cwd,
          createdAt: 1000,
          updatedAt: 1000,
          // Slash-controlled backends start the agent in "default" and
          // immediately flip via the slash command — so the seed mode
          // here is whatever startAcpSession passes, NOT the
          // user-requested target.
          executionMode: params.executionMode,
          ...(planningModes ? { acpRuntime: { currentModeId: "plan", updatedAt: 1000 } } : {}),
          status: "idle",
        };
        sessions.push(metadata);
        return metadata;
      }),
      startPrompt: vi.fn(),
      setRuntimeOption: vi.fn(async (): Promise<BackendAcpSessionRuntimeState> => ({
        currentModeId: "default",
        updatedAt: 2000,
      })),
      sendControlPrompt,
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(async (): Promise<AppServerThreadReplay> => ({
        entries: [],
        messages: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
        threadStatus: "idle",
      })),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
        threadStatus: "idle",
      })),
    };
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "grok",
          name: "Grok",
          version: "0.2.3",
          ...(planningModes ? {
            runtimeCapabilities: {
              schemaVersion: 1 as const,
              status: "discovered" as const,
              modes: {
                currentModeId: "default",
                availableModes: [{ id: "default", label: "Default" }, { id: "plan", label: "Plan" }],
              },
            },
          } : {}),
          distributionKind: "local",
          distributionSource: "grok agent stdio",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-grok-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "grok",
            distributionKind: "local",
            command: "grok",
            args: ["agent", "stdio"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    const backends = await registry.listBackends({ includeUnavailable: true });
    expect(backends.backends.find((backend) => backend.kind === acpBackendId))
      .toMatchObject({
        executionModes: [
          { mode: "default", available: true },
          { mode: "full-access", available: true },
        ],
      });

    const startResponse = await registry.startThread({
      backend: acpBackendId,
      cwd: "/repo/project",
      executionMode: "full-access",
    });
    expect(startResponse).toMatchObject({
      backend: acpBackendId,
      threadId: "grok-session-1",
      executionMode: "full-access",
    });

    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "grok-session-1",
      prompt: "/always-approve on",
    });
    expect(sessions[0]?.executionMode).toBe("full-access");
    await expect(
      overlayStore.getThreadOverlayState({
        backend: acpBackendId,
        threadId: "grok-session-1",
      }),
    ).resolves.toMatchObject({
      executionMode: "full-access",
    });

    // This is the assertion the user-reported bug fails on: listThreads
    // must surface the just-applied "full-access" mode so the renderer
    // chip + composer dropdown both reflect the user's choice the moment
    // the thread opens.
    const threads = await registry.listThreads({ backend: acpBackendId });
    const thread = threads.find(
      (candidate) => candidate.id === "grok-session-1",
    );
    expect(thread).toBeDefined();
    expect(thread?.executionMode).toBe("full-access");

    if (planningModes) {
      await registry.setAcpSessionRuntimeOption({
        backend: acpBackendId,
        threadId: "grok-session-1",
        source: "mode",
        optionId: "mode",
        value: "default",
      });
      expect(sessions[0]?.executionMode).toBe("full-access");
      await expect(overlayStore.getThreadOverlayState({
        backend: acpBackendId,
        threadId: "grok-session-1",
      })).resolves.toMatchObject({ executionMode: "full-access" });
    }

    const permissionEvents: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      permissionEvents.push(event);
    });
    const handlePermissionRequest = (
      registry as unknown as {
        handleServerRequest(
          backend: AcpBackendId,
          request: AppServerPendingRequestNotification,
        ): Promise<unknown>;
      }
    ).handleServerRequest.bind(registry);
    const permissionRequest: AppServerPendingRequestNotification = {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "grok-session-1",
        turnId: "turn-1",
        requestId: "approval-1",
        acpMethod: "session/request_permission",
        command: "pnpm build",
      },
    };
    await expect(
      handlePermissionRequest(acpBackendId, permissionRequest),
    ).resolves.toEqual({ decision: "approve" });
    expect(permissionEvents).toEqual([]);

    sendControlPrompt.mockClear();
    await expect(
      registry.setThreadExecutionMode({
        backend: acpBackendId,
        threadId: "grok-session-1",
        executionMode: "default",
      }),
    ).resolves.toEqual({
      backend: acpBackendId,
      threadId: "grok-session-1",
      executionMode: "default",
    });
    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "grok-session-1",
      prompt: "/always-approve off",
    });
    expect(sessions[0]?.executionMode).toBe("default");
    await expect(
      overlayStore.getThreadOverlayState({
        backend: acpBackendId,
        threadId: "grok-session-1",
      }),
    ).resolves.toMatchObject({
      executionMode: "default",
    });

    permissionEvents.length = 0;
    const defaultResponse = handlePermissionRequest(
      acpBackendId,
      permissionRequest,
    );
    await waitForCondition(() =>
      permissionEvents.some(
        (event) =>
          event.notification.method === "item/commandExecution/requestApproval",
      ),
    );
    expect(permissionEvents).toContainEqual({
      backend: acpBackendId,
      notification: permissionRequest,
    });
    await registry.submitServerRequest({
      backend: acpBackendId,
      threadId: "grok-session-1",
      requestId: "approval-1",
      response: { decision: "approve" },
    });
    await expect(defaultResponse).resolves.toEqual({ decision: "approve" });

    unsubscribe();
    await registry.close();
  });

  it("does not persist Kimi execution mode when /yolo confirms the wrong state", async () => {
    const { acpBackendId, registry, sendControlPrompt, sessions } =
      createKimiAcpRegistry({
        sessions: [
          {
            backendId: "acp:kimi" as AcpBackendId,
            sessionId: "kimi-session-1",
            title: "Untitled thread",
            createdAt: 1000,
            updatedAt: 1000,
            executionMode: "default",
            status: "idle",
          },
        ],
        sendControlPrompt: vi.fn(async () => ({
          text: "You only die once! Actions will require approval.",
        })),
      });

    await expect(
      registry.setThreadExecutionMode({
        backend: acpBackendId,
        threadId: "kimi-session-1",
        executionMode: "full-access",
      }),
    ).rejects.toThrow(/did not confirm Full Access/);

    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "kimi-session-1",
      prompt: "/yolo",
    });
    expect(sessions[0]?.executionMode).toBe("default");

    await registry.close();
  });

  it("keeps the ACP client receiver when sending Kimi /yolo prompts", async () => {
    const sendControlPrompt = vi.fn(function (
      this: { controlPromptReceiverMarker?: boolean } | undefined,
    ) {
      if (this?.controlPromptReceiverMarker !== true) {
        throw new Error("lost ACP client receiver");
      }
      return Promise.resolve({
        text: "You only live once! All actions will be auto-approved.",
      });
    });
    const { acpBackendId, registry } = createKimiAcpRegistry({
      sendControlPrompt,
    });

    await expect(
      registry.startThread({
        backend: acpBackendId,
        cwd: "/repo/project",
        executionMode: "full-access",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      executionMode: "full-access",
    });

    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "kimi-session-1",
      prompt: "/yolo",
    });

    await registry.close();
  });

  it("auto-approves ACP permission requests for Yolo runtime sessions", async () => {
    const acpBackendId = "acp:qwen" as AcpBackendId;
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "qwen",
          name: "Qwen Code",
          distributionKind: "local",
          distributionSource: "qwen --experimental-acp",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-qwen-cli",
          installedAt: 1000,
          updatedAt: 2000,
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock([
        {
          backendId: acpBackendId,
          sessionId: "qwen-session-1",
          title: "Qwen thread",
          cwd: "/repo/project",
          createdAt: 1000,
          updatedAt: 2000,
          executionMode: "full-access",
          acpRuntime: {
            configValues: { mode: "yolo" },
            currentModeId: "yolo",
            updatedAt: 2000,
          },
          status: "active",
        },
      ]),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    const response = await (
      registry as unknown as {
        handleServerRequest(
          backend: AcpBackendId,
          request: AppServerPendingRequestNotification,
        ): Promise<unknown>;
      }
    ).handleServerRequest(acpBackendId, {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "qwen-session-1",
        turnId: "turn-1",
        requestId: "approval-1",
        acpMethod: "session/request_permission",
        command: "pnpm build",
      },
    });

    expect(response).toEqual({ decision: "approve" });
    expect(events).toEqual([]);

    unsubscribe();
    await registry.close();
  });

  it.each(["qwen", "grok"])("keeps human approvals for requests escalated by %s Auto", async (registryId) => {
    const acpBackendId = `acp:${registryId}` as AcpBackendId;
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId,
          name: registryId,
          distributionKind: "local",
          distributionSource: `${registryId} acp`,
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: `local-${registryId}-cli`,
          installedAt: 1000,
          updatedAt: 2000,
          runtimeCapabilities: {
            schemaVersion: 1,
            status: "discovered",
            source: "session-load",
            discoveredAt: 1000,
            checkedAt: 1000,
            configOptions: [
              {
                id: "mode",
                label: "Mode",
                type: "select",
                category: "mode",
                currentValue: "default",
                values: [
                  { value: "default", label: "Default" },
                  { value: "auto", label: "Auto" },
                ],
              },
            ],
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock([
        {
          backendId: acpBackendId,
          sessionId: "auto-session-1",
          title: "Auto thread",
          cwd: "/repo/project",
          createdAt: 1000,
          updatedAt: 2000,
          executionMode: "default",
          acpRuntime: {
            configValues: { mode: "auto" },
            currentModeId: "auto",
            updatedAt: 2000,
          },
          status: "active",
        },
      ]),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    const request: AppServerPendingRequestNotification = {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "auto-session-1",
        turnId: "turn-1",
        requestId: "approval-1",
        acpMethod: "session/request_permission",
        command: "pnpm build",
      },
    };

    const responsePromise = (
      registry as unknown as {
        handleServerRequest(
          backend: AcpBackendId,
          request: AppServerPendingRequestNotification,
        ): Promise<unknown>;
      }
    ).handleServerRequest(acpBackendId, request);
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.notification.method === "item/commandExecution/requestApproval",
      ),
    );

    expect(events).toContainEqual({
      backend: acpBackendId,
      notification: request,
    });
    await registry.submitServerRequest({
      backend: acpBackendId,
      threadId: "auto-session-1",
      requestId: "approval-1",
      response: { decision: "approve" },
    });
    await expect(responsePromise).resolves.toEqual({ decision: "approve" });

    unsubscribe();
    await registry.close();
  });

  it("queues Kimi ACP execution mode changes during active turns and flushes once", async () => {
    const events: AgentEvent[] = [];
    const { acpBackendId, registry, sendControlPrompt, sessions } =
      createKimiAcpRegistry({
        sessions: [
          {
            backendId: "acp:kimi" as AcpBackendId,
            sessionId: "kimi-session-1",
            title: "Untitled thread",
            createdAt: 1000,
            updatedAt: 1000,
            executionMode: "default",
            status: "idle",
          },
        ],
        sendControlPrompt: vi.fn(async () => ({
          text: "You only live once! All actions will be auto-approved.",
        })),
      });
    registry.onEvent((event) => {
      events.push(event);
    });

    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "kimi-session-1",
        executionMode: "default",
      }),
    ]);

    await registry.startTurn({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      input: [{ type: "text", text: "work" }],
    });

    await expect(
      registry.setThreadExecutionMode({
        backend: acpBackendId,
        threadId: "kimi-session-1",
        executionMode: "full-access",
      }),
    ).resolves.toEqual({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      executionMode: "full-access",
    });
    expect(sendControlPrompt).not.toHaveBeenCalled();

    await (registry as unknown as { emit(event: AgentEvent): Promise<void> }).emit({
      backend: acpBackendId,
      notification: {
        method: "turn/completed",
        params: {
          threadId: "kimi-session-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [],
          },
        },
      },
    });
    await vi.waitFor(() => {
      expect(sendControlPrompt).toHaveBeenCalledWith({
        sessionId: "kimi-session-1",
        prompt: "/yolo",
      });
      expect(sessions[0]?.executionMode).toBe("full-access");
    });

    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "kimi-session-1",
        executionMode: "full-access",
      }),
    ]);
    const methods = events.map((event) => event.notification.method);
    expect(methods).toContain("thread/executionMode/queued");
    expect(methods).toContain("thread/executionMode/updated");
    expect(methods).toContain("thread/executionMode/queueCleared");

    await registry.close();
  });

  it("serializes Kimi control prompts before starting the next ACP turn", async () => {
    const controlPrompt = createDeferred<{ text: string }>();
    const startPrompt = vi.fn(() => ({
      sessionId: "kimi-session-1",
      turnId: "turn-1",
    }));
    const sendControlPrompt = vi.fn(() => controlPrompt.promise);
    const { acpBackendId, registry } = createKimiAcpRegistry({
      sessions: [
        {
          backendId: "acp:kimi" as AcpBackendId,
          sessionId: "kimi-session-1",
          title: "Untitled thread",
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: "default",
          status: "idle",
        },
      ],
      sendControlPrompt,
      startPrompt,
    });

    const modeChange = registry.setThreadExecutionMode({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      executionMode: "full-access",
    });
    await vi.waitFor(() => {
      expect(sendControlPrompt).toHaveBeenCalledTimes(1);
    });
    const turnStart = registry.startTurn({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      input: [{ type: "text", text: "after mode change" }],
    });
    await flushAsync();
    expect(startPrompt).not.toHaveBeenCalled();

    controlPrompt.resolve({
      text: "You only live once! All actions will be auto-approved.",
    });
    await expect(modeChange).resolves.toMatchObject({
      backend: acpBackendId,
      executionMode: "full-access",
    });
    await expect(turnStart).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      turnId: "turn-1",
    });
    expect(startPrompt).toHaveBeenCalledTimes(1);

    await registry.close();
  });

  it("preserves ACP launchpad model selections when starting sessions", async () => {
    const sessions: AcpSessionMetadata[] = [];
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const setRuntimeOption = vi.fn(
      async (params: {
        sessionId: string;
        source: BackendAcpRuntimeOptionSource;
        optionId: string;
        value: string;
      }): Promise<BackendAcpSessionRuntimeState> =>
        params.source === "model"
          ? { currentModelId: params.value, updatedAt: 1001 }
          : { configValues: { [params.optionId]: params.value }, updatedAt: 1001 },
    );
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async (params: {
        cwd?: string;
        executionMode: ThreadExecutionMode;
        title?: string;
        acpRuntime?: BackendAcpSessionRuntimeState;
      }) => {
        const metadata: AcpSessionMetadata = {
          backendId: acpBackendId,
          sessionId: "session-1",
          title: params.title ?? "Untitled thread",
          titleSource: params.title ? "explicit" : "fallback",
          cwd: params.cwd,
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: params.executionMode,
          acpRuntime: params.acpRuntime,
          status: "idle",
        };
        sessions.push(metadata);
        return metadata;
      }),
      startPrompt: vi.fn(),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
      setRuntimeOption,
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
          distributionSource: "gemini --acp",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          runtimeCapabilities: {
            schemaVersion: 1,
            status: "discovered",
            models: {
              currentModelId: "gemini-3-flash-preview",
              availableModels: [
                {
                  id: "gemini-3-flash-preview",
                  label: "Gemini 3 Flash Preview",
                },
                {
                  id: "gemini-3-pro-preview",
                  label: "Gemini 3 Pro Preview",
                },
              ],
            },
          },
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    await expect(
      registry.startThread({
        backend: acpBackendId,
        cwd: "/repo/project",
        executionMode: "default",
        model: "gemini-3-pro-preview",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "session-1",
    });

    expect(acpClient.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo/project",
        executionMode: "default",
        acpRuntime: expect.objectContaining({
          currentModelId: "gemini-3-pro-preview",
        }),
      }),
    );
    expect(setRuntimeOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      source: "model",
      optionId: "model",
      value: "gemini-3-pro-preview",
    });
    expect(sessions[0]?.acpRuntime).toMatchObject({
      currentModelId: "gemini-3-pro-preview",
    });

    await registry.close();
  });

  it("preserves Gemini Auto Edit for default access sessions", async () => {
    const sessions: AcpSessionMetadata[] = [];
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const setRuntimeOption = vi.fn(
      async (params: {
        sessionId: string;
        source: BackendAcpRuntimeOptionSource;
        optionId: string;
        value: string;
      }): Promise<BackendAcpSessionRuntimeState> =>
        params.source === "configOption"
          ? { configValues: { [params.optionId]: params.value }, updatedAt: 1001 }
          : { currentModeId: params.value, updatedAt: 1001 },
    );
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async (params: {
        cwd?: string;
        executionMode: "default" | "auto" | "full-access";
        title?: string;
        acpRuntime?: BackendAcpSessionRuntimeState;
      }) => {
        const metadata: AcpSessionMetadata = {
          backendId: acpBackendId,
          sessionId: "session-1",
          title: params.title ?? "Untitled thread",
          cwd: params.cwd,
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: params.executionMode,
          acpRuntime: params.acpRuntime,
          status: "idle",
        };
        sessions.push(metadata);
        return metadata;
      }),
      startPrompt: vi.fn(),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
      setRuntimeOption,
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
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    await registry.startThread({
      backend: acpBackendId,
      cwd: "/repo/project",
      executionMode: "default",
      acpRuntime: {
        configValues: { "approval-mode": "auto_edit" },
        currentModeId: "autoEdit",
      },
    });

    expect(acpClient.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "default",
        acpRuntime: {
          configValues: { "approval-mode": "auto_edit" },
          currentModeId: "autoEdit",
        },
      }),
    );
    expect(setRuntimeOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      source: "configOption",
      optionId: "approval-mode",
      value: "auto_edit",
    });
    expect(setRuntimeOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      source: "mode",
      optionId: "mode",
      value: "autoEdit",
      sessionStartMode: true,
    });
    expect(setRuntimeOption).not.toHaveBeenCalledWith(
      expect.objectContaining({ value: "default" }),
    );
    expect(sessions[0]?.acpRuntime).toEqual({
      configValues: { "approval-mode": "auto_edit" },
      currentModeId: "autoEdit",
    });

    await registry.close();
  });

  it("seeds empty launchpad defaults from the profile provider baseline", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
        models: [
          {
            id: "gpt-5.5",
            current: true,
            defaultReasoningEffort: "low",
            reasoningEfforts: ["low", "high"],
            supportsReasoning: true,
          },
          {
            id: "gpt-5.6-sol",
            defaultReasoningEffort: "low",
            reasoningEfforts: ["low", "high", "xhigh"],
            supportsReasoning: true,
          },
        ],
      }),
      overlayStore: createOverlayStoreMock(),
      resolveProviderModelDefaults: () => ({
        codex: {
          model: "gpt-5.6-sol",
          reasoningEffortsByModel: {
            "gpt-5.6-sol": "high",
          },
        },
      }),
    });

    const opened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });

    expect(opened.launchpad).toMatchObject({
      backend: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(opened.defaults.providerSettings?.codex).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });

    await registry.close();
  });

  it("refuses to start an endpoint with no model instead of falling back to OpenAI", async () => {
    const client = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] }, models: [{ id: "gpt-test" }],
    });
    const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore: createOverlayStoreMock() });
    try {
      await expect(registry.materializeDirectoryLaunchpad({
        directoryKey: "directory:/fixture",
        launchpad: {
          directoryKey: "directory:/fixture", directoryKind: "directory", directoryLabel: "Fixture",
          backend: "codex", codexModelProviderId: "mathos", executionMode: "auto",
          prompt: "fixture", workMode: "local", createdAt: 1, updatedAt: 1,
        },
      })).rejects.toThrow("No model is available for mathos");
      expect(client.lastStartThreadParams).toBeUndefined();
    } finally {
      await registry.close();
    }
  });

  it("keeps learned provider choices ahead of the profile baseline", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
        models: [
          {
            id: "gpt-5.5",
            defaultReasoningEffort: "low",
            reasoningEfforts: ["low", "high"],
            supportsReasoning: true,
          },
          {
            id: "gpt-5.6-sol",
            defaultReasoningEffort: "low",
            reasoningEfforts: ["low", "high", "xhigh"],
            supportsReasoning: true,
          },
        ],
      }),
      overlayStore: createOverlayStoreMock({
        launchpadDefaults: {
          backend: "codex",
          executionMode: "default",
          workMode: "local",
          model: "gpt-5.5",
          reasoningEffort: "low",
          providerSettings: {
            codex: {
              executionMode: "default",
              model: "gpt-5.5",
              reasoningEffort: "low",
            },
          },
        },
      }),
      resolveProviderModelDefaults: () => ({
        codex: {
          model: "gpt-5.6-sol",
          reasoningEffortsByModel: {
            "gpt-5.6-sol": "high",
          },
        },
      }),
    });

    const opened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });

    expect(opened.launchpad).toMatchObject({
      model: "gpt-5.5",
      reasoningEffort: "low",
    });

    await registry.close();
  });

  it("keeps an unavailable profile model suspended instead of learning the fallback", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
        models: [
          {
            id: "gpt-5.5",
            current: true,
            defaultReasoningEffort: "low",
            reasoningEfforts: ["low", "high"],
            supportsReasoning: true,
          },
        ],
      }),
      overlayStore,
      resolveProviderModelDefaults: () => ({
        codex: {
          model: "gpt-5.6-sol",
          reasoningEffortsByModel: {
            "gpt-5.6-sol": "high",
          },
        },
      }),
    });
    await discoverCodexBackendForTest(registry);

    const opened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });

    expect(opened.launchpad).toMatchObject({
      model: "gpt-5.5",
      reasoningEffort: "low",
    });
    const learnedDefaults = await overlayStore.getLaunchpadDefaults();
    expect(learnedDefaults.backend).toBe("codex");
    expect(learnedDefaults.model).toBeUndefined();
    expect(learnedDefaults.reasoningEffort).toBeUndefined();

    await registry.close();
  });

  it("keeps sticky model and permission settings scoped to the selected provider", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
        models: [
          {
            id: "gpt-5.4",
            label: "GPT-5.4",
            supportsFast: true,
            supportsReasoning: true,
          },
        ],
      }),
      overlayStore: createOverlayStoreMock({
        launchpadDefaults: {
          backend: "codex",
          executionMode: "full-access",
          workMode: "local",
          model: "gpt-5.4",
          reasoningEffort: "high",
          fastMode: true,
          providerSettings: {
            codex: {
              executionMode: "full-access",
              model: "gpt-5.4",
              reasoningEffort: "high",
              fastMode: true,
            },
          },
        },
      }),
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });
    const kimi = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { backend: "acp:kimi" as AcpBackendId },
      stickySettingsChanged: true,
    });

    expect(kimi.defaults).toMatchObject({
      backend: "acp:kimi",
      executionMode: "default",
    });
    expect(kimi.defaults.fastMode).toBeUndefined();
    expect(kimi.defaults.reasoningEffort).toBeUndefined();
    expect(kimi.launchpad).toMatchObject({
      backend: "acp:kimi",
      executionMode: "default",
    });
    expect(kimi.launchpad.fastMode).toBeUndefined();
    expect(kimi.launchpad.reasoningEffort).toBeUndefined();

    const codex = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { backend: "codex" },
      stickySettingsChanged: true,
    });

    expect(codex.defaults).toMatchObject({
      backend: "codex",
      executionMode: "full-access",
      fastMode: true,
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    expect(codex.launchpad).toMatchObject({
      backend: "codex",
      executionMode: "full-access",
      fastMode: true,
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    await registry.close();
  });

  it("saves a sticky model under the launchpad's provider, not the defaults' provider", async () => {
    const overlayStore = createOverlayStoreMock({
      launchpadDefaults: {
        backend: "claude",
        executionMode: "auto",
        workMode: "local",
        model: "opus",
        providerSettings: {
          claude: { executionMode: "auto", model: "opus" },
          codex: { executionMode: "auto", model: "gpt-5.4" },
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
        models: [
          { id: "gpt-5.4", label: "GPT-5.4", supportsReasoning: true },
          { id: "gpt-5.5", label: "GPT-5.5", supportsReasoning: true },
        ],
      }),
      overlayStore,
      claudeBackendOptions: {
        inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
        discoverModels: async () => [{ id: "opus", label: "Opus", current: true }],
      },
    });

    try {
      await registry.ensureDirectoryLaunchpad({
        directoryKey: "directory:/repo-a",
        directoryKind: "directory",
        directoryLabel: "Repo A",
        directoryPath: "/repo-a",
      });
      // Not sticky: this launchpad runs Codex while the defaults stay on Claude.
      await registry.updateDirectoryLaunchpad({
        directoryKey: "directory:/repo-a",
        patch: { backend: "codex" },
      });
      expect((await overlayStore.getLaunchpadDefaults()).backend).toBe("claude");

      await registry.updateDirectoryLaunchpad({
        directoryKey: "directory:/repo-a",
        patch: { model: "gpt-5.5" },
        stickySettingsChanged: true,
      });

      const stored = await overlayStore.getLaunchpadDefaults();
      expect(stored.providerSettings?.claude?.model).toBe("opus");
      expect(stored.providerSettings?.codex?.model).toBe("gpt-5.5");

      // A later sticky switch to Claude must not seed the Codex pick.
      const claude = await registry.updateDirectoryLaunchpad({
        directoryKey: "directory:/repo-b",
        patch: { backend: "claude" },
        stickySettingsChanged: true,
      });
      expect(claude.defaults).toMatchObject({ backend: "claude", model: "opus" });
    } finally {
      await registry.close();
    }
  });

  it("restores sticky launchpad reasoning when switching back to a model", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
        models: [
          {
            id: "gpt-5.6-terra",
            label: "GPT-5.6-Terra",
            defaultReasoningEffort: "medium",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
            supportsReasoning: true,
          },
          {
            id: "gpt-5.6-luna",
            label: "GPT-5.6-Luna",
            defaultReasoningEffort: "medium",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            supportsReasoning: true,
          },
        ],
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });
    const terraUltra = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { model: "gpt-5.6-terra", reasoningEffort: "ultra" },
      stickySettingsChanged: true,
    });
    const luna = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { model: "gpt-5.6-luna" },
      stickySettingsChanged: true,
    });
    const terraRestored = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { model: "gpt-5.6-terra" },
      stickySettingsChanged: true,
    });

    expect(terraUltra.launchpad.reasoningEffort).toBe("ultra");
    expect(luna.launchpad.reasoningEffort).toBe("medium");
    expect(terraRestored.launchpad.reasoningEffort).toBe("ultra");
    expect(terraRestored.defaults.reasoningEffort).toBe("ultra");
    expect(
      terraRestored.defaults.providerSettings?.codex?.reasoningEffortsByModel,
    ).toMatchObject({
      "gpt-5.6-luna": "medium",
      "gpt-5.6-terra": "ultra",
    });

    await registry.close();
  });

  it("restores thread reasoning when switching back to a model", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
        models: [
          {
            id: "gpt-5.6-sol",
            label: "GPT-5.6-Sol",
            defaultReasoningEffort: "medium",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
            supportsReasoning: true,
          },
          {
            id: "gpt-5.6-luna",
            label: "GPT-5.6-Luna",
            defaultReasoningEffort: "medium",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            supportsReasoning: true,
          },
        ],
      }),
      overlayStore,
    });

    const solUltra = await registry.setThreadModelSettings({
      backend: "codex",
      threadId: "thread-1",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });
    const luna = await registry.setThreadModelSettings({
      backend: "codex",
      threadId: "thread-1",
      model: "gpt-5.6-luna",
    });
    const solRestored = await registry.setThreadModelSettings({
      backend: "codex",
      threadId: "thread-1",
      model: "gpt-5.6-sol",
    });
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(solUltra.reasoningEffort).toBe("ultra");
    expect(luna.reasoningEffort).toBe("medium");
    expect(solRestored.reasoningEffort).toBe("ultra");
    expect(overlay?.reasoningEffortsByModel).toMatchObject({
      "gpt-5.6-luna": "medium",
      "gpt-5.6-sol": "ultra",
    });

    await registry.close();
  });

  it.each(["overlay", "provider"])("keeps GPT-6.1-Sol high from the %s when switching to GPT-6.2-Sol", async (settingsSource) => {
    const source = "gpt-6.1-sol";
    const destination = "gpt-6.2-sol";
    const overlayStore = createOverlayStoreMock();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
      models: [source, destination].map((id) => ({
        id,
        defaultReasoningEffort: "low",
        reasoningEfforts: ["low", "high"],
        supportsReasoning: true,
      })),
    });
    const readThreadModelSettings = vi.fn(async () => ({ model: source, reasoningEffort: "high" }));
    Object.assign(codexClient, { readThreadModelSettings });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    const thread = { backend: "codex" as const, threadId: "existing" };
    try {
      if (settingsSource === "overlay") {
        await registry.setThreadModelSettings({ ...thread, model: source, reasoningEffort: "high" });
      }
      await expect(registry.setThreadModelSettings({ ...thread, model: destination }))
        .resolves.toMatchObject({ model: destination, reasoningEffort: "high" });
      expect(await overlayStore.getThreadOverlayState(thread)).toMatchObject({
        model: destination,
        reasoningEffort: "high",
      });
      if (settingsSource === "provider") {
        expect(readThreadModelSettings).toHaveBeenCalledExactlyOnceWith({ threadId: thread.threadId });
      } else {
        expect(readThreadModelSettings).not.toHaveBeenCalled();
      }
    } finally {
      await registry.close();
    }
  });

  it("chooses the first supported effort from the thread's destination memory, profile default, and current effort", async () => {
    const source = "gpt-6.1-sol";
    const destination = "gpt-6.2-sol";
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("medium", "high", "xhigh"),
      fc.option(fc.constantFrom("medium", "high", "xhigh"), { nil: undefined }),
      fc.option(fc.constantFrom("medium", "high"), { nil: undefined }),
      async (current, configured, remembered) => {
        const reasoningEffortsByModel: Record<string, string> = {};
        if (configured) reasoningEffortsByModel[destination] = configured;
        const registry = createDesktopBackendRegistry({
          codexClient: new MockBackendClient({
            initializeResult: { methods: ["thread/start"] },
            models: [
              { id: source, defaultReasoningEffort: "low", reasoningEfforts: ["low", "medium", "high", "xhigh"], supportsReasoning: true },
              { id: destination, defaultReasoningEffort: "low", reasoningEfforts: ["low", "medium", "high"], supportsReasoning: true },
            ],
          }),
          overlayStore: createOverlayStoreMock(),
          resolveProviderModelDefaults: () => ({
            codex: { model: destination, reasoningEffortsByModel },
          }),
        });
        const thread = { backend: "codex" as const, threadId: "existing" };
        try {
          if (remembered) {
            await registry.setThreadModelSettings({ ...thread, model: destination, reasoningEffort: remembered });
          }
          await registry.setThreadModelSettings({ ...thread, model: source, reasoningEffort: current });
          const expected = remembered
            ?? (configured === "xhigh" ? undefined : configured)
            ?? (current === "xhigh" ? "low" : current);
          await expect(registry.setThreadModelSettings({ ...thread, model: destination }))
            .resolves.toMatchObject({ model: destination, reasoningEffort: expected });
        } finally {
          await registry.close();
        }
      },
    ), { numRuns: 30 });
  });

  it("preserves a supported Claude effort when switching models", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("high", "medium"), async (effort) => {
      const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({}), overlayStore: createOverlayStoreMock() });
      const { claudeBackend } = registry as unknown as { claudeBackend: ClaudeBackend };
      const models = ["sonnet", "opus"].map((id) => ({
        id, defaultReasoningEffort: "low", reasoningEfforts: ["low", "medium", "high"], supportsReasoning: true,
      }));
      vi.spyOn(claudeBackend, "summary").mockReturnValue({
        ...claudeBackend.summary(), launchpadOptions: { models },
      });
      const thread = { backend: "claude" as const, threadId: "existing" };
      try {
        await registry.setThreadModelSettings({ ...thread, model: "sonnet", reasoningEffort: effort });
        await expect(registry.setThreadModelSettings({ ...thread, model: "opus" }))
          .resolves.toMatchObject({ model: "opus", reasoningEffort: effort });
      } finally {
        await registry.close();
      }
    }), { numRuns: 10 });
  });

  it("carries a compatible ACP session thought level into the model change", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("high", "medium"), async (effort) => {
      const backend = "acp:grok" as const;
      const threadId = "grok-thread";
      const source = "grok-current";
      const destination = "grok-next";
      const { registry, acpClient } = createKimiAcpRegistry({
        acpBackendId: backend,
        sessionId: threadId,
        sessions: [{
          backendId: backend, sessionId: threadId, title: "Fixture", status: "idle",
          executionMode: "default", createdAt: 1, updatedAt: 1,
          acpRuntime: { currentModelId: source, reasoningEffort: effort, updatedAt: 1 },
        }],
        runtimeCapabilities: {
          schemaVersion: 1, status: "discovered",
          models: {
            currentModelId: source,
            availableModels: [source, destination].map((id) => ({
              id, label: id, defaultReasoningEffort: "low",
              reasoningEfforts: ["low", "medium", "high"], supportsReasoning: true,
            })),
          },
        },
      });
      try {
        await expect(registry.setThreadModelSettings({ backend, threadId, model: destination }))
          .resolves.toMatchObject({ model: destination, reasoningEffort: effort });
        expect(acpClient.setRuntimeOption).toHaveBeenCalledWith(expect.objectContaining({
          sessionId: threadId, value: destination, reasoningEffort: effort,
        }));
      } finally {
        await registry.close();
      }
    }), { numRuns: 10 });
  });

  describe("Codex model settings on an untracked thread", () => {
    const source = "gpt-6.1-sol";
    const destination = "gpt-6.2-sol";
    const noReasoning = "gpt-no-reasoning";
    const thread = { backend: "codex" as const, threadId: "existing" };

    function fixture(readThreadModelSettings: () => Promise<{ model: string; reasoningEffort: string } | undefined>, cachedEffort?: string) {
      const overlayStore = createOverlayStoreMock();
      const codexClient = Object.assign(new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
        models: [
          ...[source, destination].map((id) => ({
            id, defaultReasoningEffort: "low", reasoningEfforts: ["low", "medium", "high"],
            supportsReasoning: true, supportsFast: true,
          })),
          { id: noReasoning, supportsReasoning: false },
        ],
        threads: cachedEffort ? [{
          id: thread.threadId, source: "codex", title: "Fixture", titleSource: "explicit", linkedDirectories: [],
          model: source, reasoningEffort: cachedEffort,
        }] : [],
      }), { readThreadModelSettings });
      const registry = createDesktopBackendRegistry({
        codexClient, overlayStore,
        resolveProviderModelDefaults: () => ({ codex: { reasoningEffortsByModel: { [source]: "low" } } }),
        resolveProviderThreadModelMigrations: () => ({
          codex: { revision: "migration", model: destination, reasoningEffort: "high", createdAt: 2 },
        }),
      });
      return { registry, overlayStore };
    }

    it("takes carryover effort only from observations of the owner's current model", async () => {
      await fc.assert(fc.asyncProperty(fc.constantFrom("high", "medium"), fc.boolean(), async (effort, live) => {
        const { registry, overlayStore } = fixture(async () => live ? { model: source, reasoningEffort: effort } : undefined, effort);
        try {
          await registry.listThreads({ backend: "codex" });
          await registry.setThreadModelSettings({ ...thread, model: noReasoning, reasoningEffort: undefined });
          const ownerModel = await overlayStore.getThreadOverlayState(thread);
          expect(ownerModel?.model).toBe(noReasoning);
          expect(ownerModel?.reasoningEffort).toBeUndefined();
          await expect(registry.setThreadModelSettings({ ...thread, model: destination }))
            .resolves.toMatchObject({ model: destination, reasoningEffort: "low" });
        } finally {
          await registry.close();
        }
      }), { numRuns: 10 });
    });

    it("keeps the migrated model when a speed change overlaps the migration", async () => {
      await fc.assert(fc.asyncProperty(fc.boolean(), async (fastMode) => {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const { registry, overlayStore } = fixture(async () => {
          entered.resolve();
          await release.promise;
          return { model: source, reasoningEffort: "medium" };
        });
        const migration = { ...thread, threadModel: source, threadCreatedAt: 1 };
        try {
          const speed = registry.setThreadModelSettings({ ...thread, fastMode });
          await entered.promise;
          const applying = registry.applyThreadModelMigration(migration);
          // A different thread's migration can finish while the read is stalled.
          try {
            await registry.applyThreadModelMigration({ ...migration, threadId: "independent" });
          } finally {
            release.resolve();
            await Promise.all([speed, applying]);
          }
          expect(await applying).toMatchObject({ status: "applied" });
          expect(await registry.applyThreadModelMigration(migration))
            .toMatchObject({ status: "already-applied", model: destination, reasoningEffort: "high" });
          expect(await overlayStore.getThreadOverlayState(thread)).toMatchObject({
            model: destination, reasoningEffort: "high", modelMigrationRevision: "migration", fastMode,
          });
        } finally {
          await registry.close();
        }
      }), { numRuns: 10 });
    });

    it.each(["change tier", "switch model"] as const)("preserves live reasoning when asked to %s", async (action) => {
      await fc.assert(fc.asyncProperty(fc.constantFrom("high", "medium"), async (liveEffort) => {
        const { registry } = fixture(async () => ({ model: source, reasoningEffort: liveEffort }), "low");
        try {
          await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([
            expect.objectContaining({ model: source, reasoningEffort: "low" }),
          ]);
          const patch = action === "change tier"
            ? { model: source, fastMode: true }
            : { model: destination };
          await expect(registry.setThreadModelSettings({ ...thread, ...patch }))
            .resolves.toMatchObject({ ...patch, reasoningEffort: liveEffort });
        } finally {
          await registry.close();
        }
      }), { numRuns: 10 });
    });

    it("applies newer effort selections after a model switch stalled on the owner read", async () => {
      await fc.assert(fc.asyncProperty(fc.constantFrom("high", "medium"), async (chosenEffort) => {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const { registry, overlayStore } = fixture(async () => {
          entered.resolve();
          await release.promise;
          return { model: source, reasoningEffort: "low" };
        });
        try {
          const switching = registry.setThreadModelSettings({ ...thread, model: destination });
          await entered.promise;
          const selecting = registry.setThreadModelSettings({ ...thread, model: destination, reasoningEffort: chosenEffort });
          // An independent thread can finish while the owner read is pending.
          // It also gives an unlocked selection on this thread time to overtake.
          try {
            await registry.setThreadModelSettings({
              ...thread, threadId: "independent", model: destination, reasoningEffort: chosenEffort,
            });
          } finally {
            release.resolve();
            await Promise.all([switching, selecting]);
          }
          expect(await overlayStore.getThreadOverlayState(thread))
            .toMatchObject({ model: destination, reasoningEffort: chosenEffort });
        } finally {
          await registry.close();
        }
      }), { numRuns: 10 });
    });
  });

  it("never applies or acknowledges a migration from a different Codex model provider", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("gpt-old", "@mathos/old", "@bonsai/old"),
      fc.constantFrom("codex", "codex-provider:mathos", "codex-provider:bonsai"),
      async (source, targetKey) => {
        const sourceKey = source.startsWith("@mathos/") ? "codex-provider:mathos"
          : source.startsWith("@bonsai/") ? "codex-provider:bonsai" : "codex";
        fc.pre(sourceKey !== targetKey);
        const target = targetKey === "codex" ? "gpt-new" : `@${targetKey.slice("codex-provider:".length)}/new`;
        const overlayStore = createOverlayStoreMock();
        const registry = createDesktopBackendRegistry({
          codexClient: new MockBackendClient({ initializeResult: { methods: ["thread/start"] } }),
          overlayStore,
          resolveProviderThreadModelMigrations: () => ({
            [targetKey]: { revision: "isolated", model: target, createdAt: 100 },
          }),
        });
        try {
          await expect(registry.applyThreadModelMigration({
            backend: "codex", threadId: "fixture", threadModel: source, threadCreatedAt: 1,
          })).resolves.toMatchObject({ status: "none" });
          expect(await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "fixture" })).toBeUndefined();
        } finally {
          await registry.close();
        }
      },
    ), { numRuns: 25 });
  });

  it("applies each provider thread migration once and lets a later revision supersede it", async () => {
    const overlayStore = createOverlayStoreMock();
    let migrations: Record<string, DesktopProviderThreadModelMigration> = {
      codex: {
        revision: "migration-1",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        sourceModels: ["gpt-5.5"],
        createdAt: 1,
      },
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      threads: [
        {
          id: "turn-thread",
          title: "Turn thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          createdAt: 0,
          model: "gpt-5.5",
        },
        {
          id: "new-turn-thread",
          title: "New turn thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          createdAt: 2,
          model: "gpt-5.6-terra",
        },
      ],
      models: [
        {
          id: "gpt-5.6-sol",
          label: "GPT-5.6-Sol",
          defaultReasoningEffort: "medium",
          reasoningEfforts: ["low", "medium", "high", "xhigh"],
          supportsReasoning: true,
        },
        {
          id: "gpt-5.6-terra",
          label: "GPT-5.6-Terra",
          defaultReasoningEffort: "medium",
          reasoningEfforts: ["low", "medium", "high", "xhigh"],
          supportsReasoning: true,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      resolveProviderThreadModelMigrations: () => migrations,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "turn-thread",
      input: [{ type: "text", text: "Use the migrated model" }],
      reasoningEffort: "low",
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    await registry.startTurn({
      backend: "codex",
      threadId: "new-turn-thread",
      input: [{ type: "text", text: "Keep the newer thread unchanged" }],
      model: "gpt-5.6-terra",
      reasoningEffort: "xhigh",
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "xhigh",
    });
    await expect(overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "new-turn-thread",
    })).resolves.toMatchObject({
      modelMigrationRevision: "migration-1",
    });

    await expect(registry.applyThreadModelMigration({
      backend: "codex",
      threadId: "thread-1",
      threadCreatedAt: 0,
      threadModel: "gpt-5.5",
    })).resolves.toMatchObject({
      status: "applied",
      revision: "migration-1",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    await expect(registry.applyThreadModelMigration({
      backend: "codex",
      threadId: "terra-thread",
      threadCreatedAt: 0,
      threadModel: "gpt-5.6-terra",
    })).resolves.toMatchObject({
      status: "acknowledged-source-model",
      revision: "migration-1",
      model: "gpt-5.6-terra",
    });
    await expect(overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "terra-thread",
    })).resolves.toMatchObject({
      modelMigrationRevision: "migration-1",
    });
    await expect(registry.applyThreadModelMigration({
      backend: "codex",
      threadId: "new-thread",
      threadCreatedAt: 2,
    })).resolves.toMatchObject({
      status: "acknowledged-new-thread",
      revision: "migration-1",
    });
    await expect(overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "new-thread",
    })).resolves.toMatchObject({
      modelMigrationRevision: "migration-1",
    });
    await expect(registry.applyThreadModelMigration({
      backend: "codex",
      threadId: "thread-1",
      threadCreatedAt: 0,
    })).resolves.toMatchObject({
      status: "already-applied",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });

    await registry.setThreadModelSettings({
      backend: "codex",
      threadId: "thread-1",
      model: "gpt-5.6-terra",
      reasoningEffort: "xhigh",
    });
    const customized = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(customized).toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "xhigh",
      modelMigrationRevision: "migration-1",
    });

    migrations = {
      codex: {
        revision: "migration-2",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        createdAt:
          (customized?.modelSettingsManuallyUpdatedAt ?? Date.now()) + 1,
      },
    };
    await expect(registry.applyThreadModelMigration({
      backend: "codex",
      threadId: "thread-1",
      threadCreatedAt: 0,
    })).resolves.toMatchObject({
      status: "applied",
      revision: "migration-2",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });

    migrations = {
      codex: {
        revision: "migration-3",
        model: "retired-model",
        reasoningEffort: "high",
        createdAt: Date.now() + 1,
      },
    };
    await expect(registry.applyThreadModelMigration({
      backend: "codex",
      threadId: "thread-1",
      threadCreatedAt: 0,
    })).resolves.toMatchObject({
      status: "unavailable",
      revision: "migration-3",
    });
    await expect(overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    })).resolves.toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      modelMigrationRevision: "migration-2",
    });

    await expect(registry.applyThreadModelMigration({
      backend: "codex",
      threadId: "missing-metadata-thread",
    })).resolves.toMatchObject({
      status: "metadata-unavailable",
      revision: "migration-3",
    });

    await registry.close();
  });

  it("forces Codex Fast off when the profile policy prohibits it", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
        models: [
          {
            id: "gpt-5.6-sol",
            label: "GPT-5.6-Sol",
            supportsFast: true,
          },
        ],
      }),
      overlayStore: createOverlayStoreMock(),
      resolveCodexFastAllowed: () => false,
    });

    await expect(registry.setThreadModelSettings({
      backend: "codex",
      threadId: "thread-1",
      model: "gpt-5.6-sol",
      serviceTier: "priority",
      fastMode: true,
    })).resolves.toMatchObject({
      model: "gpt-5.6-sol",
      fastMode: false,
    });
    const launchpad = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });
    expect(launchpad.launchpad.fastMode).not.toBe(true);
    expect(launchpad.launchpad.serviceTier).toBeUndefined();

    await registry.close();
  });

  it("starts a local Codex model without inherited reasoning or Fast settings", async () => {
    const model = "/models/bonsai.gguf";
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: [{
        id: model,
        label: "PrismML Bonsai 2 27B",
        current: true,
        reasoningEfforts: [],
        supportsReasoning: false,
        supportsFast: false,
        supportsImage: false,
      }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({ overlays: {
        "codex:local-thread": {
          backend: "codex",
          threadId: "local-thread",
          executionMode: "default",
          model,
          reasoningEffort: "high",
          fastMode: true,
          serviceTier: "priority",
          extraLinkedDirectories: [],
        },
      } }),
    });

    await registry.listBackends();
    await registry.startTurn({
      backend: "codex",
      threadId: "local-thread",
      input: [{ type: "text", text: "Use the local model" }],
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      model,
      reasoningEffort: undefined,
      serviceTier: undefined,
      fastMode: false,
    });
    await registry.close();
  });

  it.each([undefined, "review-preset"])("keeps a registered desktop draft when a messaging launch uses its project (%s)", async (agentPresetId) => {
    const overlayStore = createOverlayStoreMock();
    const project = {
      directoryKey: "directory:/repo/app", directoryKind: "directory" as const, directoryLabel: "app",
      directoryPath: "/repo/app", backend: "codex" as const, executionMode: "default" as const,
      workMode: "worktree" as const, registeredAt: 1, createdAt: 1, updatedAt: 1,
    };
    const saved = { ...project, prompt: "Unsent desktop prompt", agent: { name: "Desktop Agent", instructions: "Keep this draft" },
      agentPresetId, mcpConnectionIds: ["desktop-plugin"] };
    await overlayStore.upsertDirectoryLaunchpad(saved);
    const identity = { directoryKey: project.directoryKey };
    const desktopDraft = await overlayStore.getDirectoryLaunchpad(identity);
    expect(desktopDraft).toMatchObject({ agent: saved.agent, prompt: saved.prompt, mcpConnectionIds: saved.mcpConnectionIds });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ initializeResult: { methods: ["thread/start", "turn/start"] } }), overlayStore,
      gitDirectoryService: { prepareLaunchpadWorkspace: vi.fn(async () => ({
        cwd: "/repo/app/.worktrees/thread-1/app", repositoryPath: "/repo/app", workMode: "worktree" as const,
      })), recordCodexWorktreeOwnerThread: vi.fn(async () => {}) } as never,
    });
    try {
      await registry.materializeDirectoryLaunchpad({ directoryKey: "messaging:browse:fixture", launchpad: { ...project, prompt: "" },
        input: [{ type: "text", text: "Messaging prompt" }] });
      // An independently materialized thread has no claim on the saved draft.
      expect(await overlayStore.getDirectoryLaunchpad(identity)).toEqual(desktopDraft);
    } finally { await registry.close(); }
  });

  it("uses submitted launchpad Fast mode instead of stale persisted launchpad settings", async () => {
    const overlayStore = createOverlayStoreMock();
    await overlayStore.upsertDirectoryLaunchpad({
      directoryKey: "directory:/repo/app",
      directoryKind: "directory",
      directoryLabel: "app",
      directoryPath: "/repo/app",
      backend: "codex",
      executionMode: "default",
      prompt: "stale prompt",
      workMode: "worktree",
      model: "gpt-5.5",
      reasoningEffort: "low",
      serviceTier: "fast",
      fastMode: false,
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: "/repo/app/.worktrees/thread-1/app",
          repositoryPath: "/repo/app",
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "directory:/repo/app",
      input: [{ type: "text", text: "submitted prompt" }],
      launchpad: {
        directoryKey: "directory:/repo/app",
        directoryKind: "directory",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        backend: "codex",
        executionMode: "default",
        prompt: "",
        workMode: "worktree",
        model: "gpt-5.5",
        reasoningEffort: "medium",
        fastMode: true,
        createdAt: 1_000,
        updatedAt: 2_500,
      },
    });

    expect(codexClient.lastStartThreadParams).toMatchObject({
      model: "gpt-5.5",
      reasoningEffort: "medium",
      serviceTier: "priority",
      fastMode: true,
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-1",
      input: [{ type: "text", text: "submitted prompt" }],
      model: "gpt-5.5",
      reasoningEffort: "medium",
      serviceTier: "priority",
      fastMode: true,
    });

    await registry.close();
  });

  it("refuses an OpenAI model override on a Codex thread bound to another model provider", async () => {
    const codexClient = Object.assign(new MockBackendClient({ models: [{ id: "gpt-6.1-terra" }] }), {
      modelProviderForThread: () => "fixture-provider",
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    const settings = { backend: "codex" as const, threadId: "fixture", model: "gpt-6.1-terra" };
    try {
      for (const result of [
        () => registry.setThreadModelSettings(settings),
        () => registry.startTurn({ ...settings, input: [{ type: "text", text: "Continue" }] }),
        () => registry.submitTurn({ ...settings, input: [{ type: "text", text: "Continue" }] }),
      ]) {
        await expect(result()).rejects.toThrow("Hand the thread off to a new thread");
      }
      expect(codexClient.lastStartTurnParams).toBeUndefined();
    } finally {
      await registry.close();
    }
  });

  it("clears Codex Fast serviceTier when Fast mode is unchecked", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-standard": {
            backend: "codex",
            threadId: "thread-standard",
            executionMode: "default",
            model: "gpt-5.5",
            reasoningEffort: "high",
            serviceTier: "fast",
            fastMode: false,
            extraLinkedDirectories: [],
          },
        },
      }),
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-standard",
      input: [{ type: "text", text: "Use standard tier" }],
    });

    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-standard",
      model: "gpt-5.5",
      reasoningEffort: "high",
      serviceTier: undefined,
      fastMode: false,
    });

    await registry.close();
  });

  it("clears stale Codex Fast serviceTier when the selected model does not support Fast", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: [
        {
          id: "gpt-5.4-mini",
          label: "GPT 5.4 mini",
          current: true,
          supportsReasoning: true,
          supportsFast: false,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-unsupported-fast": {
            backend: "codex",
            threadId: "thread-unsupported-fast",
            executionMode: "default",
            model: "gpt-5.4-mini",
            reasoningEffort: "low",
            serviceTier: "fast",
            extraLinkedDirectories: [],
          },
        },
      }),
    });

    await registry.listBackends();
    await registry.startTurn({
      backend: "codex",
      threadId: "thread-unsupported-fast",
      input: [{ type: "text", text: "Use the unsupported model" }],
    });

    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-unsupported-fast",
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
      serviceTier: undefined,
      fastMode: false,
    });

    await registry.close();
  });

  it("emits model settings updates when turning Codex Fast off everywhere", async () => {
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-fast": {
          backend: "codex",
          threadId: "thread-fast",
          executionMode: "default",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          fastMode: true,
          extraLinkedDirectories: [],
        },
        "codex:thread-standard": {
          backend: "codex",
          threadId: "thread-standard",
          executionMode: "default",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          fastMode: false,
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore,
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    await expect(registry.turnOffCodexFastEverywhere()).resolves.toEqual({
      launchpadCount: 0,
      threadCount: 1,
    });
    expect(events).toContainEqual({
      backend: "codex",
      notification: {
        method: "thread/modelSettings/updated",
        params: {
          threadId: "thread-fast",
          fastMode: false,
          serviceTier: undefined,
        },
      },
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({
        notification: expect.objectContaining({
          params: expect.objectContaining({
            threadId: "thread-standard",
          }),
        }),
      }),
    );

    unsubscribe();
    await registry.close();
  });

  it("detects Codex Fast mode drift when the completed turn reports a mismatched tier", () => {
    expect(
      getCodexFastModeMismatchWarning({
        threadId: "thread-fast",
        turnId: "turn-1",
        expectedFastMode: true,
        notificationParams: {
          threadId: "thread-fast",
          turnId: "turn-1",
          serviceTier: null,
          turn: { id: "turn-1", status: "completed", output: [] },
        },
      }),
    ).toMatchObject({
      threadId: "thread-fast",
      turnId: "turn-1",
      expectedFastMode: true,
      observedFastMode: false,
    });

    expect(
      getCodexFastModeMismatchWarning({
        threadId: "thread-fast",
        turnId: "turn-2",
        expectedFastMode: false,
        notificationParams: {
          threadId: "thread-fast",
          turnId: "turn-2",
          serviceTier: "fast",
          turn: { id: "turn-2", status: "completed", output: [] },
        },
      }),
    ).toMatchObject({
      threadId: "thread-fast",
      turnId: "turn-2",
      expectedFastMode: false,
      observedFastMode: true,
    });

    expect(
      getCodexFastModeMismatchWarning({
        threadId: "thread-fast",
        turnId: "turn-3",
        expectedFastMode: false,
        notificationParams: {
          threadId: "thread-fast",
          turnId: "turn-3",
          serviceTier: "priority",
        },
      }),
    ).toMatchObject({
      threadId: "thread-fast",
      turnId: "turn-3",
      expectedFastMode: false,
      observedFastMode: true,
      observedServiceTier: "priority",
    });
  });

  it("checks Codex Fast mode drift against observed thread settings when terminal events omit tier", () => {
    const notificationParams = buildCodexFastModeMismatchNotificationParams(
      {
        threadId: "thread-fast",
        turn: { id: "turn-1", status: "completed", output: [] },
      },
      {
        fastMode: true,
        serviceTier: "fast",
      },
    );

    expect(
      getCodexFastModeMismatchWarning({
        threadId: "thread-fast",
        turnId: "turn-1",
        expectedFastMode: false,
        notificationParams,
      }),
    ).toMatchObject({
      threadId: "thread-fast",
      turnId: "turn-1",
      expectedFastMode: false,
      observedFastMode: true,
      observedServiceTier: "fast",
    });
  });

  it("prefers terminal Codex Fast settings over cached observed thread settings", () => {
    const notificationParams = buildCodexFastModeMismatchNotificationParams(
      {
        threadId: "thread-fast",
        turn: { id: "turn-1", status: "completed", output: [] },
        serviceTier: "priority",
      },
      {
        fastMode: false,
        serviceTier: null,
      },
    );

    expect(
      getCodexFastModeMismatchWarning({
        threadId: "thread-fast",
        turnId: "turn-1",
        expectedFastMode: false,
        notificationParams,
      }),
    ).toMatchObject({
      threadId: "thread-fast",
      turnId: "turn-1",
      expectedFastMode: false,
      observedFastMode: true,
      observedServiceTier: "priority",
    });
  });

  it("persists observed Codex model settings for later thread snapshots", async () => {
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-observed-model",
          title: "Observed model thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-observed-model": {
          backend: "codex",
          threadId: "thread-observed-model",
          executionMode: "default",
          serviceTier: "fast",
          fastMode: true,
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    await codexClient.emit({
      method: "thread/codexSettings/observed",
      params: {
        threadId: "thread-observed-model",
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
        serviceTier: null,
        fastMode: false,
      },
    });

    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-observed-model",
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
      serviceTier: "fast",
      fastMode: true,
    });
    expect(events).toContainEqual({
      backend: "codex",
      notification: {
        method: "thread/modelSettings/updated",
        params: {
          threadId: "thread-observed-model",
          model: "gpt-5.4-mini",
          reasoningEffort: "low",
          serviceTier: "fast",
          fastMode: true,
        },
      },
    });
    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([
      expect.objectContaining({
        id: "thread-observed-model",
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
        serviceTier: "fast",
        fastMode: true,
      }),
    ]);

    unsubscribe();
    await registry.close();
  });

  it("reports the Token Miser override and effective state through readThread", async () => {
    const overlayStore = createOverlayStoreMock();
    await overlayStore.setThreadTokenMiser({
      backend: "codex",
      threadId: "thread-1",
      enabled: false,
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/read"] },
      }),
      overlayStore,
    });
    const internals = registry as unknown as {
      resolveTokenMiserDefaultEnabledFn: () => boolean;
      resolveTokenMiserEnabledFn: () => boolean;
    };
    internals.resolveTokenMiserDefaultEnabledFn = () => true;
    internals.resolveTokenMiserEnabledFn = () => true;

    await expect(registry.readThread({
      backend: "codex",
      threadId: "thread-1",
    })).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      tokenMiserEnabled: false,
      tokenMiserOverride: false,
    });

    const defaulted = await registry.readThread({
      backend: "codex",
      threadId: "thread-default",
    });
    expect(defaulted).toMatchObject({
      backend: "codex",
      threadId: "thread-default",
      tokenMiserEnabled: true,
    });
    expect(defaulted).not.toHaveProperty("tokenMiserOverride");

    await registry.close();
  });

  it("updates execution mode through the single Codex client", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read", "thread/resume"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
    });

    const response = await registry.setThreadExecutionMode({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "full-access",
    });

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "full-access",
    });
    expect(codexClient.lastSetThreadPermissionsParams).toEqual({
      threadId: "thread-1",
      approvalPolicy: "never",
        approvalsReviewer: "user",
      sandbox: "danger-full-access",
    });

    await registry.close();
  });  it("keeps Agent metadata synchronized when its thread is renamed", async () => {
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          agent: {
            name: "Old Agent name",
            instructions: "Keep the existing personality.",
            instructionLineCount: 1,
            instructionsTooLong: false,
            updatedAt: 1_000,
          },
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/name/set"] },
      }),
      overlayStore,
    });

    await registry.renameThread({
      backend: "codex",
      threadId: "thread-1",
      name: "Jeeves Reborn",
    });

    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      agent: {
        name: "Jeeves Reborn",
        instructions: "Keep the existing personality.",
      },
    });

    await registry.close();
  });

  it("renames ACP threads in the local session store", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "Untitled thread",
        titleSource: "fallback",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      },
    ];
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpSessionStore: createAcpSessionStoreMock(sessions),
    });

    await expect(
      registry.renameThread({
        backend: acpBackendId,
        threadId: "session-1",
        name: "  Cleaned up formatting  ",
      }),
    ).resolves.toEqual({
      backend: acpBackendId,
      threadId: "session-1",
      renamedAt: expect.any(Number),
    });

    expect(sessions[0]).toMatchObject({
      title: "Cleaned up formatting",
      titleSource: "explicit",
    });

    await registry.close();
  });

  it.each([
    {
      executionMode: "default" as const,
      input: "This must not silently escalate",
    },
    {
      executionMode: "full-access" as const,
      input: "This must not silently downgrade",
    },
  ])("surfaces the single-client startTurn error directly when $executionMode mode is explicitly requested", async ({
    executionMode,
    input,
  }) => {
    const error = `thread not loaded on ${executionMode} instance`;
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      startTurnError: new Error(error),
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({ executionMode }),
    });

    await expect(
      registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        executionMode,
        input: [{ type: "text", text: input }],
      }),
    ).rejects.toThrow(error);

    await registry.close();
  });

  it("forwards per-turn override on the single client when execution mode is toggled", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/list"] },
      threads: [
        {
          id: "thread-toggle",
          title: "Toggle test",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-toggle": {
          backend: "codex",
          threadId: "thread-toggle",
          executionMode: "full-access",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-toggle",
      executionMode: "full-access",
      input: [{ type: "text", text: "First turn on full-access" }],
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-toggle",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-toggle",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          output: [],
        },
      },
    });

    await registry.setThreadExecutionMode({
      backend: "codex",
      threadId: "thread-toggle",
      executionMode: "default",
    });

    codexClient.lastStartTurnParams = undefined;

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-toggle",
      executionMode: "default",
      input: [{ type: "text", text: "Second turn forwards default policy on the same client" }],
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-toggle",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });

    await registry.close();
  });

  describe("queued permission-mode changes", () => {
    function buildIdleRegistry(options?: {
      executionMode?: "default" | "auto" | "full-access";
    }) {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/resume"] },
      });
      const overlayStore = createOverlayStoreMock({
        executionMode: options?.executionMode ?? "default",
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore,
      });
      return { codexClient, overlayStore, registry };
    }

    async function getLog(
      overlayStore: ReturnType<typeof createOverlayStoreMock>,
      threadId: string,
    ) {
      const overlay = await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId,
      });
      return overlay?.permissionTransitionLog ?? [];
    }

    function startActiveTurn(
      registry: InstanceType<typeof DesktopBackendRegistry>,
      threadId: string,
      turnId = "turn-1",
    ) {
      // The registry exposes activeCodexTurnModes only privately; the
      // legitimate way to mark a thread active is to invoke startTurn.
      // For the queue tests the actual turn payload doesn't matter.
      return registry.startTurn({
        backend: "codex",
        threadId,
        input: [{ type: "text", text: "kicking off" }],
      }).then((response) => {
        // Sanity: the registry assigned an active turn key. Some tests
        // need a deterministic turnId, so we use the returned value.
        return response.turnId ?? turnId;
      });
    }

    it("switches Default to Auto during a turn and uses Auto on the following turn", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      const turnId = await startActiveTurn(registry, "thread-1");
      await registry.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "auto" });
      expect(codexClient.setTurnApprovalReviewer).toHaveBeenCalledWith({
        threadId: "thread-1", turnId, approvalsReviewer: "auto_review",
      });
      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();
      expect(registry.getQueuedExecutionModeForThread({ backend: "codex", threadId: "thread-1" })).toBeUndefined();
      expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.executionMode).toBe("auto");
      expect(await getLog(overlayStore, "thread-1")).toEqual([
        expect.objectContaining({ fromExecutionMode: "default", toExecutionMode: "auto", status: "applied" }),
      ]);
      await codexClient.emit({ method: "turn/completed", params: {
        threadId: "thread-1", turnId, turn: { id: turnId, status: "completed", output: [] },
      } });
      await startActiveTurn(registry, "thread-1");
      expect(codexClient.lastStartTurnParams).toMatchObject({
        approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review",
      });
      await registry.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "default" });
      expect(codexClient.setTurnApprovalReviewer).toHaveBeenLastCalledWith({
        threadId: "thread-1", turnId: expect.any(String), approvalsReviewer: "user",
      });
      await registry.close();
    });

    it.each([
      { from: "default", to: "auto", reviewer: "auto_review", managed: true },
      { from: "auto", to: "default", reviewer: "user", managed: true },
      { from: "default", to: "auto", reviewer: "auto_review", managed: false },
      { from: "auto", to: "default", reviewer: "user", managed: false },
    ] as const)("queues $from to $to until review finishes (managed=$managed)", async ({ from, to, reviewer, managed }) => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "turn/start", "review/start"] },
        startThreadResult: { threadId: "review-child" },
        startReviewResult: {
          threadId: "thread-parent", reviewThreadId: "review-child", turnId: "turn-1",
        },
      });
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "codex:thread-parent": {
            backend: "codex",
            threadId: "thread-parent",
            executionMode: from,
            extraLinkedDirectories: [],
          },
        },
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore,
        resolveManagedReviewEnabled: () => managed,
      });
      await discoverCodexBackendForTest(registry);
      const review = await registry.startReview({
        backend: "codex",
        threadId: "thread-parent",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      });
      expect(review.reviewThreadId).toBe("review-child");

      await registry.setThreadExecutionMode({
        backend: "codex", threadId: "thread-parent", executionMode: to,
      });

      expect(codexClient.setTurnApprovalReviewer).not.toHaveBeenCalled();
      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();
      expect((await overlayStore.getThreadOverlayState({
        backend: "codex", threadId: "thread-parent",
      }))?.executionMode).toBe(from);
      expect(registry.getQueuedExecutionModeForThread({
        backend: "codex", threadId: "thread-parent",
      })?.mode).toBe(to);
      expect(await getLog(overlayStore, "thread-parent")).toEqual([
        expect.objectContaining({
          fromExecutionMode: from, toExecutionMode: to, status: "queued",
        }),
      ]);

      await codexClient.emit({
        method: "item/completed",
        params: {
          threadId: review.reviewThreadId,
          turnId: review.turnId,
          item: {
            id: "review-output",
            type: "agentMessage",
            text: JSON.stringify({
              findings: [],
              overall_correctness: "patch is correct",
              overall_explanation: "No blocking findings.",
              overall_confidence_score: 0.96,
            }),
          },
        },
      });
      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: review.reviewThreadId,
          turnId: review.turnId,
          turn: { id: review.turnId, status: "completed", output: [] },
        },
      });
      await vi.waitFor(async () => {
        expect((await overlayStore.getThreadOverlayState({
          backend: "codex", threadId: "thread-parent",
        }))?.executionMode).toBe(to);
        expect(registry.getQueuedExecutionModeForThread({
          backend: "codex", threadId: "thread-parent",
        })).toBeUndefined();
        expect((await getLog(overlayStore, "thread-parent")).map((entry) => entry.status))
          .toEqual(["queued", "applied"]);
      });
      expect(codexClient.lastSetThreadPermissionsParams).toEqual({
        threadId: "thread-parent",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: reviewer,
      });
      expect(codexClient.setTurnApprovalReviewer).not.toHaveBeenCalled();
      await registry.close();
    });

    it.each(["targetUnavailable", "rejected"])("preserves the mode when live Auto update is %s", async (outcome) => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      await startActiveTurn(registry, "thread-1");
      if (outcome === "rejected") {
        codexClient.setTurnApprovalReviewer.mockRejectedValueOnce(new Error("Reviewer disallowed by organization"));
      } else {
        codexClient.setTurnApprovalReviewer.mockResolvedValueOnce({ status: "targetUnavailable" });
      }
      await expect(registry.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "auto" })).rejects.toThrow();
      expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.executionMode).toBe("default");
      expect(await getLog(overlayStore, "thread-1")).toEqual([]);
      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();
      await registry.close();
    });

    it("serializes opposite live selections so the last selection wins", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      await startActiveTurn(registry, "thread-1");
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => { finish = resolve; });
      codexClient.setTurnApprovalReviewer.mockImplementationOnce(async () => {
        await gate;
        return { status: "applied" };
      });
      const auto = registry.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "auto" });
      await vi.waitFor(() => expect(codexClient.setTurnApprovalReviewer).toHaveBeenCalledOnce());
      const human = registry.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "default" });
      expect(codexClient.setTurnApprovalReviewer).toHaveBeenCalledOnce();
      finish();
      await Promise.all([auto, human]);
      expect(codexClient.setTurnApprovalReviewer.mock.calls.map(([request]) => request.approvalsReviewer)).toEqual(["auto_review", "user"]);
      expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.executionMode).toBe("default");
      await registry.close();
    });

    it("queues Full Access to Auto until the sandbox can change", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry({ executionMode: "full-access" });
      const turnId = await startActiveTurn(registry, "thread-1");
      await registry.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "auto" });
      expect(codexClient.setTurnApprovalReviewer).not.toHaveBeenCalled();
      expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.executionMode).toBe("full-access");
      expect(registry.getQueuedExecutionModeForThread({ backend: "codex", threadId: "thread-1" })?.mode).toBe("auto");
      await codexClient.emit({ method: "turn/completed", params: {
        threadId: "thread-1", turnId, turn: { id: turnId, status: "completed", output: [] },
      } });
      await vi.waitFor(async () => {
        expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.executionMode).toBe("auto");
      });
      expect(codexClient.lastSetThreadPermissionsParams).toMatchObject({
        approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review",
      });
      await registry.close();
    });

    it("replaces a queued Full Access request with a live Auto switch", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      await startActiveTurn(registry, "thread-1");
      await registry.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "full-access" });
      await registry.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "auto" });
      expect(codexClient.setTurnApprovalReviewer).toHaveBeenCalledOnce();
      expect(registry.getQueuedExecutionModeForThread({ backend: "codex", threadId: "thread-1" })).toBeUndefined();
      expect((await getLog(overlayStore, "thread-1")).map((entry) => entry.status)).toEqual(["queued", "cancelled", "applied"]);
      await registry.close();
    });

    it("applies Auto while idle and rejects it for ACP backends", async () => {
      const { codexClient, registry } = buildIdleRegistry();
      await registry.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "auto" });
      expect(codexClient.lastSetThreadPermissionsParams).toEqual({
        threadId: "thread-1", approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review",
      });
      await expect(registry.setThreadExecutionMode({ backend: "acp:gemini", threadId: "thread-1", executionMode: "auto" })).rejects.toThrow("only by Codex");
      await registry.close();
    });

    it("toggle while idle applies immediately and logs a single applied entry", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();

      const response = await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });

      expect(response).toEqual({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      expect(codexClient.lastSetThreadPermissionsParams).toEqual({
        threadId: "thread-1",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
      });

      const log = await getLog(overlayStore, "thread-1");
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        fromExecutionMode: "default",
        toExecutionMode: "full-access",
        status: "applied",
      });
      // No queueId on apply-immediately transitions.
      expect(log[0]?.queueId).toBeUndefined();

      await registry.close();
    });

    it("toggle while a turn is active queues without calling codex", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      await startActiveTurn(registry, "thread-1");

      // startTurn calls setThreadPermissions? No — startTurn does NOT
      // call setThreadPermissions; it sets sandbox via the per-turn
      // override. Confirm the per-turn override is the only call so
      // far.
      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();

      const response = await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });

      expect(response).toEqual({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      // Codex was NOT asked to switch — the queue holds the change.
      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();

      const log = await getLog(overlayStore, "thread-1");
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        fromExecutionMode: "default",
        toExecutionMode: "full-access",
        status: "queued",
      });
      expect(log[0]?.queueId).toBeTruthy();

      await registry.close();
    });

    it("queue then explicit cancel records both entries with matching queueId and never calls codex", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      await registry.cancelThreadExecutionModeQueue({
        backend: "codex",
        threadId: "thread-1",
      });

      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();

      const log = await getLog(overlayStore, "thread-1");
      expect(log).toHaveLength(2);
      expect(log[0]?.status).toBe("queued");
      expect(log[1]?.status).toBe("cancelled");
      expect(log[0]?.queueId).toBeTruthy();
      expect(log[1]?.queueId).toBe(log[0]?.queueId);

      await registry.close();
    });

    it("toggling back to the currently-applied mode while queued is treated as a cancel", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      // Toggle back to "default" (the currently-applied mode) while
      // the queue is still pending.
      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "default",
      });

      // Codex never called.
      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();

      const log = await getLog(overlayStore, "thread-1");
      expect(log.map((entry) => entry.status)).toEqual([
        "queued",
        "cancelled",
      ]);
      expect(log[0]?.queueId).toBe(log[1]?.queueId);

      await registry.close();
    });

    it("queue while a queue exists replaces the target with a fresh queueId", async () => {
      const { overlayStore, registry } = buildIdleRegistry();
      await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      // Re-queue. Same applied mode (default) is the from; the new
      // target is "full-access" again. The previous queueId is
      // orphaned in the log — that's correct (the user changed their
      // mind, then changed it back to the same target). The audit
      // semantically captures both intents.
      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });

      const log = await getLog(overlayStore, "thread-1");
      // Two queued entries. The second one re-queued to the same
      // target — but the registry produced a fresh queueId because
      // the user intent (queue an apply) was re-asserted.
      expect(log.map((entry) => entry.status)).toEqual([
        "queued",
        "queued",
      ]);
      expect(log[0]?.queueId).not.toBe(log[1]?.queueId);

      await registry.close();
    });

    it("emits queued and queueCleared notifications around the lifecycle", async () => {
      const { registry } = buildIdleRegistry();
      const events: AgentEvent[] = [];
      registry.onEvent((event) => {
        events.push(event);
      });
      await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      await registry.cancelThreadExecutionModeQueue({
        backend: "codex",
        threadId: "thread-1",
      });

      const methodSequence = events.map(
        (event) => event.notification.method,
      );
      expect(methodSequence).toContain("thread/executionMode/queued");
      expect(methodSequence).toContain("thread/executionMode/queueCleared");

      const cleared = events.find(
        (event) =>
          event.notification.method === "thread/executionMode/queueCleared",
      );
      expect(cleared?.notification.params).toMatchObject({
        threadId: "thread-1",
        reason: "cancelled",
      });

      await registry.close();
    });

    it("turn-end fires the queue flush, applying the queued mode and emitting queueCleared(applied)", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      const events: AgentEvent[] = [];
      registry.onEvent((event) => {
        events.push(event);
      });
      const turnId = await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });

      // Codex was NOT called yet — the queue holds the change.
      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();

      // Simulate codex emitting turn/completed at the end of the turn.
      // The registry's emit() listener flushes the queue.
      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId,
          turn: {
            id: turnId,
            status: "completed",
            output: [],
          },
        },
      });
      // Wait for the fire-and-forget flush to settle. We need the
      // entire applyThreadExecutionMode path to complete (codex call,
      // overlay flip, audit-log append, both notifications) — polling
      // on setThreadPermissions alone is too early.
      await registry.whenQueuedExecutionModeFlushesSettledForTests();

      expect(codexClient.lastSetThreadPermissionsParams).toEqual({
        threadId: "thread-1",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
      });

      const log = await getLog(overlayStore, "thread-1");
      expect(log.map((entry) => entry.status)).toEqual([
        "queued",
        "applied",
      ]);
      // The applied entry must propagate the matching queueId.
      expect(log[0]?.queueId).toBeTruthy();
      expect(log[1]?.queueId).toBe(log[0]?.queueId);

      // Order: thread/executionMode/updated must precede
      // thread/executionMode/queueCleared(applied).
      const updatedIndex = events.findIndex(
        (event) =>
          event.notification.method === "thread/executionMode/updated",
      );
      const clearedIndex = events.findIndex(
        (event) =>
          event.notification.method === "thread/executionMode/queueCleared" &&
          (event.notification.params as { reason?: string }).reason ===
            "applied",
      );
      expect(updatedIndex).toBeGreaterThanOrEqual(0);
      expect(clearedIndex).toBeGreaterThan(updatedIndex);

      await registry.close();
    });

    it("startTurn flushes a pending queue before the new turn fires", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      const turnId = await startActiveTurn(registry, "thread-1", "turn-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });

      // The user-fast-path: turn ends, but before the emit() listener
      // gets to run, the user submits a new turn. startTurn must flush
      // the queue itself before letting codex see the new turn.
      // Simulate that by emitting turn/completed (which lets the prune
      // run) and then calling startTurn — but we don't await the
      // turn/completed emission; we go straight to startTurn.
      // The emit listener for the previous turn has already fired the
      // flush via fire-and-forget; startTurn awaits the same flush
      // function defensively, so the queue applies before the new turn.
      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId,
          turn: { id: turnId, status: "completed", output: [] },
        },
      });

      await registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "next turn" }],
      });

      // setThreadPermissions must have been called before startTurn's
      // turn payload was finalized. The mock client tracks the latest
      // setThreadPermissions call; verify it was invoked at all.
      expect(codexClient.lastSetThreadPermissionsParams).toEqual({
        threadId: "thread-1",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
      });

      const log = await getLog(overlayStore, "thread-1");
      expect(log.map((entry) => entry.status)).toContain("applied");

      await registry.close();
    });

    it("startReview waits for an in-flight permission queue flush before review/start", async () => {
      const permissionFlush = createDeferred<void>();
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["turn/start", "review/start", "thread/resume"] },
        setThreadPermissionsDelay: permissionFlush.promise,
      });
      const overlayStore = createOverlayStoreMock({
        executionMode: "default",
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore,
      });
      const turnId = await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();

      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId,
          turn: { id: turnId, status: "completed", output: [] },
        },
      });

      await waitForCondition(
        () => codexClient.lastSetThreadPermissionsParams !== undefined,
      );

      const reviewPromise = registry.startReview({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      });
      await flushAsync();

      expect(codexClient.lastStartReviewParams).toBeUndefined();
      permissionFlush.resolve();
      await reviewPromise;

      expect(codexClient.lastSetThreadPermissionsParams).toEqual({
        threadId: "thread-1",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
      });
      expect(codexClient.lastStartReviewParams).toEqual({
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      });
      const overlay = await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      });
      expect(overlay?.executionMode).toBe("full-access");

      await registry.close();
    });

    it("emit-listener and startTurn flush hooks do not double-apply when both fire concurrently", async () => {
      // Regression: before the atomic-claim fix, both flush hooks
      // (emit-listener turn-end + startTurn race-safe prefix) could
      // both pass the `queue exists` check, both call
      // applyThreadExecutionMode, and both append an `applied`
      // transition. The user reported seeing two "Permissions
      // changed" entries in the transcript at the same timestamp.
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      const turnId = await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });

      // Fire BOTH flush hooks back to back without awaiting in
      // between, mirroring the production race where the emit
      // listener and a subsequent startTurn call land on the same
      // tick. The atomic Map.delete claim must let only one through.
      const turnEndPromise = codexClient.emit({
        method: "thread/status/changed",
        params: {
          threadId: "thread-1",
          status: { type: "idle" },
        },
      });
      await Promise.resolve();
      const startTurnPromise = registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "next turn after queue applies" }],
      });
      await Promise.all([turnEndPromise, startTurnPromise]);

      // Wait for any deferred flush completion.
      await registry.whenQueuedExecutionModeFlushesSettledForTests();

      const log = await getLog(overlayStore, "thread-1");
      const appliedEntries = log.filter(
        (entry) => entry.status === "applied" && entry.toExecutionMode === "full-access",
      );
      expect(appliedEntries).toHaveLength(1);
      // codex.setThreadPermissions called exactly once (not twice).
      expect(codexClient.setThreadPermissionsCallCount).toBe(1);
      expect(turnId).toBeDefined();

      await registry.close();
    });

    it("evicts oldest entries past the 100-entry cap", async () => {
      const { overlayStore, registry } = buildIdleRegistry();

      // Each setThreadExecutionMode toggle on an idle thread produces
      // exactly one "applied" entry. Ping-pong 101 times.
      for (let index = 0; index < 101; index += 1) {
        const target = index % 2 === 0 ? "full-access" : "default";
        await registry.setThreadExecutionMode({
          backend: "codex",
          threadId: "thread-1",
          executionMode: target,
        });
      }

      const log = await getLog(overlayStore, "thread-1");
      expect(log).toHaveLength(100);

      await registry.close();
    });
  });
});
