import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeConfigOption,
  BackendSummary,
} from "@pwragent/shared/contracts/backend";
import type {
  AppServerBackendKind,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  resolveProviderAccessControl,
  type ProviderAccessModeOption,
} from "@pwragent/shared/provider-access-mode";
import {
  accessStops,
  stepAccessPicker,
  type AccessPickerEvent,
  type AccessPickerState,
} from "../access-picker-model";
import { effortStopForKey, steppedStopForKey } from "../model-settings-picker-model";

const BACKEND_KINDS: readonly AppServerBackendKind[] = [
  "codex",
  "claude",
  "acp:antigravity",
  "acp:kimi",
  "acp:grok",
  "acp:qwen",
  "acp:gemini",
];

const MODE_IDS = ["default", "accept-edits", "auto", "auto-edit", "plan", "yolo", "full-access"] as const;

const modeIdsArb = fc.uniqueArray(fc.constantFrom(...MODE_IDS), { maxLength: 7 });

const configOptionArb: fc.Arbitrary<BackendAcpRuntimeConfigOption> = fc.record({
  id: fc.constantFrom("permission_mode", "mode", "approval"),
  category: fc.constantFrom("mode", undefined),
  values: modeIdsArb,
}).map(({ id, category, values }) => ({
  id,
  label: id,
  type: "select",
  ...(category ? { category } : {}),
  values: values.map((value) => ({ value, label: value })),
}) as BackendAcpRuntimeConfigOption);

const runtimeArb: fc.Arbitrary<BackendAcpRuntimeCapabilities | undefined> = fc.option(
  fc.record({
    configOptions: fc.option(
      fc.uniqueArray(configOptionArb, { selector: (option) => option.id, maxLength: 2 }),
      { nil: undefined },
    ),
    sessionModes: fc.option(modeIdsArb, { nil: undefined }),
  }).map(({ configOptions, sessionModes }) => ({
    schemaVersion: 1,
    status: "discovered",
    ...(configOptions ? { configOptions } : {}),
    ...(sessionModes
      ? { modes: { availableModes: sessionModes.map((id) => ({ id, label: id })) } }
      : {}),
  }) as unknown as BackendAcpRuntimeCapabilities),
  { nil: undefined },
);

// Every provider shape `resolveProviderAccessControl` serves, including an
// unavailable Auto (the composer keeps it as a disabled stop).
const backendArb = fc.record({
  kind: fc.constantFrom(...BACKEND_KINDS),
  executionModes: fc.subarray<ThreadExecutionMode>(["default", "auto", "full-access"]),
  autoAvailable: fc.boolean(),
  runtime: runtimeArb,
}).map(({ kind, executionModes, autoAvailable, runtime }) => ({
  kind,
  label: kind,
  available: true,
  executionModes: executionModes.map((mode) => ({
    mode,
    label: mode === "auto" ? "Auto" : mode === "full-access" ? "Full Access" : "Default Access",
    available: mode !== "auto" || autoAvailable,
    ...(mode === "auto" && !autoAvailable ? { unavailableReason: "Auto needs a newer CLI." } : {}),
    ...(mode === "default" ? { isDefault: true } : {}),
  })),
  ...(kind.startsWith("acp:")
    ? {
        acp: {
          registryId: kind.slice(4),
          distributionKinds: ["local"],
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          ...(runtime ? { runtime } : {}),
        },
      }
    : {}),
}) as unknown as BackendSummary);

/**
 * The approved design's order, read from each option's name: Plan < Default
 * < Accept Edits (an agent's Auto Edit) < Auto < Full Access (an agent's
 * Yolo). Written from the names, not from the rank table under test.
 */
function designRank(option: ProviderAccessModeOption): number | undefined {
  if (option.executionMode === "full-access") return 4;
  switch (option.label.toLowerCase()) {
    case "plan":
      return 0;
    case "default":
    case "default access":
      return 1;
    case "accept edits":
    case "auto edit":
      return 2;
    case "auto":
      return 3;
    case "full access":
    case "yolo":
      return 4;
    default:
      return undefined;
  }
}

function controlFor(backend: BackendSummary) {
  return resolveProviderAccessControl({ backend, includeUnavailableAuto: true });
}

