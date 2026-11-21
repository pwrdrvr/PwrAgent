import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOAT_SANDBOX_POLICY,
  boatSandboxStartAvailability,
  type BoatStartBlock,
} from "@pwragent/shared/contracts/mcp-connections";
import { BoatConnection, type BoatSessionScope } from "../mcp-connections/boat-connection";
import { BOAT_SERVER_INSTRUCTIONS } from "../mcp-connections/boat-tools";

/**
 * The rule: what PwrAgent reports as "Boat can start a sandbox" is what Boat
 * would answer. It holds after any sequence of creates, resumes, forks,
 * stops, deletes and refusals, from any thread or window, and whatever reads
 * of the status were in flight when they happened.
 *
 * The oracle is a fake Boat with a cap on sandboxes running at once. It also
 * runs sandboxes PwrAgent did not start (another computer, Boat's site),
 * which PwrAgent cannot see until it next asks Boat; the model tracks when
 * that is so, and states the rule only once PwrAgent has asked.
 */

const KEY = "boat_live_0123456789abcdefSECRET";
const TRIAL_CAP_SECONDS = 25 * 3600;

type Box = { id: string; state: "ready" | "archived"; external: boolean };

/** Boat, as far as starts are concerned. */
class FakeBoat {
  readonly boxes = new Map<string, Box>();
  trialSpent = false;
  billing = false;
  private next = 0;
  /** Whether it could start, and how many ran, after each change to it. */
  readonly history: Array<{ canStart: boolean; active: number }> = [];

  constructor(
    readonly cap: number,
    /** Boat documents `startBlockedReason` only as a string: sometimes absent. */
    readonly saysReason: boolean,
    /** Delays each answer; the request has already taken effect at Boat. */
    private readonly deliver: <T>(value: T) => Promise<T> = async (value) => value,
  ) {
    this.record();
  }

  /** The index of the latest entry in `history`. */
  get seq(): number {
    return this.history.length - 1;
  }

  private record(): void {
    this.history.push({ canStart: this.canStart(), active: this.active() });
  }

  active(): number {
    return [...this.boxes.values()].filter((box) => box.state === "ready").length;
  }

  /** The refusal code a start gets now, in Boat's order. */
  refusal(): string | undefined {
    if (this.trialSpent) return "trial_compute_limit_reached";
    if (this.billing) return "billing_required";
    if (this.active() >= this.cap) return "limit_reached";
    return undefined;
  }

  canStart(): boolean {
    return this.refusal() === undefined;
  }

  limits(): Record<string, unknown> {
    const refusal = this.refusal();
    return {
      ok: true,
      canStart: refusal === undefined,
      startBlockedReason: this.saysReason ? refusal ?? null : null,
      activeSandboxes: this.active(),
      maxActiveSandboxes: this.cap,
      activeStates: ["provisioned", "cloning", "ready", "idle", "running"],
      trialComputeCapSeconds: TRIAL_CAP_SECONDS,
      trialComputeUsedSeconds: this.trialSpent ? TRIAL_CAP_SECONDS : 60,
      checkoutRequired: this.billing,
    };
  }

  startExternal(): void {
    if (!this.canStart()) return;
    const id = `ext_${this.next++}`;
    this.boxes.set(id, { id, state: "ready", external: true });
  }

  stopExternal(): void {
    const box = [...this.boxes.values()].find((entry) => entry.external && entry.state === "ready");
    if (box) box.state = "archived";
  }

  readonly fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const [root, id, action] = new URL(String(input)).pathname.replace("/api/v1/", "").split("/");
    const answer = (status: number, body: Record<string, unknown>) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const describe = (box: Box) => ({ id: box.id, name: `box-${box.id}`, state: box.state, type: "small" });
    const refuse = (code: string) => answer(code === "billing_required" ? 402 : 429, { ok: false, code, error: `refused: ${code}` });
    const start = (): Response => {
      const code = this.refusal();
      if (code) return refuse(code);
      const box: Box = { id: `bx_${this.next++}`, state: "ready", external: false };
      this.boxes.set(box.id, box);
      return answer(200, { ok: true, sandbox: describe(box) });
    };
    let response: Response;
    if (root === "limits") {
      response = answer(200, this.limits());
    } else if (root === "sandboxes" && !id && method === "POST") {
      response = start();
    } else {
      const box = id ? this.boxes.get(id) : undefined;
      if (!box) {
        response = answer(404, { ok: false, code: "not_found", error: "no such sandbox" });
      } else if (method === "DELETE") {
        this.boxes.delete(box.id);
        response = answer(200, { ok: true });
      } else if (action === "stop") {
        box.state = "archived";
        response = answer(200, { ok: true, status: "stopping" });
      } else if (action === "resume") {
        if (box.state === "ready") {
          response = answer(200, { ok: true, status: "ready" });
        } else {
          const code = this.refusal();
          if (code) {
            response = refuse(code);
          } else {
            box.state = "ready";
            response = answer(200, { ok: true, status: "resuming" });
          }
        }
      } else if (action === "fork") {
        response = start();
      } else {
        response = answer(200, { ok: true, sandbox: describe(box) });
      }
    }
    if (method !== "GET") this.record();
    return await this.deliver(response);
  };
}

