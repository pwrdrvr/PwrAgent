import fc from "fast-check";
import { expect, it } from "vitest";
import { isAcpBackendId } from "@pwragent/shared/contracts/navigation";
import { type AgentEvent } from "@pwragent/shared/contracts/agent";
import {
  normalizeRenamedTitleSource,
  type AcpBackendId,
  type AppServerThreadSummary,
  type AppServerThreadTitleSource,
} from "@pwragent/shared/contracts/normalized-app-server";
import { shortenDerivedThreadTitle } from "@pwragent/shared/thread-titles";
import { projectAcpSessionThread } from "../acp-thread-projection";
import type { AcpSessionMetadata } from "../acp-storage";
import { ThreadNamingLifecycle } from "../thread-naming-lifecycle";
import type { OwnerThreadIdentity } from "../thread-storage";
import { ThreadTitleLifecycle, type ThreadTitleLifecycleHost } from "../thread-title-lifecycle";

const acpBackend = fc.constantFrom<AcpBackendId>(
  "acp:antigravity",
  "acp:kimi",
  "acp:grok",
  "acp:qwen",
  "acp:claude",
);

const promptArb = fc.constantFrom(
  "Fix the flaky authentication retry loop when tokens expire in production",
  "Please investigate why the sidebar flickers after switching workspaces",
  "Refactor the ACP session startup sequence",
  "Explain how the scheduler orders queued turns",
  "Check whether the release workflow signed every macOS artifact cleanly and uploaded checksums",
);

type HelperOutcome = "generated" | "invalid" | "unavailable" | "failed" | "throw";
type RaceTiming = "before-start" | "during-helper" | "after-helper";

function createAcpTitleHarness(
  backend: AcpBackendId,
  initialTitle = "Untitled thread",
  schedule?: <T>(promise: Promise<T>) => Promise<T>,
) {
  let session: AcpSessionMetadata = {
    backendId: backend,
    sessionId: "thread-1",
    title: initialTitle,
    titleSource: "fallback",
    cwd: "/repo/project",
    createdAt: 1000,
    updatedAt: 1000,
    executionMode: "default",
    status: "idle",
  };
  const events: AgentEvent[] = [];
  let observedRendererTitle: { threadName: string; titleSource: "explicit" | "derived" } | undefined;

  const projectSummary = (): AppServerThreadSummary =>
    projectAcpSessionThread(session, undefined, "project");

  const naming = new ThreadNamingLifecycle({
    readName: async () => session.title,
    readTitle: () => {
      const value = Promise.resolve(projectSummary());
      return schedule ? schedule(value) : value;
    },
    renameProvider: async (request, titleSource, options) => {
      if (schedule) await schedule(Promise.resolve());
      if (options?.guard) {
        const current = projectSummary();
        if (!options.guard(current)) {
          return { threadId: request.threadId, skipped: true as const, thread: current };
        }
      }
      const { promptPlaceholderTitle: _prev, ...rest } = session as AcpSessionMetadata & {
        promptPlaceholderTitle?: true;
      };
      session = {
        ...rest,
        title: request.name.trim(),
        titleSource,
        ...(options?.promptPlaceholder ? { promptPlaceholderTitle: true } : {}),
        updatedAt: session.updatedAt + 1,
      };
      return { threadId: request.threadId };
    },
    getAgent: async () => undefined,
    setAgent: async () => {},
    invalidate: () => {},
    emit: async (event) => {
      events.push(event);
      if (event.notification.method === "thread/name/updated") {
        const params = event.notification.params as { threadName?: string; titleSource?: unknown };
        const threadName = params.threadName?.trim();
        if (threadName) {
          observedRendererTitle = {
            threadName,
            titleSource: normalizeRenamedTitleSource(params.titleSource),
          };
        }
      }
    },
    now: () => 2000,
  });

  // Mirrors AcpAgentClient.updateSessionTitleFromAcpUpdate.
  const applyProviderTopicUpdate = async (title: string): Promise<boolean> => {
    const current = session as AcpSessionMetadata & { promptPlaceholderTitle?: true };
    if (current.title === title) return false;
    const currentSource: AppServerThreadTitleSource =
      current.titleSource ?? (!current.title.trim() || current.title === "Untitled thread" ? "fallback" : "derived");
    if (currentSource !== "fallback" && current.promptPlaceholderTitle !== true) return false;
    const { promptPlaceholderTitle: _prev, ...rest } = current;
    session = {
      ...rest,
      title,
      titleSource: "derived",
      updatedAt: session.updatedAt + 1,
    };
    const event: AgentEvent = {
      backend,
      notification: {
        method: "thread/name/updated",
        params: { threadId: session.sessionId, threadName: title, titleSource: "derived" },
      },
    };
    events.push(event);
    observedRendererTitle = { threadName: title, titleSource: "derived" };
    return true;
  };

  // Mirrors useThreadNavigation's observation retirement rule.
  const reconcileRendererRefresh = () => {
    const row = projectSummary();
    if (
      observedRendererTitle
      && row.title === observedRendererTitle.threadName
      && row.titleSource === observedRendererTitle.titleSource
    ) {
      observedRendererTitle = undefined;
    }
    return {
      presentedTitle: observedRendererTitle?.threadName ?? row.title,
      presentedSource: observedRendererTitle?.titleSource ?? row.titleSource,
      observationRetired: observedRendererTitle === undefined,
    };
  };

  return {
    getSession: () => session,
    projectSummary,
    naming,
    events,
    applyProviderTopicUpdate,
    reconcileRendererRefresh,
  };
}

