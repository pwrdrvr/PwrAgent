import { afterEach, describe, expect, it, vi } from "vitest";
import type { FederationInstanceShortName } from "@pwragent/shared";
import {
  FEDERATION_SHORT_NAME_QUIET_MS,
  FEDERATION_SHORT_NAME_RETRY_MS,
  FEDERATION_SHORT_NAMES_META_KEY,
  FederationShortNameCoordinator,
  type FederationShortNameInstance,
} from "../federation/federation-short-names";
import type {
  FederationShortNameGenerationResult,
  FederationShortNamePlan,
} from "../federation/federation-short-name-generator";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

type Answer = (plan: FederationShortNamePlan) => FederationShortNameGenerationResult;

const named = (pairs: Record<string, string>): Answer => () => ({
  ok: true,
  names: new Map(Object.entries(pairs)),
});

function harness(options?: {
  instances?: FederationShortNameInstance[];
  answer?: Answer;
  coordinator?: boolean;
  meta?: { get: () => string | undefined; set: (value: string) => void };
}) {
  let stored = "";
  let clock = 1_000_000;
  const state = {
    instances: options?.instances ?? [
      { id: "inst_studio", label: "Studio-MBP-M5-Max", profileName: "default" },
      { id: "inst_studio_dev", label: "Studio-MBP-M5-Max", profileName: "dev" },
      { id: "inst_laptop", label: "MBP-M2-Max" },
      { id: "inst_win", label: "DESKTOP-17ISFOI", host: { platform: "win32" } },
    ] as FederationShortNameInstance[],
    coordinator: options?.coordinator ?? true,
    answer: options?.answer ?? named({ "Studio-MBP-M5-Max": "M5 Max", "DESKTOP-17ISFOI": "Win PC" }),
    writes: 0,
    published: 0,
    broadcasts: [] as Array<{ entries: FederationInstanceShortName[]; excludePeerId?: string }>,
    sends: [] as Array<{ peerId: string; entries: FederationInstanceShortName[] }>,
  };
  const plans: FederationShortNamePlan[] = [];
  const coordinator = new FederationShortNameCoordinator({
    readMeta: options?.meta?.get ?? (() => stored),
    writeMeta: (value) => {
      state.writes += 1;
      if (options?.meta) options.meta.set(value);
      else stored = value;
    },
    isCoordinator: () => state.coordinator,
    listInstances: () => state.instances,
    generate: async (plan) => {
      plans.push(plan);
      return state.answer(plan);
    },
    broadcast: (entries, excludePeerId) => state.broadcasts.push({ entries, excludePeerId }),
    sendTo: (peerId, entries) => state.sends.push({ peerId, entries }),
    publishChanged: () => {
      state.published += 1;
    },
    now: () => clock,
  });
  return {
    coordinator,
    state,
    plans,
    advance: (ms: number) => {
      clock += ms;
    },
    async settle() {
      coordinator.reconcile();
      await coordinator.flush();
    },
    short: (id: string) =>
      coordinator.shortLabelFor(id, state.instances.find((instance) => instance.id === id)!.label),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("FederationShortNameCoordinator on the gateway", () => {
  it("names long labels once, shares a name across a machine's profiles, and keeps short labels", async () => {
    const h = harness();
    await h.settle();

    expect(h.plans).toHaveLength(1);
    expect(h.plans[0].candidates.map((machine) => machine.label)).toEqual([
      "Studio-MBP-M5-Max",
      "DESKTOP-17ISFOI",
    ]);
    expect(h.plans[0].candidates[0].profiles).toEqual(["default", "dev"]);
    expect(h.plans[0].reserved).toEqual([{ label: "MBP-M2-Max", name: "MBP-M2-Max", reason: "short" }]);
    expect(h.short("inst_studio")).toBe("M5 Max");
    expect(h.short("inst_studio_dev")).toBe("M5 Max");
    expect(h.short("inst_win")).toBe("Win PC");
    expect(h.short("inst_laptop")).toBeUndefined();
    // One persisted write, one renderer event, one broadcast for the batch.
    expect(h.state.writes).toBe(1);
    expect(h.state.published).toBe(1);
    expect(h.state.broadcasts).toHaveLength(1);
  });

  it("asks nothing and writes nothing when a reconnect brings the same machines", async () => {
    const h = harness();
    await h.settle();
    const writes = h.state.writes;
    await h.settle();
    await h.settle();
    expect(h.plans).toHaveLength(1);
    expect(h.state.writes).toBe(writes);
  });

  it("waits for the connect burst to go quiet before asking", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.coordinator.reconcile();
    await vi.advanceTimersByTimeAsync(FEDERATION_SHORT_NAME_QUIET_MS - 1);
    h.coordinator.reconcile();
    await vi.advanceTimersByTimeAsync(FEDERATION_SHORT_NAME_QUIET_MS - 1);
    expect(h.plans).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.plans).toHaveLength(1);
  });

  it("sends the whole set with current names when a machine joins, and keeps unchanged entries untouched", async () => {
    const h = harness();
    await h.settle();
    const winBefore = h.coordinator.entries().find((entry) => entry.instanceId === "inst_win");
    h.state.instances.push({ id: "inst_studio2", label: "Mac-Studio-M5-Max" });
    h.state.answer = named({
      "Studio-MBP-M5-Max": "M5 Max MBP",
      "Mac-Studio-M5-Max": "M5 Studio",
      "DESKTOP-17ISFOI": "Win PC",
    });
    h.advance(10);
    await h.settle();

    expect(h.plans).toHaveLength(2);
    expect(h.plans[1].candidates.map((machine) => [machine.label, machine.current])).toEqual([
      ["Studio-MBP-M5-Max", "M5 Max"],
      ["DESKTOP-17ISFOI", "Win PC"],
      ["Mac-Studio-M5-Max", undefined],
    ]);
    expect(h.short("inst_studio")).toBe("M5 Max MBP");
    expect(h.short("inst_studio2")).toBe("M5 Studio");
    expect(h.coordinator.entries().find((entry) => entry.instanceId === "inst_win")).toEqual(winBefore);
  });

  it("does not ask when a machine leaves", async () => {
    const h = harness();
    await h.settle();
    h.state.instances = h.state.instances.filter((instance) => instance.id !== "inst_win");
    await h.settle();
    expect(h.plans).toHaveLength(1);
  });

  it("rejects an invalid answer whole and does not retry the same machines", async () => {
    const h = harness({ answer: () => ({ ok: false, reason: "name_not_unique", answered: true }) });
    await h.settle();
    expect(h.coordinator.entries()).toEqual([]);
    h.advance(FEDERATION_SHORT_NAME_RETRY_MS * 2);
    await h.settle();
    expect(h.plans).toHaveLength(1);
    // A changed set is a new input.
    h.state.instances.push({ id: "inst_new", label: "Linux-Build-Box" });
    await h.settle();
    expect(h.plans).toHaveLength(2);
  });

  it("retries an unanswered call after the retry window", async () => {
    const h = harness({ answer: () => ({ ok: false, reason: "codex_unavailable", answered: false }) });
    await h.settle();
    await h.settle();
    expect(h.plans).toHaveLength(1);
    h.advance(FEDERATION_SHORT_NAME_RETRY_MS);
    h.state.answer = named({ "Studio-MBP-M5-Max": "M5 Max", "DESKTOP-17ISFOI": "Win PC" });
    await h.settle();
    expect(h.plans).toHaveLength(2);
    expect(h.short("inst_studio")).toBe("M5 Max");
  });

  it("discards an answer when the machines changed while the model thought", async () => {
    const h = harness();
    h.state.answer = (plan) => {
      h.state.instances.push({ id: "inst_late", label: "Late-Joiner-Box" });
      return named({ "Studio-MBP-M5-Max": "M5 Max", "DESKTOP-17ISFOI": "Win PC" })(plan);
    };
    h.coordinator.reconcile();
    await h.coordinator.flush();
    expect(h.coordinator.entries()).toEqual([]);
  });

  it("shows a renamed machine's full label until it is named again", async () => {
    const h = harness();
    await h.settle();
    h.state.instances[0] = { ...h.state.instances[0], label: "Studio-M5-Max-2" };
    h.state.instances[1] = { ...h.state.instances[1], label: "Studio-M5-Max-2" };
    expect(h.short("inst_studio")).toBeUndefined();
    h.state.answer = named({ "Studio-M5-Max-2": "M5 Max", "DESKTOP-17ISFOI": "Win PC" });
    await h.settle();
    expect(h.plans).toHaveLength(2);
    expect(h.short("inst_studio")).toBe("M5 Max");
  });

  it("gives a new profile of a named machine its name without asking", async () => {
    const h = harness();
    await h.settle();
    h.state.instances.push({ id: "inst_win_dev", label: "DESKTOP-17ISFOI", profileName: "dev" });
    await h.settle();
    expect(h.plans).toHaveLength(1);
    expect(h.short("inst_win_dev")).toBe("Win PC");
  });

  it("applies an operator name to every profile and reserves it from the model", async () => {
    const h = harness();
    await h.settle();
    h.advance(1);
    h.coordinator.setOverride("inst_studio_dev", "  Studio ");
    expect(h.short("inst_studio")).toBe("Studio");
    expect(h.short("inst_studio_dev")).toBe("Studio");

    h.state.instances.push({ id: "inst_new", label: "Linux-Build-Box" });
    h.state.answer = named({ "DESKTOP-17ISFOI": "Win PC", "Linux-Build-Box": "Linux box" });
    await h.settle();
    expect(h.plans[1].reserved).toContainEqual({ label: "Studio-MBP-M5-Max", name: "Studio", reason: "override" });
    expect(h.short("inst_studio")).toBe("Studio");
  });

  it("refuses an operator name another machine already shows", async () => {
    const h = harness();
    await h.settle();
    expect(() => h.coordinator.setOverride("inst_studio", "win pc")).toThrow("DESKTOP-17ISFOI already uses that name.");
    expect(() => h.coordinator.setOverride("inst_studio", "mbp-m2-max")).toThrow("already uses that name");
    expect(() => h.coordinator.setOverride("inst_studio", "a name that is far too long")).toThrow("1 to 12 characters");
  });

  it("hands a machine back to the gateway when its override is cleared", async () => {
    const h = harness();
    await h.settle();
    h.advance(1);
    h.coordinator.setOverride("inst_studio", "Studio");
    h.advance(1);
    h.coordinator.setOverride("inst_studio", null);
    expect(h.short("inst_studio")).toBeUndefined();
    await h.coordinator.flush();
    expect(h.plans).toHaveLength(2);
    expect(h.plans[1].candidates.find((machine) => machine.label === "Studio-MBP-M5-Max")?.current).toBeUndefined();
    expect(h.short("inst_studio")).toBe("M5 Max");
  });

  it("announces its map to the peer that connected, and only to it", async () => {
    const h = harness();
    h.coordinator.announce("inst_laptop");
    // Nothing to say before any name exists.
    expect(h.state.sends).toEqual([]);
    await h.settle();
    const broadcasts = h.state.broadcasts.length;
    h.coordinator.announce("inst_laptop");
    expect(h.state.sends).toEqual([{ peerId: "inst_laptop", entries: h.coordinator.entries() }]);
    expect(h.state.broadcasts).toHaveLength(broadcasts);
  });

  it("extends a peer's override to the machine's other profiles in one write", async () => {
    const h = harness();
    await h.settle();
    const writes = h.state.writes;
    const broadcasts = h.state.broadcasts.length;
    const studio = h.coordinator.entries().find((entry) => entry.instanceId === "inst_studio")!;
    h.advance(10);
    // A client renamed one profile while the gateway was out of reach.
    expect(h.coordinator.apply([{
      ...studio,
      shortLabel: "Studio",
      source: "override",
      updatedAt: studio.updatedAt + 5,
    }], "inst_laptop")).toBe(true);
    expect(h.short("inst_studio")).toBe("Studio");
    expect(h.short("inst_studio_dev")).toBe("Studio");
    expect(h.state.writes).toBe(writes + 1);
    expect(h.state.broadcasts).toHaveLength(broadcasts + 1);
    // The source learns about the sibling too.
    expect(h.state.broadcasts.at(-1)?.excludePeerId).toBeUndefined();
  });

  it("tombstones a revoked instance and propagates the removal", async () => {
    const h = harness();
    await h.settle();
    h.advance(1);
    h.coordinator.remove("inst_win", 2_000_000);
    const entry = h.coordinator.entries().find((candidate) => candidate.instanceId === "inst_win");
    expect(entry).toMatchObject({ removed: true });
    expect(h.state.broadcasts.at(-1)?.entries).toContainEqual(entry);
  });
});