function harness(boat: FakeBoat) {
  const connection = new BoatConnection({
    secrets: {
      read: async () => ({ BOAT_API_KEY: KEY }),
      write: async () => undefined,
    },
    fetchFn: boat.fetchFn,
    policy: () => DEFAULT_BOAT_SANDBOX_POLICY,
    openExternal: async () => undefined,
    // The clock never moves: only an event may make the status stale.
    now: () => 1_000_000,
  });
  const owned = new Map<string, Set<string>>();
  const scope = (threadId: string): BoatSessionScope => {
    const mine = owned.get(threadId) ?? new Set<string>();
    owned.set(threadId, mine);
    return {
      role: "thread",
      ownedSandboxIds: () => mine,
      recordOwned: ({ sandboxId }) => {
        mine.add(sandboxId);
      },
      forgetOwned: (sandboxId) => {
        mine.delete(sandboxId);
      },
    };
  };
  return { connection, owned, scope };
}

const THREADS = ["thread-a", "thread-b"] as const;

/**
 * Releases scheduled answers one at a time, in the scheduler's order, until
 * `work` settles. A request is scheduled only once its caller reaches
 * `fetch`, so an empty queue waits a macrotask rather than giving up. (Not
 * `waitFor`: a scheduled task that awaits another scheduled task stalls it.)
 */
async function drain(scheduler: fc.Scheduler, work: Promise<unknown>): Promise<void> {
  let settled = false;
  void work.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    if (scheduler.count() > 0) await scheduler.waitOne();
    // Whatever the released answer starts runs to its next request before
    // another is released, so a sandbox change can finish between two.
    await new Promise((resolve) => setImmediate(resolve));
  }
  await work;
}

type Command =
  | { kind: "create" | "account_status"; thread: number }
  | { kind: "stop" | "resume" | "fork" | "delete"; thread: number; pick: number }
  | { kind: "external_start" | "external_stop" | "spend_trial" | "billing_on" | "billing_off" }
  | { kind: "read" | "refresh" };

const thread = fc.nat({ max: THREADS.length - 1 });
const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("create" as const), thread }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("account_status" as const), thread }) },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constantFrom("stop" as const, "resume" as const, "fork" as const, "delete" as const),
      thread,
      pick: fc.nat({ max: 7 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constantFrom(
        "external_start" as const, "external_start" as const, "external_stop" as const,
        "spend_trial" as const, "billing_on" as const, "billing_off" as const,
      ),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constantFrom("read" as const, "refresh" as const) }) },
);

/** What each of Boat's refusals means to the operator. */
const EXPECTED_BLOCK: Record<string, BoatStartBlock> = {
  limit_reached: "concurrent_limit",
  trial_compute_limit_reached: "trial_compute_used",
  billing_required: "billing_required",
};

async function expectAgrees(
  connection: BoatConnection,
  boat: FakeBoat,
  steps: readonly unknown[],
): Promise<void> {
  const status = await connection.readStatus();
  const account = status.boatAccount;
  const refusal = boat.refusal();
  const said = { canStart: account?.canStart, active: account?.activeSandboxes, block: account?.startBlock };
  const truth = {
    canStart: refusal === undefined,
    active: boat.active(),
    block: refusal ? EXPECTED_BLOCK[refusal] : undefined,
  };
  expect(said, JSON.stringify(steps)).toEqual(truth);
  // What an agent reads through manage_mcp_connections says the same.
  expect(boatSandboxStartAvailability(status).canStart).toBe(truth.canStart);
}

