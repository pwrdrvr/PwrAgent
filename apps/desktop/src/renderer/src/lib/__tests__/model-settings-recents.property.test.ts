import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { codexSpeedOptions } from "@pwragent/shared/codex-speed";
import type { ModelSettingsRecent } from "@pwragent/shared/contracts/agent";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import { newThreadModelSettingsRecent, newThreadRecents } from "../model-settings-recents";

const key = (recent: ModelSettingsRecent) => JSON.stringify([
  recent.backend, recent.model ?? "", recent.reasoningEffort ?? "", recent.serviceTier ?? "", recent.fastMode ?? false,
]);

function backend(kind: string, models: BackendSummary["launchpadOptions"], options: Partial<BackendSummary> = {}): BackendSummary {
  return {
    kind, label: kind, available: true, methods: [],
    capabilities: { createThread: true },
    executionModes: [],
    launchpadOptions: models,
    ...options,
  } as unknown as BackendSummary;
}

const backendsArbitrary = fc.record({
  claudeAvailable: fc.boolean(),
  acpCanStart: fc.boolean(),
  codexFastAllowed: fc.boolean(),
}).map(({ claudeAvailable, acpCanStart, codexFastAllowed }) => [
  backend("codex", {
    models: [
      { id: "gpt-6.1-sol", supportsReasoning: true, supportsFast: true, serviceTiers: ["priority", "ultrafast"],
        reasoningEfforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-6-luna", supportsReasoning: true, supportsFast: false, reasoningEfforts: ["low", "medium", "high"] },
      { id: "@bonsai/ternary-8b", providerId: "bonsai", supportsReasoning: false },
    ],
  }, { codexFastAllowed }),
  backend("claude", {
    models: [
      { id: "opus", supportsReasoning: true, reasoningEfforts: ["low", "medium", "high", "max"] },
      { id: "haiku", supportsReasoning: false },
    ],
  }, { available: claudeAvailable }),
  backend("acp:grok", { models: [{ id: "grok-5" }] }, { capabilities: { createThread: acpCanStart } as never }),
]);

const recentArbitrary: fc.Arbitrary<ModelSettingsRecent> = fc.record({
  backend: fc.constantFrom("codex", "claude", "acp:grok", "acp:gone"),
  model: fc.option(fc.constantFrom("gpt-6.1-sol", "gpt-6-luna", "@bonsai/ternary-8b", "opus", "haiku", "grok-5", "retired"),
    { nil: undefined }),
  reasoningEffort: fc.option(fc.constantFrom("low", "medium", "high", "xhigh", "max"), { nil: undefined }),
  serviceTier: fc.option(fc.constantFrom("ultrafast", "priority"), { nil: undefined }),
  fastMode: fc.option(fc.boolean(), { nil: undefined }),
}, { requiredKeys: ["backend"] }).map((recent) => Object.fromEntries(
  Object.entries(recent).filter(([, value]) => value !== undefined),
) as ModelSettingsRecent);

/** The rule a Recent row stands for: this catalog can still start it. */
function startable(recent: ModelSettingsRecent, backends: BackendSummary[]): boolean {
  const summary = backends.find((entry) => entry.kind === recent.backend);
  if (!summary?.available || !summary.capabilities.createThread) return false;
  const models = summary.launchpadOptions?.models ?? [];
  const model = models.find((entry) => entry.id === recent.model);
  if (recent.model && !model) return false;
  if (!recent.reasoningEffort) return true;
  if (model?.supportsReasoning === false) return false;
  const efforts = model?.reasoningEfforts ?? summary.launchpadOptions?.reasoningEfforts ?? [];
  return efforts.length === 0 || efforts.includes(recent.reasoningEffort);
}

describe("new-thread Recent rows", () => {
  it("are the startable recents, new threads first, each once, up to the limit", () => {
    fc.assert(fc.property(
      fc.array(recentArbitrary, { maxLength: 10 }),
      fc.array(recentArbitrary, { maxLength: 10 }),
      backendsArbitrary,
      fc.integer({ min: 1, max: 8 }),
      (composer, todoDispatch, backends, limit) => {
        const rows = newThreadRecents({ composer, todoDispatch, backends, limit });
        const expected: ModelSettingsRecent[] = [];
        const seen = new Set<string>();
        for (const recent of [...composer, ...todoDispatch]) {
          if (expected.length >= limit || seen.has(key(recent))) continue;
          seen.add(key(recent));
          if (startable(recent, backends)) expected.push(recent);
        }
        expect(rows.map((row) => row.recent)).toEqual(expected);
      },
    ), { numRuns: 300 });
  });

  it("claim only a speed the row's model offers", () => {
    fc.assert(fc.property(fc.array(recentArbitrary, { maxLength: 10 }), backendsArbitrary, (composer, backends) => {
      for (const row of newThreadRecents({ composer, todoDispatch: [], backends, limit: 10 })) {
        if (row.backend.kind !== "codex") {
          expect(row.speed).toBe("standard");
          continue;
        }
        expect(codexSpeedOptions(row.model, row.backend.codexFastAllowed !== false,
          row.backend.launchpadOptions?.supportsFastMode ?? false)).toContain(row.speed);
      }
    }), { numRuns: 300 });
  });

  it("record speed for Codex starts only, and only when a tier is on", () => {
    fc.assert(fc.property(
      fc.constantFrom("codex", "claude", "acp:grok"),
      fc.option(fc.constantFrom("ultrafast", "priority"), { nil: undefined }),
      fc.option(fc.boolean(), { nil: undefined }),
      (kind, serviceTier, fastMode) => {
        const recent = newThreadModelSettingsRecent({ backend: kind as never, model: "m", serviceTier, fastMode });
        if (kind !== "codex") {
          expect(recent).toEqual({ backend: kind, model: "m" });
          return;
        }
        expect(recent.fastMode).toBe(fastMode ? true : undefined);
        expect(recent.serviceTier).toBe(serviceTier);
      },
    ));
  });
});