describe("access level stops", () => {
  it("order every provider's options from least to most freedom, keeping every option", () => {
    fc.assert(
      fc.property(backendArb, (backend) => {
        const control = controlFor(backend);
        if (!control) return;
        const stops = accessStops(control);
        // The stops are exactly the resolver's options, reordered only.
        expect(stops.map((stop) => stop.option.value).sort())
          .toEqual(control.options.map((option) => option.value).sort());
        const ranks = stops.map((stop) => designRank(stop.option));
        for (let i = 0; i < ranks.length; i += 1) {
          for (let j = i + 1; j < ranks.length; j += 1) {
            const left = ranks[i];
            const right = ranks[j];
            if (left === undefined || right === undefined) continue;
            expect(left, `${stops[i]!.label} before ${stops[j]!.label}`).toBeLessThanOrEqual(right);
          }
        }
        // An option that cannot be chosen is still a stop, with its reason.
        for (const stop of stops) {
          expect(stop.disabled).toBe(!stop.option.available);
          if (stop.disabled) expect(stop.reason).toBeTruthy();
        }
      }),
      { numRuns: 300 },
    );
  });

  it("puts Antigravity's native Plan below Default and Full Access last", () => {
    // The counterexample the property found against the resolver's own
    // order, where Plan follows Default, Accept Edits and Auto.
    const backend = {
      kind: "acp:antigravity",
      label: "Antigravity",
      available: true,
      executionModes: [
        { mode: "default", label: "Default Access", available: true, isDefault: true },
        { mode: "full-access", label: "Full Access", available: true },
      ],
      acp: {
        registryId: "antigravity",
        distributionKinds: ["local"],
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        runtime: {
          schemaVersion: 1,
          status: "discovered",
          modes: {
            availableModes: ["default", "accept-edits", "auto", "plan"].map((id) => ({ id, label: id })),
          },
        },
      },
    } as unknown as BackendSummary;
    const control = controlFor(backend)!;
    expect(control.options.map((option) => option.value))
      .toEqual(["default", "accept-edits", "auto", "plan", "full-access"]);
    expect(accessStops(control).map((stop) => stop.tick))
      .toEqual(["Plan", "Default", "Edits", "Auto", "Full"]);
  });

  it("orders an agent's own modes by freedom, not by the agent's list", () => {
    // The shrunk counterexample: an agent with only native modes that lists
    // Auto before Default.
    const backend = {
      kind: "acp:antigravity",
      label: "acp:antigravity",
      available: true,
      executionModes: [],
      acp: {
        registryId: "antigravity",
        distributionKinds: ["local"],
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        runtime: {
          schemaVersion: 1,
          status: "discovered",
          modes: { availableModes: [{ id: "auto", label: "auto" }, { id: "default", label: "default" }] },
        },
      },
    } as unknown as BackendSummary;
    expect(accessStops(controlFor(backend)!).map((stop) => stop.option.value)).toEqual(["default", "auto"]);
  });
});

// Each pick names a stop by index, so one generated list replays against
// whatever stops the generated provider has.
const pickArb = fc.record({
  type: fc.constantFrom("choose", "choose", "allow", "cancel"),
  stop: fc.nat(),
});

function toEvent(pick: { type: string; stop: number }, values: readonly string[]): AccessPickerEvent {
  if (pick.type === "allow") return { type: "allow" };
  if (pick.type === "cancel") return { type: "cancel" };
  return { type: "choose", value: values[pick.stop % values.length]! };
}

describe("access picker confirmation", () => {
  it("never commits a stop that needs confirmation except from Allow on that same pending stop", () => {
    fc.assert(
      fc.property(
        backendArb,
        fc.nat(),
        fc.boolean(),
        fc.array(pickArb, { minLength: 1, maxLength: 30 }),
        (backend, startPick, dismissed, picks) => {
          const control = controlFor(backend);
          if (!control) return;
          const stops = accessStops(control);
          const values = stops.map((stop) => stop.option.value);
          const events = picks.map((pick) => toEvent(pick, values));
          let value = values[startPick % values.length]!;
          let state: AccessPickerState = {};
          const executionModeOf = (current: string): ThreadExecutionMode =>
            stops.find((stop) => stop.option.value === current)?.option.executionMode ?? "default";
          // The composer's rule: the option asks for it, the gate's warning
          // is not dismissed, and the thread is not already at Full Access.
          const needsConfirmation = (option: ProviderAccessModeOption): boolean =>
            option.requiresFullAccessConfirmation
            && !dismissed
            && executionModeOf(value) !== "full-access";
          for (const event of events) {
            const before = state;
            const step = stepAccessPicker(state, event, { stops, value, needsConfirmation });
            state = step.state;
            if (!step.commit) continue;
            const stop = stops.find((candidate) => candidate.option.value === step.commit!.value)!;
            expect(stop.disabled).toBe(false);
            expect(step.commit.value).not.toBe(value);
            if (needsConfirmation(stop.option)) {
              expect(event.type).toBe("allow");
              expect(before.pending).toBe(step.commit.value);
              expect(step.commit.confirmed).toBe(true);
            } else {
              expect(step.commit.confirmed).toBe(false);
            }
            value = step.commit.value;
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keys skip disabled stops and never land on one", () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 7 }),
        fc.integer({ min: -1, max: 6 }),
        fc.constantFrom("ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"),
        (enabled, start, key) => {
          const index = start < enabled.length ? start : -1;
          const next = steppedStopForKey(key, index, enabled);
          if (next !== undefined) expect(enabled[next]).toBe(true);
          // With every stop usable, it is the effort slider's own key map.
          if (enabled.every(Boolean)) {
            expect(next).toBe(effortStopForKey(key, index, enabled.length));
          }
        },
      ),
    );
  });
});
