import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerBackendKind } from "@pwragent/shared";
import { ThreadCreationLifecycle, type CreatedThreadIdentity, type CreatedThreadParent, type ThreadCreationHost, type ThreadCreationOptions, type ThreadCreationStage } from "../thread-creation-lifecycle";

const backend = fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:kimi", "acp:qwen");
const options = fc.record({
  backend,
  systemPlaceholder: fc.boolean(), worktree: fc.boolean(), tokenMiserOverride: fc.option(fc.boolean(), { nil: undefined }),
  pdfCatalog: fc.boolean(), mcpSelection: fc.boolean(), agent: fc.boolean(), environment: fc.boolean(), parent: fc.boolean(),
  modelSettings: fc.record({ model: fc.option(fc.string(), { nil: undefined }), fastMode: fc.option(fc.boolean(), { nil: undefined }) }),
});
const stages: ThreadCreationStage[] = ["pdf", "connections", "pending", "placeholder", "worktree", "invalidate", "execution",
  "token-miser", "pdf-catalog", "git", "pr", "mcp", "agent", "environment", "model", "parent", "parent-event", "visibility", "started"];

function fixture(config: ThreadCreationOptions, faults: Set<string>, migration: boolean, count: number, reject: boolean, reportThrows: boolean) {
  const calls: string[] = [];
  const identities: CreatedThreadIdentity[] = [];
  const parents: Array<CreatedThreadParent | undefined> = [];
  const savedParent: CreatedThreadParent = { parentThreadId: "saved:parent", parentThreadBackend: "claude" };
  const reports: Array<{ stage: string; identity: CreatedThreadIdentity | undefined }> = [];
  const providerError = new Error("provider refused");
  const effect = (stage: string, identity?: CreatedThreadIdentity) => {
    calls.push(stage);
    if (identity) identities.push(identity);
    if (faults.has(stage)) throw new Error(stage);
  };
  const submit = (provider: string) => async () => {
    calls.push(provider);
    if (reject) throw providerError;
    return { threadId: "same:thread" };
  };
  const host: ThreadCreationHost = {
    providers: { codex: submit("codex"), claude: submit("claude"), acp: submit("acp") },
    withWorkspaceWrite: async (work) => { calls.push("admit"); return await work(); },
    connections: Array.from({ length: count }, (_, i) => ({
      bindThread: (threadId) => effect(`bind:${i}`, { backend: config.backend, threadId }),
      revoke: () => effect(`revoke:${i}`),
    })),
    rollbackWorkspace: async () => effect("rollback"),
    rejection: (error) => { expect(error).toBe(providerError); return error; },
    bindPdf: (id) => effect("pdf", id),
    rememberPending: async (id) => effect("pending", id),
    markPlaceholder: (id) => effect("placeholder", id),
    recordWorktreeOwner: async (id) => effect("worktree", id),
    invalidate: (id) => effect("invalidate", id),
    persistExecutionMode: async (id) => effect("execution", id),
    persistTokenMiser: async (id) => effect("token-miser", id),
    persistPdfCatalog: async (id) => effect("pdf-catalog", id),
    persistGitBranch: async (id) => effect("git", id),
    persistPrAutoDispatch: async (id) => effect("pr", id),
    persistMcpSelection: async (id) => effect("mcp", id),
    persistAgent: async (id) => effect("agent", id),
    persistEnvironment: async (id) => effect("environment", id),
    readModelMigration: () => { calls.push("migration"); return migration; },
    persistModel: async (id) => effect("model", id),
    persistParent: async (id) => { effect("parent", id); return savedParent; },
    announceParent: async (id) => effect("parent-event", id),
    finalizeVisibility: async (id, parent) => { parents.push(parent); effect("visibility", id); return { pinnedRank: "0" }; },
    announceStarted: async (id) => effect("started", id),
    failed: (stage, _error, identity) => { reports.push({ stage, identity }); if (reportThrows) throw new Error("report failed"); },
  };
  return { host, calls, reports, identities, providerError, parents, savedParent };
}

// This script is the creation contract: independent effects keep their order;
// optional metadata is admitted by presence, including false and empty values.
function script(config: ThreadCreationOptions, migration: boolean, connections: number, failures: readonly string[] = []): string[] {
  const enabled: Record<string, boolean> = {
    placeholder: config.systemPlaceholder, worktree: config.worktree,
    execution: config.backend === "codex" || config.backend === "claude",
    "token-miser": config.backend === "codex" && config.tokenMiserOverride !== undefined,
    "pdf-catalog": config.backend === "codex" && config.pdfCatalog, git: config.backend === "codex",
    mcp: config.mcpSelection, agent: config.agent, environment: config.environment,
    model: migration || Object.values(config.modelSettings).some((value) => value !== undefined),
    parent: config.parent, "parent-event": config.parent && !failures.includes("parent"), started: config.backend !== "codex",
  };
  return ["admit", config.backend.startsWith("acp:") ? "acp" : config.backend, ...stages.flatMap((stage) => {
    if (stage === "connections") return Array.from({ length: connections }, (_, i) => `bind:${i}`);
    const admitted = enabled[stage] ?? true;
    return [...(stage === "model" ? ["migration"] : []), ...(admitted ? [stage] : [])];
  })];
}

