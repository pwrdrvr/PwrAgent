import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MessagingBindingRecord, MessagingInboundCallbackEvent, MessagingSurfaceAction } from "@pwragent/messaging-interface";
import { MessagingAppUpdateControls } from "../messaging/app-update-controls";

function setup() {
  const readiness = { version: "1.4.20", selection: "stable" };
  const state = { target: { ...readiness }, blockers: 0, allowed: true, live: true, persisted: true, failRender: false };
  const saveReceipt = vi.fn(() => state.persisted);
  const handoff = vi.fn();
  const reply = vi.fn(async () => undefined);
  const controls = new MessagingAppUpdateControls({
    runtimeId: "old-runtime", readTarget: () => state.target, blockerCount: () => state.blockers,
    saveReceipt, clearReceipt: vi.fn(),
    async install(request) {
      if (!await request.authorize()) return "refused";
      if (!request.beforeHandoff()) return "refused";
      handoff(request.target);
      return "accepted";
    },
  });
  const room = async (id: string) => {
    const binding: MessagingBindingRecord = {
      backend: "codex", threadId: `agent-${id}`, targetKind: "agent_thread", id, authorizedActorIds: [],
      channel: { channel: "slack", conversation: { kind: "channel", id } }, createdAt: 1, updatedAt: 1,
    };
    const surface = { channel: "slack", id: `${id}-message` } as const;
    const render = vi.fn(async (_presentation: { body: string; actions: MessagingSurfaceAction[] }) => ({
      outcome: state.failRender ? "failed" as const : "presented" as const, channel: "slack" as const, surface, deliveredAt: 1,
    }));
    const text = "PwrAgent update ready · v1.4.20\nDownloaded on Test Workstation (running v1.4.19).";
    await controls.present(binding, readiness.version, text, "test-connection", render);
    const eventFor = (label: string, actor = "admin") => {
      const action = render.mock.lastCall?.[0].actions.find((candidate) => candidate.label === label);
      if (!action) throw new Error(`Missing action ${label}`);
      return {
        id: "tap", kind: "callback", receivedAt: 1, channel: binding.channel,
        actor: { platformUserId: actor }, actionId: action.id, value: action.value,
        interaction: { channel: "slack", id: "interaction" }, sourceSurface: surface,
      } satisfies MessagingInboundCallbackEvent;
    };
    const send = (event: MessagingInboundCallbackEvent, connection = "test-connection") =>
      controls.handle(event, connection, () => state.live, async () => state.allowed, reply);
    const tap = (label: string, actor?: string) => send(eventFor(label, actor));
    return { binding, render, eventFor, tap, send };
  };
  return { state, controls, room, saveReceipt, handoff, reply };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("waits through every nonzero work snapshot and persists one receipt before a reauthorized handoff", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 8 }), { maxLength: 8 }), fc.boolean(),
    async (blocked, stillAllowed) => {
      const fixture = setup();
      try {
        const room = await fixture.room("release-watch");
        fixture.state.blockers = blocked[0] ?? 0;
        await room.tap("Install and restart");
        expect(fixture.handoff).not.toHaveBeenCalled();
        const label = blocked.length ? "Install when idle" : "Install now";
        await room.tap(label, "other-admin");
        expect(fixture.handoff).not.toHaveBeenCalled();
        await room.tap(label);
        for (const blockers of blocked) {
          fixture.state.blockers = blockers;
          await vi.advanceTimersByTimeAsync(2_001);
          expect(fixture.handoff).not.toHaveBeenCalled();
          expect(fixture.saveReceipt).not.toHaveBeenCalled();
        }
        fixture.state.allowed = stillAllowed;
        fixture.state.blockers = 0;
        await vi.advanceTimersByTimeAsync(2_001);
        expect(fixture.saveReceipt).toHaveBeenCalledTimes(Number(stillAllowed));
        expect(fixture.handoff).toHaveBeenCalledTimes(Number(stillAllowed));
        if (stillAllowed) {
          expect(fixture.saveReceipt.mock.invocationCallOrder[0]).toBeLessThan(fixture.handoff.mock.invocationCallOrder[0]!);
        }
      } finally { fixture.controls.dispose(); }
    }), { numRuns: 24 });
});

it("rejects other surfaces, connections and revoked actors, and honors cancellation from another ready room", async () => {
  const fixture = setup();
  const first = await fixture.room("release-watch");
  const second = await fixture.room("build-desk");
  const review = first.eventFor("Install and restart");
  await first.send({ ...review, channel: second.binding.channel });
  await first.send({ ...review, sourceSurface: { channel: "slack", id: "another-post" } });
  await first.send(review, "reconfigured-connection");
  fixture.state.allowed = false;
  await first.send(review);
  expect(first.render).toHaveBeenCalledTimes(1);
  fixture.state.allowed = true;
  fixture.state.blockers = 1;
  await first.send(review);
  await first.tap("Install when idle");
  await second.tap("Cancel install");
  fixture.state.blockers = 0;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fixture.handoff).not.toHaveBeenCalled();
  expect(first.render.mock.lastCall?.[0].body).toContain("Install canceled");
  fixture.controls.dispose();
});

it.each(["superseded", "disconnected", "receipt rejected"])("refuses an accepted wait that becomes %s", async (reason) => {
  const fixture = setup();
  const room = await fixture.room("release-watch");
  fixture.state.blockers = 1;
  await room.tap("Install and restart");
  await room.tap("Install when idle");
  if (reason === "superseded") fixture.state.target.version = "1.4.21";
  if (reason === "disconnected") fixture.state.live = false;
  if (reason === "receipt rejected") fixture.state.persisted = false;
  fixture.state.blockers = 0;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fixture.handoff).not.toHaveBeenCalled();
  fixture.controls.dispose();
});

it("keeps the last visible Cancel action usable after a failed progress edit", async () => {
  const fixture = setup();
  const room = await fixture.room("release-watch");
  fixture.state.blockers = 1;
  await room.tap("Install and restart");
  await room.tap("Install when idle");
  const visibleCancel = room.eventFor("Cancel install");
  fixture.state.blockers = 2;
  fixture.state.failRender = true;
  await vi.advanceTimersByTimeAsync(30_001);
  expect(room.render.mock.lastCall?.[0].body).toContain("2 blockers");
  fixture.state.failRender = false;
  await room.send(visibleCancel);
  fixture.state.blockers = 0;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fixture.handoff).not.toHaveBeenCalled();
  expect(room.render.mock.lastCall?.[0].body).toContain("Install canceled");
  fixture.controls.dispose();
});

it("bounds progress edits while a busy owner keeps changing", async () => {
  const fixture = setup();
  const room = await fixture.room("release-watch");
  fixture.state.blockers = 1;
  await room.tap("Install and restart");
  await room.tap("Install when idle");
  const before = room.render.mock.calls.length;
  for (let blockers = 2; blockers <= 30; blockers += 1) {
    fixture.state.blockers = blockers;
    await vi.advanceTimersByTimeAsync(30_001);
  }
  expect(room.render.mock.calls.length - before).toBe(12);
  await room.tap("Cancel install");
  expect(room.render.mock.lastCall?.[0].body).toContain("Install canceled");
  fixture.controls.dispose();
});