describe("FederationShortNameCoordinator on a client", () => {
  it("merges the gateway's map, re-sends only a real change, and never generates", async () => {
    const gateway = harness();
    await gateway.settle();
    const snapshot = gateway.coordinator.entries();

    const client = harness({ coordinator: false });
    expect(client.coordinator.apply(snapshot, "inst_gateway")).toBe(true);
    expect(client.short("inst_studio")).toBe("M5 Max");
    expect(client.state.broadcasts).toEqual([{ entries: snapshot, excludePeerId: "inst_gateway" }]);
    expect(client.state.writes).toBe(1);

    expect(client.coordinator.apply(snapshot, "inst_gateway")).toBe(false);
    expect(client.state.broadcasts).toHaveLength(1);
    expect(client.state.writes).toBe(1);

    client.state.instances.push({ id: "inst_new", label: "Linux-Build-Box" });
    await client.settle();
    expect(client.plans).toHaveLength(0);
  });

  it("ignores malformed snapshots", () => {
    const client = harness({ coordinator: false });
    expect(client.coordinator.apply("nope", "inst_gateway")).toBe(false);
    expect(client.coordinator.apply([{ instanceId: "x" }], "inst_gateway")).toBe(false);
    expect(client.state.writes).toBe(0);
  });

  it("persists the map so names survive a restart", async () => {
    let stored = "";
    const meta = { get: () => stored, set: (value: string) => { stored = value; } };
    const gateway = harness({ meta });
    await gateway.settle();
    const restarted = harness({ meta });
    expect(restarted.short("inst_studio")).toBe("M5 Max");
    await restarted.settle();
    expect(restarted.plans).toHaveLength(0);
  });
});