describe("whether Boat can start a sandbox", () => {
  it("matches a fake Boat with a cap after any sequence of starts, stops, deletes and refusals", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.boolean(),
        fc.array(command, { minLength: 4, maxLength: 30 }),
        async (cap, saysReason, commands) => {
          const boat = new FakeBoat(cap, saysReason);
          const { connection, owned, scope } = harness(boat);
          await connection.readStatus();
          // Set while something PwrAgent did not do has changed Boat and
          // PwrAgent has not asked since: no event told it.
          let unseen = false;
          const steps: unknown[] = [];
          for (const step of commands) {
            steps.push(step);
            switch (step.kind) {
              case "create":
                await connection.callTool(scope(THREADS[step.thread]!), "create_sandbox", {});
                unseen = false;
                break;
              case "account_status":
                await connection.callTool(scope(THREADS[step.thread]!), "account_status", {});
                unseen = false;
                break;
              case "stop":
              case "resume":
              case "fork":
              case "delete": {
                const ids = [...(owned.get(THREADS[step.thread]!) ?? [])];
                if (ids.length === 0) continue;
                const sandboxId = ids[step.pick % ids.length]!;
                await connection.callTool(scope(THREADS[step.thread]!), `${step.kind}_sandbox`, { sandboxId });
                unseen = false;
                break;
              }
              case "external_start":
                boat.startExternal();
                unseen = true;
                break;
              case "external_stop":
                boat.stopExternal();
                unseen = true;
                break;
              case "spend_trial":
                boat.trialSpent = true;
                unseen = true;
                break;
              case "billing_on":
                boat.billing = true;
                unseen = true;
                break;
              case "billing_off":
                boat.billing = false;
                unseen = true;
                break;
              case "read":
                await connection.readStatus();
                break;
              case "refresh":
                await connection.readStatus(true);
                unseen = false;
                break;
            }
            if (!unseen) await expectAgrees(connection, boat, steps);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("never keeps a status read that a sandbox change overtook", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.integer({ min: 1, max: 3 }),
        fc.array(
          fc.constantFrom("read", "refresh", "create", "create", "stop", "delete", "account_status"),
          { minLength: 3, maxLength: 10 },
        ),
        async (scheduler, cap, actions) => {
          const boat = new FakeBoat(cap, true, async (value) => await scheduler.schedule(Promise.resolve(value)));
          const { connection, owned, scope } = harness(boat);
          await drain(scheduler, connection.readStatus());
          const mine = scope("thread-a");
          // Boat's state once every change PwrAgent has seen finish: a read
          // that starts later must answer with that state or a newer one.
          let finished = boat.seq;
          const stale: string[] = [];
          const read = async (refresh: boolean) => {
            const floor = finished;
            const status = await connection.readStatus(refresh);
            const said = { canStart: status.boatAccount?.canStart, active: status.boatAccount?.activeSandboxes };
            const current = boat.history.slice(floor, boat.seq + 1);
            if (!current.some((state) => state.canStart === said.canStart && state.active === said.active)) {
              stale.push(`${JSON.stringify(said)} not in ${JSON.stringify(current)}`);
            }
          };
          const running = actions.map(async (action) => {
            // Each starts at a moment the scheduler picks.
            await scheduler.schedule(Promise.resolve());
            switch (action) {
              case "read":
                return await read(false);
              case "refresh":
                // Settings' Refresh status: always asks Boat, so reads are in
                // flight while sandboxes change.
                return await read(true);
              case "account_status":
                return await connection.callTool(mine, "account_status", {});
              case "create":
                await connection.callTool(mine, "create_sandbox", {});
                finished = Math.max(finished, boat.seq);
                return undefined;
              default: {
                const ids = [...(owned.get("thread-a") ?? [])];
                if (ids.length === 0) return undefined;
                await connection.callTool(mine, `${action}_sandbox`, { sandboxId: ids[0]! });
                finished = Math.max(finished, boat.seq);
                return undefined;
              }
            }
          });
          await drain(scheduler, Promise.all(running));
          expect(stale, String(scheduler)).toEqual([]);
          await drain(scheduler, connection.readStatus());
          await expectAgrees(connection, boat, [String(scheduler), ...actions]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Boat's server instructions", () => {
  it("fit the gateway's 2,000 characters, so the last sentences reach the agent", () => {
    // MAX_SERVER_INSTRUCTIONS_CHARS in mcp-connection-gateway-service.ts.
    expect(BOAT_SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2_000);
    expect(BOAT_SERVER_INSTRUCTIONS).toContain("account_status says whether a start would succeed now.");
  });
});

describe("a status read in flight when a sandbox starts", () => {
  it("is not the answer a read that begins after the start gets", async () => {
    // Boat answers the first status read only when told to.
    const held: Array<() => void> = [];
    let hold = false;
    const boat = new FakeBoat(2, true, async (value) => {
      if (!hold) return value;
      hold = false;
      await new Promise<void>((resolve) => held.push(resolve));
      return value;
    });
    const { connection, scope } = harness(boat);
    await connection.readStatus();

    hold = true;
    const before = connection.readStatus(true);
    await connection.callTool(scope("thread-a"), "create_sandbox", {});
    const after = connection.readStatus();
    held.shift()?.();

    await expect(before).resolves.toMatchObject({ boatAccount: { activeSandboxes: 0 } });
    await expect(after).resolves.toMatchObject({ boatAccount: { activeSandboxes: 1 } });
    await expect(connection.readStatus()).resolves.toMatchObject({ boatAccount: { activeSandboxes: 1 } });
  });
});

describe("a refused start", () => {
  it("is learned at once, even by a key that cannot read the account's limits", async () => {
    const boat = new FakeBoat(1, false);
    const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> =>
      String(input).endsWith("/limits")
        ? new Response(JSON.stringify({ ok: false, code: "api_key_action_forbidden", error: "no" }), { status: 403 })
        : await boat.fetchFn(input, init);
    const connection = new BoatConnection({
      secrets: { read: async () => ({ BOAT_API_KEY: KEY }), write: async () => undefined },
      fetchFn,
      policy: () => DEFAULT_BOAT_SANDBOX_POLICY,
      openExternal: async () => undefined,
      now: () => 1_000_000,
    });
    const owned = new Set<string>();
    const scope: BoatSessionScope = {
      role: "thread",
      ownedSandboxIds: () => owned,
      recordOwned: ({ sandboxId }) => owned.add(sandboxId),
      forgetOwned: (sandboxId) => owned.delete(sandboxId),
    };
    await expect(connection.readStatus()).resolves.toMatchObject({ state: "ready" });
    expect(boatSandboxStartAvailability(connection.cachedStatus()).canStart).toBeNull();

    boat.trialSpent = true;
    const refused = await connection.callTool(scope, "create_sandbox", {});
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("trial's compute time is used up");

    // Known without asking Boat again.
    expect(connection.cachedStatus().boatAccount).toMatchObject({
      canStart: false, startBlock: "trial_compute_used", blockedReason: "trial_compute_limit_reached",
    });
    expect(boatSandboxStartAvailability(connection.cachedStatus())).toMatchObject({
      canStart: false, reason: "trial_compute_used",
    });
  });

  it("at the running limit names this thread's running sandboxes and never another thread's", async () => {
    const boat = new FakeBoat(3, true);
    const { connection, scope } = harness(boat);
    const a = scope("thread-a");
    const b = scope("thread-b");
    await connection.callTool(a, "create_sandbox", { name: "web" });
    await connection.callTool(a, "create_sandbox", { name: "db" });
    await connection.callTool(a, "stop_sandbox", { sandboxId: "bx_1" });
    await connection.callTool(b, "create_sandbox", { name: "theirs" });
    boat.startExternal();
    expect(boat.active()).toBe(3);

    const refused = await connection.callTool(a, "create_sandbox", {});
    const text = refused.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(refused.isError).toBe(true);
    expect(text).toContain("3 of 3 Boat sandboxes are running");
    expect(text).toContain("bx_0 (box-bx_0), ready");
    // Stopped: it takes no slot.
    expect(text).not.toContain("bx_1");
    // Another thread's, and one PwrAgent did not start.
    expect(text).not.toContain("bx_2");
    expect(text).not.toContain("ext_");

    // A thread with nothing running is told the slots are taken elsewhere.
    const elsewhere = await connection.callTool(scope("thread-c"), "create_sandbox", {});
    expect(JSON.stringify(elsewhere.content)).toContain("no running sandbox to stop");

    const status = await connection.callTool(a, "account_status", {});
    expect(status.structuredContent).toMatchObject({
      canStart: false, startBlock: "concurrent_limit", activeSandboxes: 3, maxActiveSandboxes: 3,
      ownRunning: [{ id: "bx_0", name: "box-bx_0", state: "ready" }],
    });
    expect(JSON.stringify(status.structuredContent)).not.toContain("bx_2");
    expect(connection.cachedStatus().boatAccount).toMatchObject({ canStart: false, startBlock: "concurrent_limit" });

    // Stopping one frees the slot, and the next read says so.
    await connection.callTool(a, "stop_sandbox", { sandboxId: "bx_0" });
    await expect(connection.readStatus()).resolves.toMatchObject({
      boatAccount: { canStart: true, activeSandboxes: 2, maxActiveSandboxes: 3 },
    });
  });
});
