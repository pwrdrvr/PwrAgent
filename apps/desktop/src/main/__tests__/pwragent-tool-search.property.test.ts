import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { buildPwrAgentToolSearchDefinition, searchPwrAgentTools } from "../agent-tools/pwragent-tool-search";
import { CLAUDE_MONITOR_JOB_SUGGESTION, MONITOR_JOB_SUGGESTION } from "../app-server/monitor-job-suggestion";

const catalog: DynamicToolSpec[] = [{
  type: "namespace",
  name: "pwragent",
  description: "PwrAgent",
  tools: resolveAgentToolCatalogs({}).flatMap((entry) => entry.dynamicTools.flatMap((spec) => spec.type === "namespace" ? spec.tools : [])),
}];

function syntheticCatalog(sizes: number[]): DynamicToolSpec[] {
  return [{
    type: "namespace",
    name: "pwragent",
    description: "PwrAgent",
    tools: sizes.map((size, index) => ({
      type: "function" as const,
      name: `inspect_item_${index}`,
      description: "Inspect an item.",
      inputSchema: { type: "object", description: "x".repeat(size) },
    })),
  }];
}

describe("PwrAgent tool search relevance and delivery properties", () => {
  it.each([MONITOR_JOB_SUGGESTION, CLAUDE_MONITOR_JOB_SUGGESTION])(
    "presents built-in waits before offering a Job Monitor in polling guidance %#",
    (suggestion) => {
      const registration = suggestion.indexOf("manage_thread_dependencies");
      const delegation = suggestion.indexOf("create_monitor_delegation");
      expect(registration).toBeGreaterThanOrEqual(0);
      expect(delegation).toBeGreaterThan(registration);
      expect(suggestion.slice(registration, delegation)).toContain("ci_run");
      expect(suggestion.slice(registration, delegation)).toContain("local_file");
    },
  );

  it("discovers the durable CI wait first and preserves explicit Job Monitor requests", () => {
    // A run's event determines when to wake. The oracle is the tool that can
    // register that event, even when the caller only loads one definition.
    fc.assert(fc.property(
      fc.constantFrom("wait for", "watch", "monitor", "notify me when"),
      fc.constantFrom(
        "GitHub Actions run ID",
        "GitLab pipeline",
        "standalone CI run",
        "release CI run",
        "https://github.com/pwrdrvr/PwrGit/actions/runs/",
        "https://gitlab.com/example/release/-/pipelines/",
      ),
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 1 }),
      (intent, target, limit, id) => {
        const run = target.endsWith("/") ? `${target}${id}` : `${target} ${id}`;
        expect(searchPwrAgentTools(catalog, `${intent} ${run}`, limit)[0]?.name)
          .toBe("manage_thread_dependencies");
        expect(searchPwrAgentTools(catalog, `start a Job Monitor to ${intent} ${run}`, limit)[0]?.name)
          .toBe("create_monitor_delegation");
        expect(searchPwrAgentTools(catalog, `create_monitor_delegation ${intent} ${run}`, limit)[0]?.name)
          .toBe("create_monitor_delegation");
      },
    ));
  });

  it("keeps attached PR watches on the PR even when the query includes a run URL", () => {
    fc.assert(fc.property(
      fc.constantFrom("attached pull request checks", "checks for the attached pull request"),
      fc.integer({ min: 1, max: 10 ** 12 }),
      (target, id) => {
        const query = `watch ${target} at https://github.com/acme/ci/actions/runs/${id}`;
        expect(searchPwrAgentTools(catalog, query, 1)[0]?.name)
          .toBe("watch_thread_pull_request");
      },
    ));
  });

  it("keeps reads of approval-blocked jobs on the run inspection route", () => {
    fc.assert(fc.property(
      fc.constantFrom("get", "read", "show", "inspect"),
      fc.constantFrom("waiting for approval", "awaiting approval"),
      fc.integer({ min: 1, max: 10 ** 12 }),
      (action, state, id) => {
        expect(searchPwrAgentTools(catalog, `${action} jobs ${state} in GitHub Actions run ${id}`, 1)[0]?.name)
          .toBe("get_ci_run");
      },
    ));
  });

  it("honors an explicit Job Monitor named after the CI target", () => {
    fc.assert(fc.property(
      fc.constantFrom("release CI run", "standalone CI run", "GitHub Actions run"),
      fc.constantFrom("with a Job Monitor", "using a Job Monitor"),
      (target, method) => {
        expect(searchPwrAgentTools(catalog, `watch ${target} ${method}`, 1)[0]?.name)
          .toBe("create_monitor_delegation");
      },
    ));
  });

  // The thread-search schema owns model filtering. Mentioning that criterion
  // must not turn a request for threads into runtime-model enumeration.
  it("keeps thread search discoverable when models are search criteria", () => {
    const threadSearch = searchPwrAgentTools(catalog, "search_threads", 1)[0];
    expect(threadSearch.inputSchema).toMatchObject({ properties: { models: { type: "array" } } });
    fc.assert(fc.property(
      fc.constantFrom("list", "find", "search", "show"),
      fc.constantFrom("", "my ", "all ", "recent "),
      fc.constantFrom("by model", "using model", "with model", "running models", "by available models"),
      (action, modifier, criterion) => {
        const results = searchPwrAgentTools(catalog, `${action} ${modifier}threads ${criterion}`);
        expect(results.map((tool) => tool.name)).toContain("search_threads");
      },
    ));
  });

  it("finds threads by model for the reported query", () => {
    expect(searchPwrAgentTools(catalog, "list threads by model").map((tool) => tool.name)).toContain("search_threads");
  });

  // No tool in this catalog lists runtime models. Thread operations and
  // registered decisions cannot answer that request, regardless of context.
  it("abstains from unrelated tools for runtime model discovery", () => {
    fc.assert(fc.property(
      fc.constantFrom("available", "list", "inspect available", "show available", "supported", "which available"),
      fc.constantFrom("model", "models", "agent models", "provider models", "subscription models"),
      fc.subarray(["current", "thread", "agent", "subscription", "providers", "settings"]),
      fc.integer({ min: 1, max: 5 }),
      (action, subject, context, limit) => {
        expect(searchPwrAgentTools(catalog, [action, subject, ...context].join(" "), limit)).toEqual([]);
      },
    ));
  });

  it("explains the original unsupported model query without loading schemas", async () => {
    const result = await buildPwrAgentToolSearchDefinition(catalog).dispatch({
      query: "inspect current thread available agent models subscription providers settings",
      limit: 3,
    }, { backend: "codex", threadId: "thread-1", transport: "codex_dynamic_tool" });
    expect(result.ok).toBe(true);
    const text = result.contentItems?.find((item) => item.type === "inputText");
    expect(text).toMatchObject({ type: "inputText" });
    if (text?.type !== "inputText") throw new Error("Missing search result");
    expect(JSON.parse(text.text)).toEqual({ tools: [], noMatchReason: expect.stringContaining("runtime models") });
    expect(text.text.length).toBeLessThan(500);
  });

  it("discovers an actual runtime model capability when the catalog provides one", () => {
    const tool = {
      type: "function" as const,
      name: "list_models",
      description: "List available runtime models and subscription providers.",
      inputSchema: { type: "object" },
    };
    const extended = catalog.map((spec) => spec.type === "namespace" ? { ...spec, tools: [...spec.tools, tool] } : spec);
    fc.assert(fc.property(
      fc.subarray(["current", "thread", "agent", "subscription", "providers", "settings"]),
      (context) => {
        expect(searchPwrAgentTools(extended, `available models ${context.join(" ")}`).map((result) => result.name)).toEqual(["list_models"]);
      },
    ));
  });

  it("does not promote incidental model mentions into a model discovery capability", () => {
    fc.assert(fc.property(
      fc.shuffledSubarray(["available", "runtime", "models", "providers", "subscription", "settings"], { minLength: 6, maxLength: 6 }),
      (context) => {
        const source: DynamicToolSpec[] = [{
          type: "namespace",
          name: "pwragent",
          description: "PwrAgent",
          tools: [{
            type: "function",
            name: "list_threads",
            description: `List threads. Examples and optional settings mention ${context.join(" ")}.`,
            inputSchema: { type: "object" },
          }, {
            type: "function",
            name: "change_models",
            description: "Change available runtime models and provider settings.",
            inputSchema: { type: "object" },
          }],
        }];
        expect(searchPwrAgentTools(source, "list available runtime models")).toEqual([]);
      },
    ));
  });

  it("preserves decision discovery and model changes when those are requested", () => {
    expect(searchPwrAgentTools(catalog, "show available decision models").map((tool) => tool.name)).toContain("decisions_list");
    expect(searchPwrAgentTools(catalog, "change current thread model settings").map((tool) => tool.name)).toContain("mutate_thread");
  });

  // Ranked results have an 8,000-character JSON budget. A single oversized
  // definition remains callable; further candidates cannot make it larger.
  it("bounds ranked output without truncating any returned definition", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1_500, max: 12_000 }), { minLength: 3, maxLength: 8 }),
      (sizes) => {
        const source = syntheticCatalog(sizes);
        const results = searchPwrAgentTools(source, "inspect item", 5);
        expect(results.length).toBeGreaterThan(0);
        if (results.length > 1) expect(JSON.stringify({ tools: results }).length).toBeLessThanOrEqual(8_000);
        for (const result of results) {
          const index = Number(result.name.split("_").at(-1));
          expect(result.inputSchema).toEqual({ type: "object", description: "x".repeat(sizes[index]) });
        }
      },
    ), { numRuns: 32 });
  });

  it("excludes the next ranked definition when it would exceed the budget by one character", () => {
    fc.assert(fc.property(fc.integer({ min: 500, max: 3_500 }), (firstSize) => {
      const definitions = [firstSize, 0].map((size, index) => ({
        namespace: "pwragent",
        name: `inspect_item_${index}`,
        codeModeName: `pwragent__inspect_item_${index}`,
        description: "Inspect an item.",
        inputSchema: { type: "object", description: "x".repeat(size) },
      }), { numRuns: 32 });
      const secondSize = 8_001 - JSON.stringify({ tools: definitions }).length;
      const results = searchPwrAgentTools(syntheticCatalog([firstSize, secondSize]), "inspect item", 5);
      expect(results).toEqual([definitions[0]]);
    }), { numRuns: 32 });
  });

  it("preserves every explicitly requested definition despite context, count and size budgets", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 2_000, max: 5_000 }), { minLength: 3, maxLength: 8 }),
      (sizes) => {
        const names = sizes.map((_, index) => `inspect_item_${index}`);
        const results = searchPwrAgentTools(syntheticCatalog(sizes), `available models ${names.join(" ")}`, 1);
        expect(results.map((tool) => tool.name)).toEqual(names);
        expect(results.map((tool) => tool.inputSchema)).toEqual(sizes.map((size) => ({ type: "object", description: "x".repeat(size) })));
      },
    ), { numRuns: 32 });
  });
});
