import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import {
  CAPTURE_HELPER_IDS,
  type DesktopHelperModelChoice,
  type DesktopHelperModelSettings,
} from "@pwragent/shared/helper-models";
import {
  CAPTURE_ORIGINS,
  captureRowState,
  withCaptureRow,
  type CaptureOrigin,
} from "../../renderer/src/features/settings/token-miser-capture-helpers";
import { boundedCommandHelper } from "../token-miser/bounded-command-helper";

const MODELS = ["model-a", "model-b"];
// Never called: the property reads only whether, and how, a route resolves.
const client = () => ({ generateStructuredObject: vi.fn(async () => ({ status: "ok" as const, object: { choice: "0" } })) });

/** Every runner connected and offering every model, so only the routing rule decides. */
const BACKENDS = (["codex", "claude", "acp:grok"] as const).map((kind) => ({
  kind,
  label: kind,
  available: true,
  launchpadOptions: { models: MODELS.map((id) => ({ id, label: id })) },
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

function ownerRoute(settings: DesktopHelperModelSettings, origin: CaptureOrigin) {
  return boundedCommandHelper({
    resolveTokenMiserBoundedHelper: () => "configured",
    resolveHelperModelSettings: () => settings,
    resolveDecisionModelSettings: () => ({}),
    resolveDecisionApiKey: async () => undefined,
  }, client(), undefined, { origin, threadId: "thread", claude: client(), grok: client() });
}

describe("Token Miser (v2) capture rows in Settings", () => {
  // Differential: the line under each Settings row must agree with the
  // owner's routing about whether, and with what, a thread type picks.
  it("names exactly the backend, model and effort the owner will run", () => {
    fc.assert(fc.property(settingsArbitrary, (settings) => {
      for (const { origin } of CAPTURE_ORIGINS) {
        const state = captureRowState(origin, settings, BACKENDS);
        const owner = ownerRoute(settings, origin);
        expect(state.status.kind === "ready").toBe(owner !== undefined);
        if (owner) {
          expect(owner.identity).toBe(JSON.stringify([
            "configured", state.helper, state.backend, state.model, state.effort,
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

  it("does not let Claude or Antigravity threads inherit the Codex Helper model", () => {
    const settings: DesktopHelperModelSettings = { defaultModel: "model-a", helpers: {} };
    expect(captureRowState("codex", settings, BACKENDS)).toMatchObject({
      status: { kind: "ready" }, model: "model-a", modelSource: "helper-default",
    });
    expect(captureRowState("claude", settings, BACKENDS).status.kind).toBe("needs-model");
    expect(captureRowState("acp:antigravity", settings, BACKENDS).status.kind).toBe("needs-backend");
    expect(ownerRoute(settings, "claude")).toBeUndefined();
    expect(ownerRoute(settings, "acp:antigravity")).toBeUndefined();
    // Shrunk counterexample: a Claude row that names Codex still needs its own model.
    const claudeOnCodex: DesktopHelperModelSettings = {
      defaultModel: "model-b",
      helpers: { [CAPTURE_HELPER_IDS.claude]: { backend: "codex" } },
    };
    expect(captureRowState("claude", claudeOnCodex, BACKENDS).status.kind).toBe("needs-model");
    expect(ownerRoute(claudeOnCodex, "claude")).toBeUndefined();
  });

  it("reports a runner that is not connected instead of claiming it will run", () => {
    const settings: DesktopHelperModelSettings = {
      helpers: { [CAPTURE_HELPER_IDS["acp:antigravity"]]: { backend: "acp:grok", model: "model-a" } },
    };
    const withoutGrok = BACKENDS.filter((backend) => backend.kind !== "acp:grok");
    expect(captureRowState("acp:antigravity", settings, withoutGrok).status.kind).toBe("backend-unavailable");
  });
});
