import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  providerChipNeeded,
  threadProviderIdentity,
  type NavigationQueryRequest,
  type NavigationSnapshot,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { projectNavigationQuery } from "../navigation-query-projection";

/**
 * The oracle: a thread's provider is its backend, except that a Codex thread
 * on a registered model provider (`@mathos/…`) runs on that provider. A
 * provider chip helps only when it tells threads apart, so over any set of
 * owner threads it shows exactly when the threads span more than one
 * provider. An OpenAI thread and a MathOS thread are two providers; two
 * MathOS threads are one.
 */
const threadArbitrary = fc.record({
  source: fc.constantFrom("codex", "claude", "acp:gemini"),
  model: fc.constantFrom(undefined, "gpt-6-sol", "@mathos/gpt-oss-120b", "@mathos/coder", "@refuseless/gpt-oss-120b"),
});

function snapshot(threads: NavigationThreadSummary[]): NavigationSnapshot {
  return {
    backend: "all",
    fetchedAt: 1,
    unchanged: false,
    threads,
    inboxThreadKeys: [],
    directories: [{
      key: "directory:/repo",
      kind: "directory",
      label: "repo",
      path: "/repo",
      threadKeys: threads.map((thread) => `${thread.source}:${thread.id}`),
      needsAttentionCount: 0,
    }],
    launchpadDefaults: { backend: "codex", executionMode: "default" },
  };
}

function directoryIndex(threads: NavigationThreadSummary[]) {
  const request: NavigationQueryRequest = {
    consumer: "main-sidebar",
    query: { kind: "directory-index" },
  } as NavigationQueryRequest;
  return projectNavigationQuery({ index: snapshot(threads), request });
}

/** The provider an oracle reader would name, written without the helper. */
function oracleProvider(thread: { source: string; model?: string }): string {
  const match = thread.source === "codex" && thread.model ? /^@([a-z][a-z0-9_-]*)\//u.exec(thread.model) : null;
  return match ? `codex via ${match[1]}` : thread.source;
}

describe("provider identities in the owner's index", () => {
  it("shows a thread's provider chip exactly when the owner's threads span more than one provider", () => {
    fc.assert(fc.property(fc.array(threadArbitrary, { minLength: 1, maxLength: 8 }), (specs) => {
      const threads = specs.map((spec, index): NavigationThreadSummary => ({
        id: `t${index + 1}`,
        source: spec.source as NavigationThreadSummary["source"],
        ...(spec.model ? { model: spec.model } : {}),
        title: `Thread ${index + 1}`,
        titleSource: "derived",
        createdAt: index + 1,
        updatedAt: index + 1,
        linkedDirectories: [{ id: "repo", kind: "local", label: "repo", path: "/repo" }],
        inbox: { inInbox: false },
      }));
      const page = directoryIndex(threads);
      const distinctProviders = new Set(specs.map(oracleProvider)).size;
      for (const thread of threads) {
        expect(providerChipNeeded(page.counts.providers, threadProviderIdentity(thread.source, thread.model)))
          .toBe(distinctProviders > 1);
      }
    }), { numRuns: 300 });
  });

  it("keeps a model-provider thread's chip on for an owner that reports only backend kinds", () => {
    // An owner that predates `providers` reports `backends` alone.
    expect(providerChipNeeded(["codex"], threadProviderIdentity("codex", "@mathos/x"))).toBe(true);
    expect(providerChipNeeded(["codex"], threadProviderIdentity("codex", "gpt-6-sol"))).toBe(false);
  });
});