// Model-based property (100 runs): an ACP thread receiving its first prompt
// immediately replaces its generic placeholder with the shortened prompt before
// the naming sub-agent finishes, survives every helper failure mode, preserves
// provider durable titles and explicit operator renames across interleaved
// schedules, and always emits wire provenance matching stored provenance so
// renderer observations retire cleanly.
it("maintains ACP prompt-placeholder and naming invariants across 100 interleaved runs", async () => {
  await fc.assert(
    fc.asyncProperty(
      acpBackend,
      promptArb,
      fc.constantFrom<HelperOutcome>("generated", "invalid", "unavailable", "failed", "throw"),
      fc.option(fc.record({
        timing: fc.constantFrom<RaceTiming>("before-start", "during-helper", "after-helper"),
        title: fc.constantFrom("Provider Durable Title", "Summary From Provider"),
      }), { nil: undefined }),
      fc.option(fc.record({
        timing: fc.constantFrom<RaceTiming>("before-start", "during-helper", "after-helper"),
        // Include renaming to the exact prompt text or "Untitled thread" to
        // verify explicit operator intent is never overwritten.
        usePromptText: fc.boolean(),
        customTitle: fc.constantFrom("Operator Custom Title", "Untitled thread"),
      }), { nil: undefined }),
      fc.string({ minLength: 1, maxLength: 30 }),
      async (backend, prompt, outcome, providerEvent, operatorEvent, secondPromptSuffix) => {
        const harness = createAcpTitleHarness(backend);
        const identity: OwnerThreadIdentity = { backend, threadId: "thread-1" };
        const expectedPlaceholder = shortenDerivedThreadTitle(prompt)!;
        const operatorTitle = operatorEvent
          ? (operatorEvent.usePromptText ? expectedPlaceholder : operatorEvent.customTitle)
          : undefined;

        let titleWhenHelperStarted: string | undefined;
        let sourceWhenHelperStarted: AppServerThreadTitleSource | undefined;
        let helperStarted!: () => void;
        const helperStartedPromise = new Promise<void>((resolve) => { helperStarted = resolve; });
        let releaseHelper!: () => void;
        const releaseHelperPromise = new Promise<void>((resolve) => { releaseHelper = resolve; });

        const host: ThreadTitleLifecycleHost = {
          canGenerateTitle: () => true,
          readTitle: async () => harness.projectSummary(),
          prepareHelper: async () => {
            const current = harness.projectSummary();
            titleWhenHelperStarted = current.title;
            sourceWhenHelperStarted = current.titleSource;
          },
          generateTitle: async () => {
            helperStarted();
            await releaseHelperPromise;
            if (outcome === "throw") throw new Error("helper crashed");
            if (outcome === "generated") return { status: "generated", title: "Concise Generated Title" };
            if (outcome === "invalid") return { status: "invalid", reason: "invalid_json" };
            if (outcome === "unavailable") return { status: "unavailable", reason: "unavailable" };
            return { status: "failed", reason: "timeout" };
          },
          persistHelper: async () => {},
          log: () => {},
        };

        const lifecycle = new ThreadTitleLifecycle(harness.naming, host);

        // Pre-start concurrent events.
        if (providerEvent?.timing === "before-start") {
          await harness.applyProviderTopicUpdate(providerEvent.title);
        }
        if (operatorEvent?.timing === "before-start") {
          await harness.naming.renameThread({ ...identity, name: operatorTitle! });
        }

        lifecycle.schedule({ ...identity, input: [{ type: "text", text: prompt }] });

        const helperShouldRun =
          backend !== "acp:claude"
          && providerEvent?.timing !== "before-start"
          && operatorEvent?.timing !== "before-start";

        try {
          if (helperShouldRun) {
            const settledOrStarted = await Promise.race([
              helperStartedPromise.then(() => "started" as const),
              lifecycle.whenSettled().then(() => "settled-without-helper" as const),
            ]);
            expect(settledOrStarted).toBe("started");
            // Invariant 2: BEFORE the naming sub-agent finishes, the thread
            // already displays the shortened prompt placeholder, never
            // "Untitled thread" or "ACP session".
            expect(titleWhenHelperStarted).toBe(expectedPlaceholder);
            expect(sourceWhenHelperStarted).toBe("derived");
            expect(harness.reconcileRendererRefresh()).toEqual({
              presentedTitle: expectedPlaceholder,
              presentedSource: "derived",
              observationRetired: true,
            });
          }

          // Mid-helper concurrent events.
          if (providerEvent?.timing === "during-helper") {
            await harness.applyProviderTopicUpdate(providerEvent.title);
          }
          if (operatorEvent?.timing === "during-helper") {
            await harness.naming.renameThread({ ...identity, name: operatorTitle! });
          }
        } finally {
          releaseHelper();
        }
        await lifecycle.whenSettled();

        // Post-helper concurrent events.
        if (providerEvent?.timing === "after-helper") {
          await harness.applyProviderTopicUpdate(providerEvent.title);
        }
        if (operatorEvent?.timing === "after-helper") {
          await harness.naming.renameThread({ ...identity, name: operatorTitle! });
        }

        const finalSummary = harness.projectSummary();
        // Never ends up as a generic placeholder.
        expect(finalSummary.title).not.toBe("ACP session");
        if (operatorTitle !== "Untitled thread") {
          expect(finalSummary.title).not.toBe("Untitled thread");
        }

        // Exact oracle for final title & provenance.
        if (operatorEvent) {
          expect(finalSummary.title).toBe(operatorTitle);
          expect(finalSummary.titleSource).toBe("explicit");
        } else if (providerEvent && (
          providerEvent.timing !== "after-helper"
          || backend === "acp:claude"
          || outcome !== "generated"
        )) {
          // A provider durable title replaces a placeholder before or during
          // the helper, or after a failed/skipped helper.
          expect(finalSummary.title).toBe(providerEvent.title);
          expect(finalSummary.titleSource).toBe("derived");
        } else if (backend !== "acp:claude" && outcome === "generated") {
          expect(finalSummary.title).toBe("Concise Generated Title");
          expect(finalSummary.titleSource).toBe("derived");
        } else {
          // Helper failed/threw/invalid/unavailable or acp:claude without
          // provider update: prompt placeholder stays intact.
          expect(finalSummary.title).toBe(expectedPlaceholder);
          expect(finalSummary.titleSource).toBe("derived");
        }

        // Wire provenance always matches stored provenance, so renderer
        // observation retires cleanly on refresh.
        expect(harness.reconcileRendererRefresh()).toEqual({
          presentedTitle: finalSummary.title,
          presentedSource: finalSummary.titleSource,
          observationRetired: true,
        });

        // Restart check: a second turn on a fresh lifecycle with a different
        // prompt must NEVER overwrite turn 1's prompt placeholder or title.
        const secondPrompt = `Completely different follow-up question ${secondPromptSuffix}`;
        const restartedLifecycle = new ThreadTitleLifecycle(harness.naming, {
          ...host,
          generateTitle: async () => {
            throw new Error("second turn must not launch title generation");
          },
        });
        restartedLifecycle.schedule({ ...identity, input: [{ type: "text", text: secondPrompt }] });
        await restartedLifecycle.whenSettled();
        expect(harness.projectSummary().title).toBe(finalSummary.title);
      },
    ),
    { numRuns: 100 },
  );
});

