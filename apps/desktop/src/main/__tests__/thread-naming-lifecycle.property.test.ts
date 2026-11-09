import fc from "fast-check";
import { expect, it } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Rule: once an explicit rename is admitted, a helper already in flight may
// never replace it, even after its last eligibility read has completed.
async function lateHelperRename(suffix: string): Promise<void> {
  const db = openInMemoryStateDb();
  const readStarted = deferred<void>();
  const finishRead = deferred<void>();
  const prompt = "Inspect the invented fixture";
  const operatorTitle = `Operator ${suffix}`.trim();
  let title = prompt;
  const events: AgentEvent[] = [];
  const registry = new DesktopBackendRegistry({
    codexClient: {
      close: async () => {},
      getInitializeResult: async () => ({ methods: [] }),
      listThreads: async () => [],
      readThreadSummary: async () => ({ id: "thread", title: prompt, titleSource: "fallback", source: "codex", linkedDirectories: [] }),
      renameThread: async ({ threadId, name }: { threadId: string; name: string }) => {
        title = name;
        return { threadId };
      },
      onNotification: () => () => {},
      onPendingRequest: () => () => {},
    } as never,
    overlayStore: new SqliteOverlayStore(db),
    threadTitleGenerationService: {
      generateTitle: async () => ({ status: "generated", title: "Helper title" }),
    } as never,
  });
  const applyTitle = registry["threadNaming"].applyGeneratedTitle.bind(registry["threadNaming"]);
  registry["threadNaming"].applyGeneratedTitle = async (params) => {
    readStarted.resolve();
    await finishRead.promise;
    return await applyTitle(params);
  };
  registry.onEvent((event) => { events.push(event); });
  try {
    registry["scheduleThreadTitleGeneration"]({ backend: "codex", threadId: "thread", input: [{ type: "text", text: prompt }] });
    await readStarted.promise;
    await registry.renameThread({ backend: "codex", threadId: "thread", name: operatorTitle });
    finishRead.resolve();
    await registry.whenThreadTitleGenerationSettledForTests();
    expect(title).toBe(operatorTitle);
    expect(events.filter((event) => event.notification.method === "thread/name/updated")).toHaveLength(1);
  } finally {
    finishRead.resolve();
    await registry.close();
    db.close();
  }
}

it("preserves an explicit rename between helper eligibility and application", async () => {
  await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 30 }), lateHelperRename), { numRuns: 25 });
});

it("keeps Operator when the helper finishes later (shrunk counterexample)", async () => {
  await lateHelperRename(" ");
});

it("does not start a later helper after an explicit rename matching the first prompt", async () => {
  const db = openInMemoryStateDb();
  const prompt = "Inspect the invented fixture";
  let generated = 0;
  const registry = new DesktopBackendRegistry({
    codexClient: {
      close: async () => {}, getInitializeResult: async () => ({ methods: [] }), listThreads: async () => [],
      readThreadSummary: async () => ({ id: "thread", title: prompt, titleSource: "fallback", source: "codex", linkedDirectories: [] }),
      renameThread: async ({ threadId }: { threadId: string }) => ({ threadId }),
      onNotification: () => () => {}, onPendingRequest: () => () => {},
    } as never,
    overlayStore: new SqliteOverlayStore(db),
    threadTitleGenerationService: { generateTitle: async () => { generated++; return { status: "generated", title: "Helper" }; } } as never,
  });
  try {
    await registry.renameThread({ backend: "codex", threadId: "thread", name: prompt });
    registry["scheduleThreadTitleGeneration"]({ backend: "codex", threadId: "thread", input: [{ type: "text", text: prompt }] });
    await registry.whenThreadTitleGenerationSettledForTests();
    expect(generated).toBe(0);
  } finally {
    await registry.close();
    db.close();
  }
});
