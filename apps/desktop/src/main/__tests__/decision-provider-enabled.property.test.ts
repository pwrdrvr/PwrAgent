import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decisionCameraCueAvailability,
  resolveDecisionModelSettings,
  type DesktopDecisionModelSettings,
  type DesktopOpenAIDecisionsSettings,
} from "@pwragent/shared";
import type { RegisteredDecisionProvider } from "@pwragent/shared/openai-decisions";
import {
  isDecisionProviderEnabled,
  resolveDefaultDecisionProvider,
  type DecisionSettingsReader,
} from "../openai-decisions/decision-provider-targets";
import { OpenAIDecisionsService } from "../openai-decisions/openai-decisions-service";
import {
  desktopSettingsPatchToEdits,
  parseDesktopSettingsToml,
} from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";
import { OpenAIDecisionStore } from "../storage/openai-decision-store";
import type { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

/**
 * The rule: a decision provider the operator turned off in Settings is never
 * used. It is not picked as a default, it is not the decision model in
 * effect, live voice sends it no camera frame, and no decision request goes
 * to it. Turning it back on restores what was saved.
 */

const PROVIDERS = ["openai", "jev", "local"] as const satisfies readonly RegisteredDecisionProvider[];

const arbitrarySettings = fc.record({
  on: fc.record({ openai: fc.boolean(), jev: fc.boolean(), local: fc.boolean() }),
  keys: fc.record({ openai: fc.boolean(), jev: fc.boolean() }),
  chosen: fc.constantFrom("local", "jev", "off", undefined),
  cameraCues: fc.option(fc.boolean(), { nil: undefined }),
});
type Arbitrary = typeof arbitrarySettings extends fc.Arbitrary<infer T> ? T : never;

function decisionSettings(value: Arbitrary): DesktopDecisionModelSettings {
  return {
    ...(value.chosen ? { model: value.chosen } : {}),
    ...(value.cameraCues === undefined ? {} : { cameraCues: value.cameraCues }),
    local: { enabled: value.on.local },
    jev: { enabled: value.on.jev },
  };
}

function reader(value: Arbitrary): DecisionSettingsReader {
  return {
    resolveOpenAIDecisionsApiKey: async () => value.keys.openai ? "sk-test-openai" : undefined,
    resolveDecisionModelSettings: () => decisionSettings(value),
    resolveDecisionApiKey: async (provider) => provider === "jev" && value.keys.jev ? "sk-test-jev" : undefined,
    hasOpenAIDecisionsApiKey: async () => value.keys.openai,
    hasDecisionApiKey: async (provider) => provider === "jev" && value.keys.jev,
    resolveOpenAIDecisionsSettings: () => ({ enabled: value.on.openai }),
  };
}

describe("a decision provider that is off is never used", () => {
  it("is not picked as the default, unless every provider is off", async () => {
    await fc.assert(fc.asyncProperty(arbitrarySettings, async (value) => {
      const picked = await resolveDefaultDecisionProvider(reader(value));
      const anyOn = PROVIDERS.some((provider) => value.on[provider]);
      if (anyOn) expect(value.on[picked]).toBe(true);
      // Every provider off: the pick is refused by register (next test).
      else expect(picked).toBe("openai");
    }));
  });

  it("is not the decision model in effect, and gets no camera frames", () => {
    fc.assert(fc.property(arbitrarySettings, (value) => {
      const resolved = resolveDecisionModelSettings(decisionSettings(value));
      expect(resolved.chosenModel).toBe(value.chosen ?? "off");
      if (resolved.model !== "off") expect(value.on[resolved.model]).toBe(true);
      // Oracle: the saved choice when its provider is on, else off.
      const expected = value.chosen && value.chosen !== "off" && value.on[value.chosen] ? value.chosen : "off";
      expect(resolved.model).toBe(expected);
      const camera = decisionCameraCueAvailability(decisionSettings(value));
      if (!value.on.local) expect(camera.available).toBe(false);
    }));
  });

  describe("decisions service", () => {
    let db: StateDb;
    beforeEach(() => { db = openInMemoryStateDb(); });
    afterEach(() => { db.close(); });

    it("refuses register, a move by update, and invoke on a provider that is off, and sends nothing", async () => {
      await fc.assert(fc.asyncProperty(
        fc.record({ openai: fc.boolean(), jev: fc.boolean(), local: fc.boolean() }),
        fc.constantFrom(...PROVIDERS),
        fc.constantFrom(...PROVIDERS),
        async (on, registeredOn, movedTo) => {
          db.raw.exec("DELETE FROM openai_decision_versions");
          const sent: string[] = [];
          const state = { ...on, [registeredOn]: true };
          let ids = 0;
          const service = new OpenAIDecisionsService({
            store: new OpenAIDecisionStore(db),
            readApiKey: async () => "sk-test-openai",
            readSystemOneTarget: async () => ({ endpoint: "http://127.0.0.1:9", model: "m", apiKey: "k" }),
            isProviderEnabled: (provider) => state[provider],
            readAccountSettings: () => ({}),
            profileId: () => "test-profile",
            recordUsageLines: async () => {},
            newDecisionId: () => `decision-${++ids}`,
            fetch: async (url) => {
              sent.push(String(url));
              throw new Error("no network in this test");
            },
            sleep: async () => {},
          });
          const caller = { backend: "codex", threadId: "thread-a" };
          const definition = {
            name: "is_question",
            instructions: "Is this a question?",
            question: { type: "predicate", name: "is_question" },
            inputSchema: { type: "string", maxLength: 100 },
          };
          // Register while the provider is on, then apply the generated switches.
          await service.register(caller, { ...definition, provider: registeredOn });
          Object.assign(state, on);

          const register = service.register(caller, { ...definition, name: "second", provider: registeredOn });
          if (on[registeredOn]) await expect(register).resolves.toMatchObject({ provider: registeredOn });
          else await expect(register).rejects.toMatchObject({ code: "provider_disabled" });

          const move = () => service.update(caller, { ...definition, provider: movedTo });
          if (movedTo !== registeredOn && !on[movedTo]) {
            expect(move).toThrow(expect.objectContaining({ code: "provider_disabled" }));
          } else {
            expect(move()).toMatchObject({ provider: movedTo });
          }

          const current = (movedTo === registeredOn || on[movedTo]) ? movedTo : registeredOn;
          // decisions_list tells the agent which decisions cannot run now.
          for (const listed of service.list(caller, {}).decisions) {
            expect(listed.providerDisabled === true).toBe(!on[listed.provider]);
          }
          const before = sent.length;
          const invoke = service.invoke(caller, { name: "is_question", input: "why?" });
          if (on[current]) {
            // On: the request goes out (and fails here, since there is no network).
            await invoke.catch(() => undefined);
            expect(sent.length).toBeGreaterThan(before);
          } else {
            await expect(invoke).rejects.toMatchObject({ code: "provider_disabled" });
            expect(sent.length).toBe(before);
          }
          await service.close();
        },
      ), { numRuns: 60 });
    });
  });
});

describe("turning a provider off mid-batch", () => {
  let db: StateDb;
  beforeEach(() => { db = openInMemoryStateDb(); });
  afterEach(() => { db.close(); });

  it.each(["jev", "local"] as const)("sends no later %s item once the switch is off", async (provider) => {
    const state = { openai: true, jev: true, local: true };
    const sentStates = new Set<unknown>();
    const service = new OpenAIDecisionsService({
      store: new OpenAIDecisionStore(db),
      readApiKey: async () => "sk-test-openai",
      readSystemOneTarget: async () => ({ endpoint: "http://127.0.0.1:9", model: "m", apiKey: "k" }),
      isProviderEnabled: (name) => state[name],
      readAccountSettings: () => ({}),
      profileId: () => "test-profile",
      recordUsageLines: async () => {},
      newDecisionId: () => "decision-1",
      fetch: async (_url, init) => {
        sentStates.add((JSON.parse(String(init?.body)) as { state: unknown }).state);
        // The operator turns the provider off while the first item is in flight.
        state[provider] = false;
        throw new Error("no network in this test");
      },
      sleep: async () => {},
    });
    const caller = { backend: "codex", threadId: "thread-a" };
    await service.register(caller, {
      name: "is_question",
      provider,
      instructions: "Is this a question?",
      question: { type: "predicate", name: "is_question" },
      inputSchema: { type: "string", maxLength: 100 },
    });
    await service.invoke(caller, { name: "is_question", inputs: ["a", "b", "c", "d"], concurrency: 1 })
      .catch(() => undefined);
    expect([...sentStates]).toEqual(["a"]);
    await service.close();
  });
});

describe("the switches survive config.toml", () => {
  const save = (existing: string, models: { decisionModels?: DesktopDecisionModelSettings; openaiDecisions?: DesktopOpenAIDecisionsSettings }) =>
    applyTomlEdits(existing, desktopSettingsPatchToEdits({ models }, parseTomlTables(existing, "test.toml")));

  it("reads back what was saved, writing only the off switches", () => {
    fc.assert(fc.property(arbitrarySettings, fc.boolean(), (value, withIds) => {
      const written = save("", {
        decisionModels: decisionSettings(value),
        openaiDecisions: { enabled: value.on.openai, ...(withIds ? { projectId: "proj_test" } : {}) },
      });
      const models = parseDesktopSettingsToml(written, "test.toml").models;
      const settings = {
        resolveDecisionModelSettings: () => models?.decisionModels ?? {},
        resolveOpenAIDecisionsSettings: () => models?.openaiDecisions ?? {},
      };
      for (const provider of PROVIDERS) {
        expect(isDecisionProviderEnabled(settings, provider)).toBe(value.on[provider]);
      }
      expect(written).not.toMatch(/enabled = true/);
      if (withIds) expect(models?.openaiDecisions?.projectId).toBe("proj_test");
      // Turning a provider back on keeps the saved choice.
      expect(resolveDecisionModelSettings(models?.decisionModels).chosenModel).toBe(value.chosen ?? "off");
    }));
  });
});