it("never treats 'ACP session' as a fallback title in projection", () => {
  const legacyString = projectAcpSessionThread({
    backendId: "acp:antigravity",
    sessionId: "s-legacy",
    title: "ACP session",
    createdAt: 1,
    updatedAt: 1,
    executionMode: "default",
    status: "idle",
  }, undefined, "repo");
  expect(legacyString.titleSource).toBe("derived");

  const untitled = projectAcpSessionThread({
    backendId: "acp:antigravity",
    sessionId: "s-1",
    title: "Untitled thread",
    createdAt: 1,
    updatedAt: 1,
    executionMode: "default",
    status: "idle",
  }, undefined, "repo");
  expect(untitled.titleSource).toBe("fallback");

  const blank = projectAcpSessionThread({
    backendId: "acp:antigravity",
    sessionId: "s-2",
    title: "   ",
    createdAt: 1,
    updatedAt: 1,
    executionMode: "default",
    status: "idle",
  }, undefined, "repo");
  expect(blank.titleSource).toBe("fallback");
  expect(isAcpBackendId(untitled.source)).toBe(true);
});

// Scheduler MBT (100 runs): fuzzes every async yield point between the naming
// helper, immediate prompt placeholder, provider topic updates, operator
// renames, and concurrent navigation refreshes.
it("preserves title monotonicity and provenance under arbitrary async scheduling (100 runs)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      acpBackend,
      promptArb,
      fc.constantFrom<HelperOutcome>("generated", "invalid", "unavailable", "throw"),
      fc.boolean(),
      fc.boolean(),
      async (scheduler, backend, prompt, outcome, fireProviderUpdate, fireOperatorRename) => {
        const harness = createAcpTitleHarness(backend, "Untitled thread", (promise) => scheduler.schedule(promise));
        const identity: OwnerThreadIdentity = { backend, threadId: "thread-1" };
        const expectedPlaceholder = shortenDerivedThreadTitle(prompt)!;
        const providerTitle = "Provider Topic Summary";
        const operatorTitle = "Operator Explicit Name";
        let providerUpdateAccepted = false;

        const host: ThreadTitleLifecycleHost = {
          canGenerateTitle: () => true,
          readTitle: () => scheduler.schedule(Promise.resolve(harness.projectSummary())),
          prepareHelper: async () => {
            await scheduler.schedule(Promise.resolve());
          },
          generateTitle: async () => {
            await scheduler.schedule(Promise.resolve());
            if (outcome === "throw") throw new Error("helper failed");
            if (outcome === "generated") return { status: "generated", title: "Helper Concise Title" };
            if (outcome === "invalid") return { status: "invalid", reason: "invalid" };
            return { status: "unavailable", reason: "unavailable" };
          },
          persistHelper: async () => {
            await scheduler.schedule(Promise.resolve());
          },
          log: () => {},
        };

        const lifecycle = new ThreadTitleLifecycle(harness.naming, host);
        const tasks: Array<Promise<unknown>> = [];

        lifecycle.schedule({ ...identity, input: [{ type: "text", text: prompt }] });

        if (fireProviderUpdate) {
          tasks.push(scheduler.schedule(Promise.resolve()).then(async () => {
            providerUpdateAccepted = await harness.applyProviderTopicUpdate(providerTitle);
          }));
        }

        if (fireOperatorRename) {
          tasks.push(scheduler.schedule(Promise.resolve()).then(async () => {
            await harness.naming.renameThread({ ...identity, name: operatorTitle });
          }));
        }

        // Interleave renderer snapshot refreshes during the race.
        tasks.push(scheduler.schedule(Promise.resolve()).then(() => {
          const view = harness.reconcileRendererRefresh();
          expect(view.presentedTitle).not.toBe("ACP session");
        }));

        await scheduler.waitFor(Promise.all([...tasks, lifecycle.whenSettled()]));

        const finalSummary = harness.projectSummary();
        expect(finalSummary.title).not.toBe("ACP session");
        expect(finalSummary.title).not.toBe("Untitled thread");

        if (fireOperatorRename) {
          expect(finalSummary.title).toBe(operatorTitle);
          expect(finalSummary.titleSource).toBe("explicit");
        } else if (providerUpdateAccepted) {
          // Once a provider durable topic update is accepted, neither the
          // prompt placeholder nor the naming helper may ever overwrite it.
          expect(finalSummary.title).toBe(providerTitle);
          expect(finalSummary.titleSource).toBe("derived");
        } else {
          expect(finalSummary.titleSource).toBe("derived");
          const allowedTitles = new Set<string>([expectedPlaceholder]);
          if (backend !== "acp:claude" && outcome === "generated") {
            allowedTitles.add("Helper Concise Title");
          }
          expect(allowedTitles.has(finalSummary.title)).toBe(true);
        }

        // Renderer observation must always retire once settled.
        expect(harness.reconcileRendererRefresh()).toEqual({
          presentedTitle: finalSummary.title,
          presentedSource: finalSummary.titleSource,
          observationRetired: true,
        });
      },
    ),
    { numRuns: 100 },
  );
});

