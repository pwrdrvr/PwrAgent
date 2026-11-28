import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import { BOUNDED_COMMAND_HELPER_MODES } from "@pwragent/shared/contracts/settings";
import {
  CAPTURE_HELPER_IDS,
  HELPER_MODEL_AUTOMATIC_ORDER,
  type DesktopHelperModelChoice,
  type DesktopHelperModelSettings,
} from "@pwragent/shared/helper-models";
import {
  CAPTURE_ORIGINS,
  captureRowState,
  tokenMiserModelChoices,
  withCaptureRow,
  type CaptureOrigin,
} from "../../renderer/src/features/settings/token-miser-capture-helpers";
import { boundedCommandHelper } from "../token-miser/bounded-command-helper";

const MODELS = ["model-a", "model-b"];
// Never called: the property reads only whether, and how, a route resolves.
const client = () => ({ generateStructuredObject: vi.fn(async () => ({ status: "ok" as const, object: { choice: "0" } })) });

/**
 * Every runner connected and offering every model, so only the routing rule
 * decides. Codex also offers Automatic's choices.
 */
const BACKENDS = (["codex", "claude", "acp:grok"] as const).map((kind) => ({
  kind,
  label: kind,
  available: true,
  launchpadOptions: {
    models: [...MODELS, ...(kind === "codex" ? HELPER_MODEL_AUTOMATIC_ORDER : [])].map((id) => ({ id, label: id })),
  },
})) as unknown as BackendSummary[];

const choice = fc.record({
  backend: fc.constantFrom(undefined, "codex", "claude", "acp:grok", "acp:antigravity", "unknown"),
  model: fc.constantFrom(undefined, ...MODELS),
  reasoningEffort: fc.constantFrom(undefined, "low", "high"),
}).map((row): DesktopHelperModelChoice => Object.fromEntries(
  Object.entries(row).filter(([, value]) => value !== undefined),
));

const settingsArbitrary = fc.record({
  defaultModel: fc.constantFrom(undefined, ...MODELS),
  defaultReasoningEffort: fc.constantFrom(undefined, "medium"),
  codex: fc.option(choice, { nil: undefined }),
  claude: fc.option(choice, { nil: undefined }),
  antigravity: fc.option(choice, { nil: undefined }),
  other: fc.option(choice, { nil: undefined }),
}).map((value): DesktopHelperModelSettings => {
  const helpers: Record<string, DesktopHelperModelChoice> = {};
  if (value.codex) helpers[CAPTURE_HELPER_IDS.codex] = value.codex;
  if (value.claude) helpers[CAPTURE_HELPER_IDS.claude] = value.claude;
  if (value.antigravity) helpers[CAPTURE_HELPER_IDS["acp:antigravity"]] = value.antigravity;
  // Rows Settings must carry through untouched, known or not.
  if (value.other) {
    helpers.thread_titles = value.other;
    helpers.helper_from_a_newer_build = value.other;
  }
  return {
    ...(value.defaultModel ? { defaultModel: value.defaultModel } : {}),
    ...(value.defaultReasoningEffort ? { defaultReasoningEffort: value.defaultReasoningEffort } : {}),
    helpers,
  };
});

function ownerRoute(
  settings: DesktopHelperModelSettings,
  origin: CaptureOrigin,
  grokEnabled = true,
  mode: "helper" | "configured" = "configured",
) {
  // No gate, summarizer on: the owner routes to the summarizer alone.
  return boundedCommandHelper({
    resolveTokenMiserGate: () => "none",
    resolveTokenMiserSummarizer: () => mode,
    resolveHelperModelSettings: () => settings,
    resolveDecisionModelSettings: () => ({}),
    resolveDecisionApiKey: async () => undefined,
  }, client(), undefined, {
    origin, threadId: "thread", claude: client(), grok: client(), grokEnabled: () => grokEnabled,
  });
}

