import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";
import { OUTPOST_VIEWER_CAPABILITIES, startOutpostDaemon } from "./helpers/outpost-daemon";

describe.skipIf(process.platform === "win32")("the E2E Outpost's real Codex protocol fixture", () => {
  let directory: string;
  let preload: string;
  beforeAll(async () => {
    directory = fs.realpathSync(fs.mkdtempSync("/tmp/pa-stdio-"));
    preload = await buildOwnerFixture(directory, "headless", "", "stdio");
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("queued replacement preserves sender ownership and held guidance returns to the same native turn", async () => {
    const host = await startOutpostDaemon({ packageRoot: directory, fixturePreload: preload,
      capabilities: [...OUTPOST_VIEWER_CAPABILITIES, "turn_queue_pause"] });
    const displaced = `${host.workspace}-unavailable`;
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      // A creation response also includes executionMode. Sending it back as
      // guidance would explicitly select turn settings and request a new turn.
      const ref = { backend: created.backend, threadId: created.threadId };
      const active = await host.client.startTurn({ ...ref, input: [{ type: "text", text: "slow" }] });
      const messageOrigin = { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "invented-sender" } };
      const input = [{ type: "text" as const, text: "Invented queued input" }];
      const queued = await host.client.startTurn({ ...ref, input, messageOrigin, delivery: "new_turn", queueEntryId: "stdio-waiting" });
      await expect(host.client.replaceQueuedMessage({ ...ref, input, queueEntryId: queued.queueEntryId! })).rejects.toThrow("Only the sending thread");
      const replacement = await host.client.replaceQueuedMessage({ ...ref, input: [{ type: "text", text: "Invented replacement" }],
        messageOrigin, queueEntryId: queued.queueEntryId! });
      expect(replacement.queueEntryId).not.toBe(queued.queueEntryId);
      await host.client.cancelQueuedTurn({ queueEntryId: replacement.queueEntryId! });
      await host.client.startTurn({ ...ref, queueEntryId: "stdio-agent-guidance", input: [{ type: "text", text: "hold-steer-ack" }], messageOrigin });
      await vi.waitFor(() => expect(fs.existsSync(path.join(host.env.PWRAGENT_TEST_DATA!, "steer.ready"))).toBe(true));
      const heldInput = [{ type: "text" as const, text: "Invented held guidance" }];
      const held = await host.client.startTurn({ ...ref, queueEntryId: "stdio-held", input: heldInput, messageOrigin });
      await host.client.setQueuedTurnPaused({ queueEntryId: held.queueEntryId!, paused: true });
      fs.renameSync(host.workspace, displaced);
      fs.writeFileSync(path.join(host.env.PWRAGENT_TEST_DATA!, "steer.release"), "release");
      await host.client.setQueuedTurnPaused({ queueEntryId: held.queueEntryId!, paused: false });
      const projection = () => host.client.getNavigationQueueProjection({ protocol: 2, ref });
      await vi.waitFor(async () => expect((await projection()).entries[0]?.manualReleaseRequired).toBe(true));
      const before = await projection();
      expect(await host.client.releaseQueuedTurn({ queueEntryId: held.queueEntryId! })).toMatchObject({ disposition: "blocked" });
      expect(await projection()).toEqual(before);
      fs.renameSync(displaced, host.workspace);
      expect(await host.client.releaseQueuedTurn({ queueEntryId: held.queueEntryId! })).toMatchObject({ disposition: "started", turnId: active.turnId });
      expect((await projection()).entries).toEqual([]);
      expect((await host.client.resolveThreadAdmissionState(ref)).activeTurn?.turnId).toBe(active.turnId);
      const calls = fs.readFileSync(path.join(host.env.PWRAGENT_TEST_DATA!, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(calls.filter(call => call.method === "turn/steer" && call.params.input[0].text === heldInput[0].text)).toHaveLength(1);
      await host.client.interruptTurn(active);
    } finally {
      if (fs.existsSync(displaced)) fs.renameSync(displaced, host.workspace);
      await host.close();
    }
  });
});