// Shrunk counterexample from the scheduler MBT: a provider durable topic update
// arriving between `readTitle` and `renameProvider` must not be overwritten by
// either the prompt placeholder or the naming helper.
it("does not overwrite a provider durable title arriving between readTitle and renameProvider (shrunk counterexample)", async () => {
  const harness = createAcpTitleHarness("acp:antigravity");
  const identity: OwnerThreadIdentity = { backend: "acp:antigravity", threadId: "thread-1" };
  let releaseRename!: () => void;
  const renamePaused = new Promise<void>((resolve) => { releaseRename = resolve; });
  let renameEntered!: () => void;
  const entered = new Promise<void>((resolve) => { renameEntered = resolve; });
  const originalRename = harness.naming["host"].renameProvider;
  harness.naming["host"].renameProvider = async (request, source, options) => {
    renameEntered();
    await renamePaused;
    return await originalRename(request, source, options);
  };
  let generateCalls = 0;
  const lifecycle = new ThreadTitleLifecycle(harness.naming, {
    canGenerateTitle: () => true,
    readTitle: async () => harness.projectSummary(),
    prepareHelper: async () => {},
    generateTitle: async () => {
      generateCalls++;
      return { status: "generated", title: "Helper Concise Title" };
    },
    persistHelper: async () => {},
    log: () => {},
  });

  lifecycle.schedule({
    ...identity,
    input: [{ type: "text", text: "Fix the flaky authentication retry loop when tokens expire in production" }],
  });
  await entered;
  expect(await harness.applyProviderTopicUpdate("Provider Topic Summary")).toBe(true);
  releaseRename();
  await lifecycle.whenSettled();

  expect(harness.projectSummary()).toMatchObject({
    title: "Provider Topic Summary",
    titleSource: "derived",
  });
  expect(generateCalls).toBe(0);
});
