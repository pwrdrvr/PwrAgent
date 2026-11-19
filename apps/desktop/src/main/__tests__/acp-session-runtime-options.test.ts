import type { SetAcpSessionRuntimeOptionRequest, ThreadPermissionTransition } from "@pwragent/shared";
import { expect, it, vi } from "vitest";
import type { AcpRuntimeClient, AcpSessionMetadata } from "../app-server/acp-backend-adapter";
import { AcpSessionRuntimeOptions } from "../app-server/acp-session-runtime-options";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const backend = "acp:fixture";
const threadId = "session";
const request = { backend, threadId, source: "mode", optionId: "mode", value: "yolo" } satisfies SetAcpSessionRuntimeOptionRequest;

function fixture() {
  const db = openInMemoryStateDb();
  const overlay = new SqliteOverlayStore(db);
  const trace: string[] = [];
  const transitions: ThreadPermissionTransition[] = [];
  const setRuntimeOption = vi.fn<NonNullable<AcpRuntimeClient["setRuntimeOption"]>>(async () => undefined);
  let session: AcpSessionMetadata = {
    backendId: backend, sessionId: threadId, title: "Fixture",
    createdAt: 1, updatedAt: 1, status: "idle", executionMode: "default",
    acpRuntime: { currentModeId: "default", updatedAt: 1 },
  };
  const owner = new AcpSessionRuntimeOptions({
    getSession: () => session,
    getClientForSession: async () => ({ ensureSession: async () => {}, setRuntimeOption }),
    getInstalledAgent: () => undefined,
    upsertSession: (next) => { session = next; trace.push("session"); },
  }, overlay, async ({ notification }) => {
    trace.push(notification.method);
    expect((await overlay.getThreadOverlayState({ backend, threadId }))?.executionMode).toBe("full-access");
  }, () => ({
    threadHasActiveTurn: () => true,
    appendPermissionTransition: async ({ transition }) => {
      transitions.push(transition);
      trace.push(transition.status);
    },
  }));
  return { db, owner, setRuntimeOption, trace, transitions };
}

it("coalesces overlapping flushes and persists the mode before publishing the runtime and mode events", async () => {
  const { db, owner, setRuntimeOption, trace, transitions } = fixture();
  const provider = Promise.withResolvers<undefined>();
  setRuntimeOption.mockReturnValue(provider.promise);
  let flushes: Promise<void>[] = [];
  try {
    await owner.setAcpSessionRuntimeOption(request);
    expect(trace).toEqual(["queued"]);
    expect(setRuntimeOption).not.toHaveBeenCalled();
    flushes = [owner.flushQueuedAcpRuntimeOptionIfPresent(backend, threadId),
      owner.flushQueuedAcpRuntimeOptionIfPresent(backend, threadId)];
    provider.resolve(undefined);
    await Promise.all(flushes);
    expect(setRuntimeOption).toHaveBeenCalledTimes(1);
    expect(trace).toEqual(["queued", "session", "applied", "thread/acpRuntime/updated", "thread/executionMode/updated"]);
    expect(transitions[0]?.queueId).toBeDefined();
    expect(transitions[1]?.queueId).toBe(transitions[0]?.queueId);
  } finally {
    provider.resolve(undefined);
    await Promise.allSettled(flushes);
    db.close();
  }
});

it("retires a rejected option after three flushes without emitting an applied mode", async () => {
  const { db, owner, setRuntimeOption, trace, transitions } = fixture();
  setRuntimeOption.mockRejectedValue(new Error("Contrived provider refusal"));
  try {
    await owner.setAcpSessionRuntimeOption(request);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await owner.flushQueuedAcpRuntimeOptionIfPresent(backend, threadId);
    }
    expect(setRuntimeOption).toHaveBeenCalledTimes(3);
    expect(trace).toEqual(["queued", "cancelled"]);
    expect(transitions[1]?.queueId).toBe(transitions[0]?.queueId);
  } finally {
    db.close();
  }
});