describe("Token Miser (v2) capture rows in Settings", () => {
  // Differential: the line under each Settings row must agree with the
  // owner's routing about whether, and with what, a thread type picks.
  it("names exactly the backend, model and effort the owner will run", () => {
    fc.assert(fc.property(settingsArbitrary, fc.constantFrom("helper" as const, "configured" as const), (settings, mode) => {
      for (const { origin } of CAPTURE_ORIGINS) {
        const state = captureRowState(origin, settings, BACKENDS, mode);
        const owner = ownerRoute(settings, origin, true, mode);
        expect(state.status.kind === "ready").toBe(owner !== undefined);
        if (owner) {
          expect(owner.identity).toBe(JSON.stringify([
            "none", undefined, state.helper, state.backend, state.model, state.effort, state.exact,
          ]));
        }
      }
    }));
  });

  it("saves one row and keeps every other helper setting", () => {
    fc.assert(fc.property(
      settingsArbitrary,
      fc.constantFrom(...CAPTURE_ORIGINS.map((entry) => entry.origin)),
      fc.option(choice, { nil: undefined }),
      (settings, origin, next) => {
        const helper = CAPTURE_HELPER_IDS[origin];
        const saved = withCaptureRow(settings, helper, next);
        const { [helper]: _before, ...othersBefore } = settings.helpers;
        const { [helper]: after, ...othersAfter } = saved.helpers;
        expect(othersAfter).toEqual(othersBefore);
        expect(saved.defaultModel).toBe(settings.defaultModel);
        expect(saved.defaultReasoningEffort).toBe(settings.defaultReasoningEffort);
        expect(after).toEqual(next && Object.keys(next).length > 0 ? next : undefined);
      },
    ));
  });

  it("uses the Helper model for a thread type that names no model", () => {
    const settings: DesktopHelperModelSettings = { defaultModel: "model-a", helpers: {} };
    for (const { origin } of CAPTURE_ORIGINS) {
      expect(captureRowState(origin, settings, BACKENDS)).toMatchObject({
        status: { kind: "ready" }, backend: "codex", model: "model-a", modelSource: "helper-default", exact: true,
      });
      expect(ownerRoute(settings, origin)).toBeDefined();
    }
    // Automatic: the owner asks for its first choice and Codex may fall back.
    expect(captureRowState("claude", { helpers: {} }, BACKENDS)).toMatchObject({
      status: { kind: "ready" }, model: HELPER_MODEL_AUTOMATIC_ORDER[0], exact: false,
    });
    // A Claude row naming Codex and no model is the Helper model too.
    const claudeOnCodex: DesktopHelperModelSettings = {
      defaultModel: "model-b",
      helpers: { [CAPTURE_HELPER_IDS.claude]: { backend: "codex" } },
    };
    expect(captureRowState("claude", claudeOnCodex, BACKENDS)).toMatchObject({ status: { kind: "ready" }, model: "model-b" });
    // A row naming another backend without a model has chosen nothing.
    const claudeOnGrok: DesktopHelperModelSettings = {
      defaultModel: "model-b",
      helpers: { [CAPTURE_HELPER_IDS.claude]: { backend: "acp:grok" } },
    };
    expect(captureRowState("claude", claudeOnGrok, BACKENDS).status.kind).toBe("needs-model");
    expect(ownerRoute(claudeOnGrok, "claude")).toBeUndefined();
  });

  it("ignores thread-type rows when every thread type uses the Helper model", () => {
    const settings: DesktopHelperModelSettings = {
      defaultModel: "model-a",
      helpers: { [CAPTURE_HELPER_IDS.claude]: { backend: "claude", model: "model-b", reasoningEffort: "high" } },
    };
    expect(captureRowState("claude", settings, BACKENDS, "helper")).toMatchObject({
      backend: "codex", model: "model-a", effort: "low",
    });
    expect(ownerRoute(settings, "claude", true, "helper")?.identity).toContain("\"codex\",\"model-a\"");
  });

  it("reports a runner that is not connected instead of claiming it will run", () => {
    const settings: DesktopHelperModelSettings = {
      helpers: { [CAPTURE_HELPER_IDS["acp:antigravity"]]: { backend: "acp:grok", model: "model-a" } },
    };
    const withoutGrok = BACKENDS.filter((backend) => backend.kind !== "acp:grok");
    expect(captureRowState("acp:antigravity", settings, withoutGrok).status.kind).toBe("backend-unavailable");
    // A disabled Grok is not connected in Settings, and the owner skips it too.
    expect(ownerRoute(settings, "acp:antigravity", false)).toBeUndefined();
  });
});

describe("Token Miser (v2) gate and summarizer in Settings", () => {
  const source = fc.constantFrom("default" as const, "config" as const);
  const setting = <T extends string>(values: readonly T[]) => fc.option(
    fc.record({ value: fc.constantFrom(...values), source }),
    { nil: undefined },
  );

  // The earlier excerpt-picker key must never choose a gate or summarizer:
  // only an explicit save of the new keys does.
  it("selects a gate or summarizer only from its own key, and reports an earlier choice until one is made", () => {
    fc.assert(fc.property(
      setting(BOUNDED_COMMAND_HELPER_MODES),
      setting(["none", "openai", "jev", "local"] as const),
      setting(["off", "configured"] as const),
      (legacy, gate, summarizer) => {
        const choices = tokenMiserModelChoices({
          tokenMiserBoundedHelper: legacy,
          tokenMiserGate: gate,
          tokenMiserSummarizer: summarizer,
        });
        expect(choices.gate.value).toBe(gate?.value ?? "none");
        expect(choices.summarizer.value).toBe(summarizer?.value ?? "off");
        const chosen = (gate?.source ?? "default") !== "default"
          || (summarizer?.source ?? "default") !== "default";
        const saved = legacy && legacy.source !== "default" && legacy.value !== "deterministic";
        expect(choices.earlier).toBe(!chosen && saved ? legacy.value : undefined);
      },
    ));
  });

  it("leaves an upgraded profile with a saved OpenAI excerpt picker on no gate and no summarizer", () => {
    expect(tokenMiserModelChoices({
      tokenMiserBoundedHelper: { value: "openai", source: "config" },
    })).toEqual({
      gate: { value: "none", source: "default" },
      summarizer: { value: "off", source: "default" },
      earlier: "openai",
    });
  });
});
