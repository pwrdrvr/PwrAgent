import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { AcpRolloutStore } from "../acp/acp-rollout-store";
import { ACP_WORKSPACE_HANDOFF_RECORD, acpWorkspaceHistory } from "../acp/acp-workspace-history";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { AcpSessionStore } from "../storage/acp-session-store";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import {
  createAcpAgentStoreMock,
  createAcpSessionStoreMock,
  createKimiAgentRecord,
  createOverlayStoreMock,
  MockBackendClient,
} from "./helpers/backend-registry-fixture";

const backend = "acp:antigravity";
const threadId = "workspace-thread";
const sourceId = "source-provider";
const sourceCwd = "/repo/source";
const targetCwd = "/repo/destination";
const oldPrompt = "Find the original marker";
const oldAnswer = "Old workspace marker is CANDLE-742";
const newPrompt = "Confirm the working directory and prior marker";
const workspaceHistoryUri = "pwragent://workspace/history";
const identity = { backend, threadId } as const;
type Access = "default" | "full-access";
const targetDirectory = {
  id: `pwragent-handoff:${backend}:${threadId}`,
  label: "repo",
  path: "/repo",
  kind: "worktree" as const,
  worktreePath: targetCwd,
  worktreeOwnership: "external" as const,
};

async function checkWorkspaceMove(params: {
  access: Access;
  legacy: boolean;
  alreadyRooted: boolean;
  restart: boolean;
  measureWrites?: boolean;
  monitorBeforePrompt?: boolean;
  withoutSourcePromptTimestamp?: boolean;
  withoutDestinationPromptTimestamp?: boolean;
  repeatedProviderReplyId?: boolean;
  roundTrip?: boolean;
  replacementStartsInPlan?: boolean;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-antigravity-workspace-"));
  const base = createKimiAgentRecord(backend, {
    schemaVersion: 1, status: "discovered", source: "initialize", discoveredAt: 1,
    agentCapabilities: { loadSession: true },
  });
  const agent = {
    ...base, registryId: "antigravity", name: "Antigravity", version: "1.5.16",
    launchDescriptor: { ...base.launchDescriptor!, registryId: "antigravity", command: "agy", args: ["acp", "--process-per-session"] },
  };
  const workspace = new Map([[sourceId, params.alreadyRooted ? targetCwd : sourceCwd]]);
  const modes = new Map<string, string>();
  const modeOptions = (currentValue: string) => [{
    type: "select", id: "mode", category: "mode", name: "Mode", currentValue,
    options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }],
  }];
  const history = new Map<string, Record<string, unknown>[]>([[sourceId, [
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: oldPrompt },
      ...(params.withoutSourcePromptTimestamp ? {} : { timestamp: "2026-11-23T12:00:00Z" }) },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: oldAnswer }, timestamp: "2026-11-23T12:00:01Z",
      ...(params.repeatedProviderReplyId ? { messageId: "provider-reply" } : {}) },
  ]]]);
  const calls: string[] = [];
  const newSession = vi.fn();
  const dispatched = vi.fn();
  let nativeModeAtDispatch: string | undefined;
  const overlays = createOverlayStoreMock();
  if (params.legacy) {
    await overlays.replaceWorkspaceLinkedDirectory({ ...identity, directory: targetDirectory, gitBranch: "HEAD" });
  }
  const db = params.measureWrites ? StateDb.open(path.join(root, "state.db")) : undefined;
  const sessions = db ? new AcpSessionStore(db) : createAcpSessionStoreMock([]);
  sessions.upsertSession({
    backendId: backend, sessionId: threadId, agentSessionId: sourceId, title: "Worktree thread",
    cwd: params.legacy ? targetCwd : sourceCwd, createdAt: 1, updatedAt: 2,
    executionMode: params.access, status: "idle", hasConversationHistory: true,
    ...(params.access === "full-access" ? { antigravityFullAccessConfirmed: true } : {}),
  });
  const agents = createAcpAgentStoreMock([agent]);
  const handoff = vi.fn(async ({ targetPath = targetCwd }: { targetPath?: string }) => ({
    ...identity, workMode: "worktree", direction: "worktree-to-worktree", repositoryPath: "/repo",
    targetPath, linkedDirectory: { ...targetDirectory, worktreePath: targetPath }, branch: "HEAD",
    warnings: [], completedAt: 1000,
  }));
  const rollouts = new AcpRolloutStore(root);
  if (params.monitorBeforePrompt) {
    const upsert = sessions.upsertSession.bind(sessions);
    let injected = false;
    vi.spyOn(sessions, "upsertSession").mockImplementation((session) => {
      if (session.agentSessionId === "destination-1" && !injected) {
        injected = true;
        // The monitor writes local transcript history before the provider
        // has accepted the first destination prompt.
        rollouts.appendUpdate({ backendId: backend, sessionId: threadId, receivedAt: Date.now(), update: {
          sessionUpdate: "agent_message_chunk", messageId: "monitor-report",
          content: { type: "text", text: "Monitor finished" }, _meta: { pwragentSynthetic: true },
        } });
        upsert({ ...session, hasConversationHistory: true });
      } else {
        upsert(session);
      }
    });
  }
  function startOwner() {
    return createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: overlays,
      acpAgentStore: agents,
      acpSessionStore: sessions,
      acpRolloutStore: rollouts,
      createAcpTransport: (launch) => new class extends FakeAcpAgentTransport {
        override async request(method: string, data?: Record<string, unknown>): Promise<unknown> {
          calls.push(method);
          const sessionId = String(data?.sessionId);
          switch (method) {
            case "initialize":
              return {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {} } },
              };
            case "session/list":
              return { sessions: [...workspace].map(([sessionId, cwd]) => ({
                sessionId, cwd, additionalDirectories: [targetCwd],
              })) };
            case "session/load":
              for (const update of history.get(sessionId) ?? []) this.emitSessionUpdate(sessionId, update);
              return {};
            case "session/new": {
              const id = `destination-${workspace.size}`;
              workspace.set(id, String(data?.cwd));
              newSession(data?.cwd, launch.launchDescriptor?.args.includes("--dangerously-skip-permissions"));
              if (params.replacementStartsInPlan) {
                modes.set(id, "plan");
                return { sessionId: id, configOptions: modeOptions("plan") };
              }
              return { sessionId: id };
            }
            case "session/set_config_option": {
              expect(data).toMatchObject({ configId: "mode", value: "default" });
              modes.set(sessionId, "default");
              return { configOptions: modeOptions("default") };
            }
            case "session/prompt": {
              nativeModeAtDispatch = modes.get(sessionId);
              const content = data?.prompt as { type: string; text?: string; resource?: { uri: string; text: string } }[];
              const context = content.find((part) => part.type === "resource")?.resource;
              const cwd = workspace.get(sessionId);
              dispatched({ sessionId, cwd, context });
              const update = {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `Ran from ${cwd}` },
                timestamp: new Date().toISOString(),
                ...(params.repeatedProviderReplyId ? { messageId: "provider-reply" } : {}),
              };
              const replay = [
                { sessionUpdate: "user_message_chunk", content: { type: "text", text: newPrompt },
                  ...(params.withoutDestinationPromptTimestamp ? {} : { timestamp: update.timestamp }) },
                ...(context ? [{
                  ...update, sessionUpdate: "user_message_chunk",
                  content: { type: "text", text: `\nContent of ${workspaceHistoryUri}:\n${context.text}\n` },
                }] : []),
                update,
              ];
              history.set(sessionId, [...history.get(sessionId) ?? [], ...replay]);
              this.emitSessionUpdate(sessionId, update);
              return { stopReason: "end_turn" };
            }
            default:
              return await super.request(method, data);
          }
        }
      }(),
      gitWorkspaceHandoffService: { handoff } as never,
    });
  }
  let registry = startOwner();
  try {
    if (!params.legacy) {
      await registry.handoffThreadWorkspace({
        ...identity, direction: "worktree-to-worktree", baseRef: "origin/main",
        repositoryPath: "/repo", sourcePath: sourceCwd, targetPath: targetCwd,
      });
      expect(handoff).toHaveBeenCalledOnce();
      if (params.roundTrip) {
        await registry.handoffThreadWorkspace({
          ...identity, direction: "worktree-to-worktree", baseRef: "origin/main",
          repositoryPath: "/repo", sourcePath: targetCwd, targetPath: sourceCwd,
        });
      }
    }
    const destination = params.roundTrip ? sourceCwd : targetCwd;
    const terminal = Promise.withResolvers<void>();
    let liveReplyId: string | undefined;
    const unsubscribe = registry.onEvent((event) => {
      if (event.notification.method === "item/agentMessage/delta"
        && event.notification.params.delta === `Ran from ${destination}`
        && typeof event.notification.params.itemId === "string") {
        liveReplyId = event.notification.params.itemId;
      }
      if (event.notification.method === "turn/completed") terminal.resolve();
    });
    const continueThread = async () => {
      await expect(registry.startTurn({
        ...identity, input: [{ type: "text", text: newPrompt }],
      })).resolves.toMatchObject(identity);
      await terminal.promise;
    };
    if (params.measureWrites) {
      db?.raw.pragma("wal_checkpoint(TRUNCATE)");
      const { writes } = await measureSqliteWrites(continueThread);
      expectSqliteWriteBudget({
        scenario: "antigravity-workspace-rebind",
        note: "One destination session replacement and its first completed turn. Prior transcript stays in the ACP rollout.",
        writes,
      });
    } else {
      await continueThread();
    }
    unsubscribe();
    if (params.replacementStartsInPlan) expect(nativeModeAtDispatch).toBe("default");
    if (params.alreadyRooted || params.roundTrip) {
      expect(newSession).not.toHaveBeenCalled();
      expect(dispatched).toHaveBeenCalledWith({ sessionId: sourceId, cwd: destination, context: undefined });
      expect(sessions.getSession(backend, threadId)?.requiresAgentSessionRebind).not.toBe(true);
    } else {
      expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({ cwd: targetCwd }));
      expect(newSession).toHaveBeenCalledExactlyOnceWith(targetCwd, params.access === "full-access");
      expect(calls.indexOf("session/close")).toBeLessThan(calls.indexOf("session/new"));
      expect(dispatched).toHaveBeenCalledWith({
        sessionId: "destination-1", cwd: targetCwd,
        context: { uri: workspaceHistoryUri, mimeType: "text/plain", text: expect.stringContaining(oldAnswer) },
      });
      expect(sessions.getSession(backend, threadId)).toMatchObject({
        cwd: targetCwd, sessionId: threadId, agentSessionId: "destination-1", executionMode: params.access,
      });
    }
    if (params.restart) {
      await registry.close();
      registry = startOwner();
    }
    const { replay } = await registry.readThread(identity);
    const providerMessages = replay.messages.filter(({ id }) => id !== "monitor-report");
    expect(providerMessages.map((message) => message.text)).toEqual([
      oldPrompt, oldAnswer, newPrompt, `Ran from ${destination}`,
    ]);
    expect(new Set(providerMessages.map(({ id }) => id)).size).toBe(providerMessages.length);
    if (!params.alreadyRooted && !params.roundTrip) {
      expect(providerMessages.at(-1)?.id).toBe(liveReplyId);
    }
    expect(replay.entries.flatMap((entry) => entry.type === "message" && entry.id !== "monitor-report" ? [entry.text] : []))
      .toEqual(providerMessages.map(({ text }) => text));
    if (params.monitorBeforePrompt && params.restart && !params.alreadyRooted && !params.roundTrip) {
      const secondTerminal = Promise.withResolvers<void>();
      const stopListening = registry.onEvent((event) => {
        if (event.notification.method === "turn/completed") secondTerminal.resolve();
      });
      await registry.startTurn({ ...identity, input: [{ type: "text", text: "Continue in the destination" }] });
      await secondTerminal.promise;
      stopListening();
      expect(dispatched).toHaveBeenLastCalledWith({
        sessionId: "destination-1", cwd: destination, context: undefined,
      });
    }
  } finally {
    await registry.close();
    db?.close();
    await rm(root, { force: true, recursive: true });
  }
}

