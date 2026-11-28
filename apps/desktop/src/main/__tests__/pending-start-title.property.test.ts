import fc from "fast-check";
import { expect, it } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { buildDirectorySummaries } from "@pwragent/shared/directory-navigation";
import { LiveNavigationIndex } from "../app-server/live-navigation-index";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { createOverlayStoreMock, MockBackendClient } from "./helpers/backend-registry-fixture";

// Raise MBT_RUNS locally to search; CI keeps the run count small. The pinned
// examples count toward numRuns, so the default leaves five generated cases.
const RUNS = Number(process.env.MBT_RUNS ?? 9);

type Command =
  | { kind: "rename"; n: number }
  | { kind: "generated"; n: number }
  | { kind: "echo" }
  | { kind: "materialize" }
  | { kind: "catchUp" }
  | { kind: "nativeFails"; on: boolean }
  | { kind: "nav"; method: "thread/started" | "navigation/providerThreads/refreshed" | "turn/completed" | "thread-created" | "turn/started" }
  | { kind: "read" };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant("rename" as const), n: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant("generated" as const), n: fc.integer({ min: 1, max: 3 }) }),
  fc.constant({ kind: "echo" as const }),
  fc.constant({ kind: "materialize" as const }),
  fc.constant({ kind: "catchUp" as const }),
  fc.record({ kind: fc.constant("nativeFails" as const), on: fc.boolean() }),
  fc.record({ kind: fc.constant("nav" as const), method: fc.constantFrom(
    "thread/started", "navigation/providerThreads/refreshed", "turn/completed", "thread-created", "turn/started") }),
  fc.constant({ kind: "read" as const }),
);