describe("thread creation lifecycle contract", () => {
  it("preserves acceptance and every independent effect across generated host failures", async () => {
    await fc.assert(fc.asyncProperty(options, fc.subarray([...stages, "bind:0", "bind:1"]), fc.boolean(), fc.integer({ min: 0, max: 3 }), fc.boolean(),
      async (config, failures, migration, count, reportThrows) => {
        const run = fixture(config, new Set(failures), migration, count, false, reportThrows);
        const result = await new ThreadCreationLifecycle().start(config, run.host);
        expect(result).toEqual({ backend: config.backend, threadId: "same:thread", ...(failures.includes("visibility") ? {} : { pinnedRank: "0" }) });
        const expected = script(config, migration, count, failures);
        expect(run.parents).toEqual([config.parent && !failures.includes("parent") ? run.savedParent : undefined]);
        expect(run.calls).toEqual(expected);
        expect(run.identities.every((id) => id.backend === config.backend && id.threadId === "same:thread")).toBe(true);
        expect(run.reports.map((entry) => entry.stage)).toEqual(expected.filter((step) => failures.includes(step)).map((step) => step.startsWith("bind:") ? "connections" : step));
        expect(run.reports.every((entry) => entry.identity?.backend === config.backend)).toBe(true);
      }));
  });

  it("does not announce or reveal a parent the storage host did not save", async () => {
    await fc.assert(fc.asyncProperty(options, async (config) => {
      const run = fixture({ ...config, parent: true }, new Set(), false, 0, false, false);
      run.host.persistParent = async (id) => { run.identities.push(id); return undefined; };
      await new ThreadCreationLifecycle().start({ ...config, parent: true }, run.host);
      expect(run.parents).toEqual([undefined]);
      expect(run.calls).not.toContain("parent-event");
    }));
  });

  it("retains the provider identity if workspace release rejects after creation", async () => {
    await fc.assert(fc.asyncProperty(options, async (config) => {
      const run = fixture(config, new Set(), false, 2, false, true);
      const admit = run.host.withWorkspaceWrite;
      run.host.withWorkspaceWrite = async (work) => {
        await admit(work);
        throw new Error("workspace release rejected");
      };
      await expect(new ThreadCreationLifecycle().start(config, run.host)).resolves.toMatchObject({ backend: config.backend, threadId: "same:thread" });
      expect(run.calls).toEqual(script(config, false, 2));
      expect(run.reports.map((entry) => entry.stage)).toEqual(["workspace"]);
    }));
  });

  it("rejects only the provider outcome and attempts all rejection cleanup despite failures", async () => {
    await fc.assert(fc.asyncProperty(options, fc.integer({ min: 0, max: 5 }), fc.subarray(["revoke:0", "revoke:1", "revoke:2", "rollback"]), fc.boolean(),
      async (config, count, faults, reportThrows) => {
        const run = fixture(config, new Set(faults), false, count, true, reportThrows);
        await expect(new ThreadCreationLifecycle().start(config, run.host)).rejects.toBe(run.providerError);
        expect(run.calls).toEqual(["admit", config.backend.startsWith("acp:") ? "acp" : config.backend,
          ...Array.from({ length: count }, (_, i) => `revoke:${i}`), "rollback"]);
        expect(run.reports.every((entry) => entry.identity === undefined)).toBe(true);
      }));
  });

  it("keeps overlapping backend-qualified creations independent when provider ids collide", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.array(options, { minLength: 2, maxLength: 5 }), async (scheduler, configs) => {
      const lifecycle = new ThreadCreationLifecycle();
      const runs = configs.map((config) => fixture(config, new Set(["pr", "bind:0"]), false, 2, false, true));
      const starts = runs.map((run, index) => {
        const admit = run.host.withWorkspaceWrite;
        run.host.withWorkspaceWrite = (work) => scheduler.schedule(admit(work), `provider:${index}`);
        const pending = run.host.rememberPending;
        run.host.rememberPending = (identity) => scheduler.schedule(pending(identity), `pending:${index}`);
        return lifecycle.start(configs[index]!, run.host);
      });
      await scheduler.waitFor(Promise.all(starts));
      for (let i = 0; i < runs.length; i++) {
        expect(await starts[i]).toMatchObject({ backend: configs[i]!.backend, threadId: "same:thread" });
        expect(runs[i]!.calls).toEqual(script(configs[i]!, false, 2));
      }
    }), { numRuns: 30 });
  });
});
