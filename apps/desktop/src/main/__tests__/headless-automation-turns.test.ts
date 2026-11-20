import type { AppServerNotification } from "@pwragent/shared/contracts/normalized-app-server";
import { afterEach, expect, it, vi } from "vitest";
import { HeadlessAutomationTurns } from "../app-server/headless-automation-turns";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";

const threadId = "execution-thread";
const turnId = "execution-turn";

function fixture() {
  const client = new CodexAppServerClient();
  const startThread = vi.spyOn(client, "startThread").mockResolvedValue({ threadId });
  const startTurn = vi.spyOn(client, "startTurn").mockResolvedValue({ threadId, turnId });
  const order: string[] = [];
  const bindThread = vi.fn((id: string) => { order.push(`bind:${id}`); });
  const revoke = vi.fn(() => { order.push("revoke"); });
  const owner = new HeadlessAutomationTurns({
    stores: { threads: { getThreadOverlayState: async () => undefined } },
    emit: async ({ notification }) => {
      if (notification.method === "thread/turnQueue/updated" && typeof notification.params.status === "string") {
        order.push(notification.params.status);
      }
    },
  }, {
    prepareAutomationMcp: async () => ({
      connectionIds: [],
      grantedConnectionIds: [],
      serverAliases: {},
      allowedServerNames: [],
      registrations: [{ bindThread, revoke, server: { name: "fixture", command: "fixture", args: [], env: {} } }],
    }),
  }, undefined, () => ({
    assertNotBootstrap: () => {},
    assertThreadOwnership: () => {},
    admitNewThreadModelSettings: async (_backend, settings) => settings,
    getCachedThreadSummary: () => undefined,
    getClient: () => client,
    resolveThreadEnvironmentCwd: async () => undefined,
    withArchiveWorkspaceWrite: async (_paths, work) => await work(),
  }));
  return {
    owner, startThread, startTurn, order, revoke,
    start: () => owner.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "agent", automationRunId: "run",
      input: [{ type: "text", text: "Fixture prompt" }],
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

it.each(["before", "after"] as const)("revokes the grant once when the terminal arrives %s start returns", async (timing) => {
  const run = fixture();
  const terminal: AppServerNotification = {
    method: "turn/completed",
    params: { threadId, turnId, turn: { id: turnId, status: "completed", output: [] } },
  };
  run.startTurn.mockImplementation(async () => {
    expect(run.owner.findHeadlessAutomationForThread("codex", threadId)?.automationRunId).toBe("run");
    if (timing === "before") await run.owner.emitHeadlessAutomationLifecycle("codex", terminal);
    return { threadId, turnId };
  });
  await run.start();
  await run.owner.emitHeadlessAutomationLifecycle("codex", terminal);
  await run.owner.emitHeadlessAutomationLifecycle("codex", terminal);
  expect(run.order).toEqual([`bind:${threadId}`, "started", "revoke", "terminal"]);
  expect(run.owner.findHeadlessAutomationForThread("codex", threadId)).toBeUndefined();
  expect([...run.owner.runningTurns()]).toEqual([]);
});

it.each(["startThread", "startTurn"] as const)("revokes the grant when %s rejects", async (stage) => {
  const run = fixture();
  const failure = new Error("Contrived provider failure");
  run[stage].mockRejectedValueOnce(failure);
  await expect(run.start()).rejects.toBe(failure);
  expect(run.revoke).toHaveBeenCalledTimes(1);
  expect([...run.owner.runningTurns()]).toEqual([]);
  expect(run.order).not.toContain("started");
});