describe("FederationShortNameCoordinator write budget", () => {
  it("costs nothing on reconnect and one commit per real change", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { dbPath, tempDir } = createTempStateDb("pwragent-short-names-");
    const db = StateDb.open(dbPath);
    try {
      const meta = {
        get: () => db.getMeta(FEDERATION_SHORT_NAMES_META_KEY) ?? "",
        set: (value: string) => db.setMeta(FEDERATION_SHORT_NAMES_META_KEY, value),
      };
      const gateway = harness({ meta });

      const named = await measureSqliteWrites(async () => {
        await gateway.settle();
      });
      expectSqliteWriteBudget({
        scenario: "federation-short-names-generate",
        writes: named.writes,
        note: "gateway names a federation's machines in one helper turn: one meta commit for the batch. Runs only when a machine joins or is renamed, a few times a year; effectively 0 MB/day",
      });

      const snapshot = gateway.coordinator.entries();
      const reconnect = await measureSqliteWrites(async () => {
        for (let index = 0; index < 20; index += 1) {
          await gateway.settle();
          gateway.coordinator.announce("inst_laptop");
          gateway.coordinator.apply(snapshot, "inst_laptop");
        }
      });
      expectSqliteWriteBudget({
        scenario: "federation-short-names-reconnect",
        writes: reconnect.writes,
        note: "20 reconnects that re-send an unchanged short-name map, reconcile, announce and merge: zero commits; 0 MB/day",
      });
    } finally {
      db.close();
      removeTempStateDbDir(tempDir);
    }
  });
});