it("moves a populated Full Access thread into a fresh worktree and keeps its history across restart", async () => {
  await checkWorkspaceMove({ access: "full-access", legacy: false, alreadyRooted: false, restart: true });
});

it("starts the replacement Full Access session in native Default even if session/new reports Plan", async () => {
  await checkWorkspaceMove({
    access: "full-access", legacy: false, alreadyRooted: false, restart: false, replacementStartsInPlan: true,
  });
});

it("delivers prior context when a monitor reports before the first destination prompt", async () => {
  await checkWorkspaceMove({
    access: "full-access", legacy: false, alreadyRooted: false, restart: true, monitorBeforePrompt: true,
  });
});

it("preserves source event order when a prompt has no provider timestamp", async () => {
  await checkWorkspaceMove({
    access: "default", legacy: false, alreadyRooted: false, restart: true, withoutSourcePromptTimestamp: true,
  });
});

it("retains the original provider session when two moves return to its checkout before prompting", async () => {
  await checkWorkspaceMove({ access: "default", legacy: false, alreadyRooted: false, restart: false, roundTrip: true });
});

it("uses the live message ID after a cold reload even when the provider omits the prompt timestamp", async () => {
  await checkWorkspaceMove({
    access: "default", legacy: false, alreadyRooted: false, restart: true, withoutDestinationPromptTimestamp: true,
  });
});