// The owner names a thread it just started (a to-do card's title, an
// operator rename, a generated title). Codex's point read can carry that name
// before thread/list does, or before thread/list includes the thread at all.
// Once named, every settled read serves the owner's latest name.
it("every settled read shows the owner's latest name for a started thread", async () => {
  // `lag`: thread/list shows a name set before it listed one only after catchUp.
  const scenario = fc.tuple(fc.boolean(), fc.array(command, { minLength: 1, maxLength: 24, size: "max" }));
  await fc.assert(fc.asyncProperty(scenario, async ([lag, commands]) => {
    const id = "thread-1";
    // What Codex itself knows, and what its listing reports.
    let codexName: string | undefined;
    let listedName: string | undefined;
    let materialized = false;
    let nativeFails = false;
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/start", "thread/name/set"] }, threads: [],
    });
    const codexRow = (name: string | undefined): AppServerThreadSummary => ({
      id, source: "codex", linkedDirectories: [], projectKey: "/repo-a",
      ...(name ? { title: name, titleSource: "explicit" as const } : { title: "Prompt", titleSource: "derived" as const }),
    });
    Object.assign(codexClient, {
      renameThread: async (params: { threadId: string; name: string }) => {
        codexName = params.name;
        // Lag: a name set before the listing has one appears there only later.
        if (!lag || listedName !== undefined) listedName = codexName;
        return { threadId: params.threadId };
      },
      listThreads: async () => materialized ? [codexRow(listedName)] : [],
      readThreadSummary: async () => {
        if (nativeFails) throw new Error("thread not loaded");
        return codexRow(codexName);
      },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    const project = (rows: AppServerThreadSummary[]): NavigationThreadSummary[] =>
      rows.map((row) => ({ ...row, inbox: { inInbox: false } }));
    const failures: unknown[] = [];
    const live = new LiveNavigationIndex({
      backend: "codex", version: () => "0:0", changedKeys: () => undefined,
      sqlite: async (rows) => rows,
      list: async () => ({ rows: await registry.listThreads({ backend: "codex" }), coverage: { state: "complete" } }),
      join: async (rows, coverage) => {
        const threads = project(rows);
        return { threads, coverage, directories: buildDirectorySummaries({ threads }) };
      },
      cached: (backend, threadId) => registry.getCachedNavigationThread({ backend, threadId }),
      refresh: (backend, threadId, activity, workers) => registry.refreshNavigationThread({ backend, threadId }, activity, workers),
      projectRows: async (rows) => project(rows),
      directories: async (threads) => ({ directories: buildDirectorySummaries({ threads }) }),
      inputKeys: () => new Set(), notify: () => {}, failed: (error) => { failures.push(error); },
    });
    const stop = registry.onEvent((event) => live.event(event));
    let expected = "Untitled thread";
    let explicit = false;
    let named = false;
    const settle = async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const index = await live.read();
        if (live.isCurrent(index)) return index;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("navigation index did not settle");
    };
    const check = async (label: string) => {
      const index = await settle();
      const row = index.threads.find((thread) => thread.id === id);
      const listed = (await registry.listThreads({ backend: "codex" })).find((thread) => thread.id === id);
      const cached = registry.getCachedNavigationThread({ backend: "codex", threadId: id });
      const info = registry.getThreadInfo?.({ backend: "codex", threadId: id });
      const actual = { label, live: row?.title, listed: listed?.title, cached: cached?.title, info: info?.title };
      // Before the owner names it, any placeholder or preview-derived title is fine.
      if (!named) {
        for (const title of [actual.live, actual.listed, actual.cached, actual.info]) {
          expect([undefined, "Untitled thread", "Prompt"], label).toContain(title);
        }
        return;
      }
      expect(actual).toEqual({ label, live: expected, listed: expected, cached: expected, info: expected });
    };
    try {
      await live.read();
      await registry.startThread({ backend: "codex", cwd: "/repo-a" });
      for (const [step, cmd] of commands.entries()) {
        const label = `${step}:${JSON.stringify(cmd)}`;
        if (cmd.kind === "rename") {
          await registry.renameThread({ backend: "codex", threadId: id, name: `Name ${cmd.n}` });
          expected = `Name ${cmd.n}`;
          named = true;
          explicit = true;
        } else if (cmd.kind === "generated") {
          // The title helper never runs over an explicit name.
          if (explicit) continue;
          await registry.renameThread({ backend: "codex", threadId: id, name: `Generated ${cmd.n}` }, { titleSource: "derived" });
          expected = `Generated ${cmd.n}`;
          named = true;
        } else if (cmd.kind === "echo") {
          // Codex's own notification for the name it holds.
          if (!codexName) continue;
          await registry.publishLocalEvent({ backend: "codex", notification: {
            method: "thread/name/updated", params: { threadId: id, threadName: codexName } } });
        } else if (cmd.kind === "materialize") {
          if (!materialized && !lag) listedName = codexName;
          materialized = true;
        } else if (cmd.kind === "catchUp") {
          listedName = codexName;
        } else if (cmd.kind === "nativeFails") {
          nativeFails = cmd.on;
        } else if (cmd.kind === "nav") {
          const notification = cmd.method === "thread-created"
            ? { method: "navigation/threadDirectories/updated", params: { reason: "thread-created", threadIds: [id] } }
            : cmd.method === "navigation/providerThreads/refreshed"
              ? { method: cmd.method, params: { failedProviders: 0, backend: "codex" } }
              : cmd.method === "turn/completed"
                ? { method: cmd.method, params: { threadId: id, turn: { id: "turn-1", status: "completed" } } }
                : cmd.method === "turn/started"
                  ? { method: cmd.method, params: { threadId: id, turn: { id: "turn-1", status: "inProgress" } } }
                  : { method: cmd.method, params: { threadId: id } };
          // Through the registry, which observes some of these before the index does.
          await registry.publishLocalEvent({ backend: "codex", notification } as Parameters<typeof registry.publishLocalEvent>[0]);
        } else {
          await check(label);
        }
      }
      await check("final");
      expect(failures).toEqual([]);
    } finally {
      stop();
      live.close();
      await registry.close();
    }
  }), { numRuns: RUNS, examples: [
    // A point read acknowledged the rename while thread/list omitted the
    // thread; the listing served the pending start's "Untitled thread".
    [[false, [{ kind: "rename", n: 1 }, { kind: "nav", method: "thread/started" }]]],
    // The same acknowledgment while thread/list lists the thread unnamed.
    [[true, [{ kind: "materialize" }, { kind: "rename", n: 1 }]]],
    // The unnamed listing's preview, also `derived`, retired a generated title.
    [[true, [{ kind: "generated", n: 1 }, { kind: "materialize" }, { kind: "read" }, { kind: "rename", n: 1 }]]],
    // A listing that held only the pending start's placeholder, which carries
    // the rename, retired it before thread/list listed the thread unnamed.
    [[true, [{ kind: "rename", n: 1 }, { kind: "read" }, { kind: "materialize" }, { kind: "nav", method: "thread/started" }]]],
  ] });
});
