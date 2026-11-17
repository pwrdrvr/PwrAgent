import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { getOwnerHostServices } from "../owner-host";
import { createPwrAgentAppManagementHandler } from "../agent-tools/pwragent-app-management-service";
import type { PwrAgentAppRequest } from "@pwragent/shared";

const quit = vi.fn(async (_options: { source: string; quietRestart?: boolean }) => true);
const check = vi.fn();
const read = vi.fn(() => ({ status: "idle" as const }));
let generation = "1";

beforeEach(() => {
  generation = "1";
  quit.mockClear();
  check.mockReset();
  read.mockClear();
  read.mockReturnValue({ status: "idle" });
  getOwnerHostServices().updates = { read, check, requestQuit: quit, install: vi.fn(), stateToken: () => generation };
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const request = (action: "restart" | "stop", responseFlushed: Promise<void>): PwrAgentAppRequest => ({
  operation: "manage_pwragent", args: { action }, context: { responseFlushed },
} as PwrAgentAppRequest);

describe("agent lifecycle admission", () => {
  it("denies every management action without trusted authorization before reading or changing updater state", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("status", "upgrade_check", "download", "cancel", "restart", "stop"), async (action) => {
      const authorize = vi.fn(async () => false);
      const handler = createPwrAgentAppManagementHandler({ startedAt: 1, authorize });
      const response = await handler({ operation: "manage_pwragent", context: { responseFlushed: Promise.resolve() }, args: { action } });
      expect(response).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(authorize).toHaveBeenCalledOnce();
    }), { examples: [["status"], ["upgrade_check"], ["download"], ["cancel"], ["restart"], ["stop"]] });
    expect(read).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it("rechecks revoked authorization after response acknowledgement", async () => {
    let allowed = true;
    const authorize = vi.fn(async () => allowed);
    const handler = createPwrAgentAppManagementHandler({ startedAt: 1, authorize });
    const flush = deferred();
    await handler(request("restart", flush.promise));
    allowed = false;
    flush.resolve();
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
    expect(quit).not.toHaveBeenCalled();
  });

  it("starts no lifecycle effect before acknowledgement, and admits at most one request", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("restart", "stop"), { minLength: 1, maxLength: 15 }), async (actions) => {
      quit.mockClear();
      const flush = deferred();
      const handler = createPwrAgentAppManagementHandler({ startedAt: 1, authorize: async () => true });
      for (const action of actions) await handler(request(action, flush.promise));
      expect(quit).not.toHaveBeenCalled();
      flush.resolve();
      await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
      expect(quit.mock.calls[0]?.[0]).toMatchObject({
        source: "agent-tool",
        ...(actions[0] === "restart" ? { quietRestart: true } : {}),
      });
    }), { numRuns: 15 });
  });

  it("cancels on failed acknowledgement and allows a later request", async () => {
    const flush = deferred();
    const handler = createPwrAgentAppManagementHandler({ startedAt: 1, authorize: async () => true });
    await handler(request("restart", flush.promise));
    flush.reject(new Error("client disconnected"));
    await Promise.resolve();
    await Promise.resolve();
    expect(quit).not.toHaveBeenCalled();
    await handler(request("stop", Promise.resolve()));
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  });

  it("binds to the serving process and rejects an ABA update change before acknowledgement", async () => {
    const handler = createPwrAgentAppManagementHandler({ startedAt: 1, authorize: async () => true });
    const status = await handler({ operation: "manage_pwragent", context: {}, args: { action: "status" } });
    if (!status.ok) throw new Error("status unavailable");
    const flush = deferred();
    const args = { action: "restart" as const, expectedStateToken: status.data.stateToken };
    expect(await handler({ operation: "manage_pwragent", context: { responseFlushed: flush.promise }, args })).toMatchObject({ ok: true });
    // The visible status is idle again, but the updater observed a transition.
    generation = "2";
    flush.resolve();
    await vi.waitFor(async () => {
      expect(await handler({ operation: "manage_pwragent", context: {}, args: { action: "status" } })).toMatchObject({ data: { operation: { status: "cancelled" } } });
    });
    expect(quit).not.toHaveBeenCalled();
    const other = createPwrAgentAppManagementHandler({ startedAt: 1, authorize: async () => true });
    expect(await other({ operation: "manage_pwragent", context: { responseFlushed: Promise.resolve() }, args })).toMatchObject({ ok: false });
  });

  it("refuses stale inspected state and an unacknowledged transport without side effects", async () => {
    const handler = createPwrAgentAppManagementHandler({ startedAt: 1, authorize: async () => true });
    expect(await handler({ operation: "manage_pwragent", context: {}, args: { action: "restart" } })).toMatchObject({ ok: false });
    expect(await handler({ ...request("restart", Promise.resolve()), args: { action: "restart", expectedStateToken: "another-runtime" } } as PwrAgentAppRequest)).toMatchObject({ ok: false });
    expect(quit).not.toHaveBeenCalled();
  });
});