it("isolates a reply ID reused by the source and destination providers", async () => {
  await checkWorkspaceMove({
    access: "default", legacy: false, alreadyRooted: false, restart: true, repeatedProviderReplyId: true,
  });
});

it("replays each committed workspace's history once despite abandoned replacement sessions", () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), (abandonedAttempts) => {
    const records = [];
    for (const [index, abandoned] of abandonedAttempts.entries()) {
      const replay = {
        messages: [{ id: String(index), role: "user" as const, text: `Workspace ${index}` }],
        entries: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      };
      if (abandoned) {
        records.push({ update: {
          kind: ACP_WORKSPACE_HANDOFF_RECORD,
          agentSessionId: `abandoned-${index}`,
          previousAgentSessionId: String(index),
          replay,
        } });
      }
      records.push({ update: {
        kind: ACP_WORKSPACE_HANDOFF_RECORD,
        agentSessionId: String(index + 1),
        previousAgentSessionId: String(index),
        replay,
      } });
    }
    const tail = { update: { kind: "agent_message_chunk" } };
    const { previous, current } = acpWorkspaceHistory([...records, tail], String(abandonedAttempts.length));
    expect(previous?.messages.map(({ id }) => id)).toEqual(abandonedAttempts.map((_, index) => String(index)));
    expect(current).toEqual([tail]);
  }));
});

it("bounds SQLite writes for the replacement session and its first turn", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  try {
    await checkWorkspaceMove({ access: "full-access", legacy: false, alreadyRooted: false, restart: false, measureWrites: true });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("dispatches every Antigravity handoff in its destination while preserving thread identity and history", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("default", "full-access"),
    fc.constantFrom("new-move", "legacy-mismatch", "legacy-correct", "round-trip"),
    fc.record({
      restart: fc.boolean(), monitorBeforePrompt: fc.boolean(), withoutSourcePromptTimestamp: fc.boolean(),
      replacementStartsInPlan: fc.boolean(),
    }),
    async (access, state, options) => {
      await checkWorkspaceMove({
        access,
        legacy: state.startsWith("legacy"),
        alreadyRooted: state === "legacy-correct",
        roundTrip: state === "round-trip",
        ...options,
        replacementStartsInPlan: options.replacementStartsInPlan && access === "full-access"
          && (state === "new-move" || state === "legacy-mismatch"),
      });
    },
  ), { numRuns: 16 });
});
