import { setTimeout as delay } from "node:timers/promises";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { afterEach, expect, it, vi } from "vitest";
import { ScriptedCodexTransport } from "./fixtures/turn-event-stream-codex-transport";
import { startDesktopOwnerFixture } from "./helpers/desktop-owner-fixture";

const owner = vi.hoisted(() => ({ registry: undefined as unknown }));
vi.mock("../app-server/backend-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app-server/backend-registry")>()),
  getDesktopBackendRegistry: () => owner.registry,
}));
vi.mock("../acp/acp-instance-discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/acp-instance-discovery")>()),
  discoverLocalAcpAgentRecords: vi.fn(async () => []),
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/turn-event-stream-codex-transport")).ScriptedCodexTransport,
}));

/**
 * Any turn start un-settles a thread, wherever the turn came from: the
 * operator, an automation, a scheduled start or the agent itself. The
 * owner's registry does it as the harness reports the turn, so a settled
 * thread that starts working is back in Unpinned without a viewer acting.
 */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  owner.registry = undefined;
});

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await delay(10);
  }
}

it("un-settles a settled thread when a turn starts, and leaves an unsettled one alone", async () => {
  ScriptedCodexTransport.reset();
  const fixture = await startDesktopOwnerFixture({ tempPrefix: "pwragent-settle-turn", runtimeInstanceId: "settle-turn-desktop" });
  close = fixture.close;
  owner.registry = fixture.registry;
  const { registry, overlayStore, workspace } = fixture;
  const events: AgentEvent[] = [];
  registry.onEvent((event) => { events.push(event); });

  const settled = (await registry.startThread({ backend: "codex", cwd: workspace })).threadId;
  const unsettled = (await registry.startThread({ backend: "codex", cwd: workspace })).threadId;
  await overlayStore.setThreadPin({ backend: "codex", threadId: settled, pinned: true });
  overlayStore.setThreadsSettled({ threads: [{ backend: "codex", threadId: settled }], settled: true, at: 5 });
  expect(await overlayStore.getThreadOverlayState({ backend: "codex", threadId: settled }))
    .toMatchObject({ settledAt: 5 });

  for (const threadId of [settled, unsettled]) {
    ScriptedCodexTransport.notify(threadId, "turn/started", {
      threadId, turn: { id: `turn-${threadId}`, status: "inProgress", items: [], error: null },
    });
  }
  const settledEvents = () => events.filter((event) => event.notification.method === "thread/settled/updated");
  await until(() => settledEvents().length > 0);
  await until(async () => (await overlayStore.getThreadOverlayState({ backend: "codex", threadId: settled }))?.settledAt === undefined);
  // Back in Unpinned, not back in pins: Settle cleared the pin for good.
  expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: settled }))?.pinnedRank).toBeUndefined();
  await delay(50);
  expect(settledEvents().map((event) => event.notification.params)).toEqual([{ threadId: settled }]);
});
