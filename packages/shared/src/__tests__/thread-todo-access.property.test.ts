import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerBackendKind, ThreadExecutionMode } from "../contracts/normalized-app-server";
import {
  resolveThreadTodoStartAccess,
  sameThreadTodoAccessOption,
  threadTodoAccessForPick,
  type ThreadTodoAccessCard,
  type ThreadTodoAccessDestination,
  type ThreadTodoAccessOption,
} from "../thread-todo-access";

const ORDER: ThreadExecutionMode[] = ["default", "auto", "full-access"];
const rank = (mode: ThreadExecutionMode) => ORDER.indexOf(mode);
/** The native ids that carry a PwrAgent level, as agents name them. */
const LEVEL_OF: Record<string, ThreadExecutionMode> = { default: "default", auto: "auto", yolo: "full-access" };
const BACKENDS: AppServerBackendKind[] = ["codex", "claude", "acp:antigravity", "acp:kimi"];

const nativeIdsArb = fc.uniqueArray(fc.constantFrom("default", "accept-edits", "auto", "plan", "yolo", "architect"), { maxLength: 6 });

/** A provider as its catalog lists it: PwrAgent modes, an agent's own modes, or neither. */
const destinationArb = (kind: AppServerBackendKind): fc.Arbitrary<ThreadTodoAccessDestination> => fc.oneof(
  fc.uniqueArray(fc.record({ mode: fc.constantFrom(...ORDER), available: fc.boolean() }), {
    selector: (entry) => entry.mode, minLength: 1, maxLength: 3,
  }).map((modes) => ({
    kind, label: kind, executionModes: modes.map((entry) => ({ ...entry, label: entry.mode })),
  }) as ThreadTodoAccessDestination),
  fc.tuple(
    nativeIdsArb,
    fc.constantFrom("permission", "sessionModes", "modeConfig"),
    nativeIdsArb,
  ).map(([ids, shape, sessionIds]) => ({
    kind,
    label: kind,
    executionModes: [],
    acp: {
      runtime: shape === "permission"
        ? { schemaVersion: 1, status: "ready", configOptions: [{
            id: "permission_mode", label: "Permissions", type: "select", category: "mode",
            values: ids.map((value) => ({ value })),
          }] }
        : shape === "modeConfig"
          // Antigravity, Kimi and Qwen list a `mode` config beside their session
          // modes. They mirror each other today; nothing makes them.
          ? { schemaVersion: 1, status: "ready", configOptions: [{
              id: "mode", label: "Mode", type: "select", category: "mode",
              values: ids.map((value) => ({ value })),
            }], modes: { availableModes: sessionIds.map((id) => ({ id, label: id })) } }
          : { schemaVersion: 1, status: "ready", modes: { availableModes: ids.map((id) => ({ id, label: id })) } },
    },
  }) as unknown as ThreadTodoAccessDestination),
);

type Scenario = {
  sourceBackend: AppServerBackendKind;
  sourceExecutionMode: ThreadExecutionMode;
  destinationBackend: AppServerBackendKind;
  destination: ThreadTodoAccessDestination;
  card: ThreadTodoAccessCard;
};

/**
 * A card as the system makes one: an agent proposes no mode or one mode,
 * and the operator may then pick from the menu some destination showed,
 * possibly another provider's before the provider was changed.
 */
const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  sourceBackend: fc.constantFrom(...BACKENDS),
  sourceExecutionMode: fc.constantFrom(...ORDER),
  destinationBackend: fc.constantFrom(...BACKENDS),
  proposed: fc.option(fc.constantFrom(...ORDER), { nil: undefined }),
  pickedOn: fc.option(fc.constantFrom(...BACKENDS), { nil: undefined }),
  pickIndex: fc.nat(),
  // Any caller of setThreadTodoAccess, a federated peer included, can store
  // a level that disagrees with the pick; the card's own menu never does.
  storedLevel: fc.option(fc.constantFrom(...ORDER), { nil: undefined, freq: 4 }),
}).chain((base) => fc.record({
  destination: destinationArb(base.destinationBackend),
  pickDestination: destinationArb(base.pickedOn ?? base.destinationBackend),
}).map(({ destination, pickDestination }) => {
  const proposed: ThreadTodoAccessCard = base.proposed ? { executionMode: base.proposed } : {};
  let card = proposed;
  if (base.pickedOn) {
    // The menu the operator picked from: the same provider's catalog, or another provider's.
    const pickedFrom = base.pickedOn === base.destinationBackend ? destination : pickDestination;
    const shown = resolveThreadTodoStartAccess({
      card: proposed, sourceBackend: base.sourceBackend, sourceExecutionMode: base.sourceExecutionMode,
      destination: pickedFrom, destinationBackend: base.pickedOn,
    });
    const option = shown.options[base.pickIndex % Math.max(shown.options.length, 1)];
    if (option) card = threadTodoAccessForPick(option, base.pickedOn);
    if (base.storedLevel) card = { ...card, executionMode: base.storedLevel };
  }
  return {
    sourceBackend: base.sourceBackend,
    sourceExecutionMode: base.sourceExecutionMode,
    destinationBackend: base.destinationBackend,
    destination,
    card,
  };
}));

/**
 * The selector the composer's mode picker shows: Grok's `permission_mode`,
 * else any other mode config option with values, else the ACP session modes.
 */
function nativeSelector(destination: ThreadTodoAccessDestination): { configId?: string; ids: string[] } {
  const runtime = destination.acp?.runtime;
  const config = runtime?.configOptions?.find((option) => option.id === "permission_mode" && option.category === "mode")
    ?? runtime?.configOptions?.find((option) => option.category === "mode" && option.values.length > 0);
  const ids = config ? config.values.map((value) => value.value) : runtime?.modes?.availableModes.map((mode) => mode.id) ?? [];
  return { ...(config ? { configId: config.id } : {}), ids: ids.length < 2 ? [] : ids };
}

function nativeIds(destination: ThreadTodoAccessDestination): string[] {
  return nativeSelector(destination).ids;
}

type Expected =
  | { status: "refused" }
  | { status: "ready"; selected: ThreadTodoAccessOption | undefined; executionMode: ThreadExecutionMode };

/** Slow and literal: the rules as the to-do card and the escalation doc state them. */
function oracle(scenario: Scenario): Expected {
  const { card, destination } = scenario;
  const wanted = card.executionMode ?? scenario.sourceExecutionMode;
  const sameBackend = scenario.destinationBackend === scenario.sourceBackend;
  if (destination.executionModes.length > 0) {
    const offered = (mode: ThreadExecutionMode) =>
      destination.executionModes.some((entry) => entry.mode === mode && entry.available);
    if (card.executionMode !== undefined) {
      return offered(wanted) ? { status: "ready", selected: { kind: "mode", mode: wanted }, executionMode: wanted } : { status: "refused" };
    }
    if (offered(wanted) || sameBackend) return { status: "ready", selected: { kind: "mode", mode: wanted }, executionMode: wanted };
    if (offered("default")) return { status: "ready", selected: { kind: "mode", mode: "default" }, executionMode: "default" };
    return { status: "refused" };
  }
  const ids = nativeIds(destination);
  const recorded = (id: string): ThreadExecutionMode => LEVEL_OF[id] === "full-access" ? "full-access" : "default";
  const native = (id: string): ThreadTodoAccessOption => ({
    kind: "native", id, label: id, ...(LEVEL_OF[id] ? { executionMode: LEVEL_OF[id] } : {}),
  });
  const pickLevel = card.nativeAccessMode ? LEVEL_OF[card.nativeAccessMode.id] : undefined;
  if (card.nativeAccessMode?.backend === scenario.destinationBackend && ids.includes(card.nativeAccessMode.id)
    && (pickLevel === undefined || rank(pickLevel) <= rank(wanted))) {
    return { status: "ready", selected: native(card.nativeAccessMode.id), executionMode: recorded(card.nativeAccessMode.id) };
  }
  let best: string | undefined;
  for (const id of ids) {
    const level = LEVEL_OF[id];
    if (level === undefined || rank(level) > rank(wanted)) continue;
    if (best === undefined || rank(level) > rank(LEVEL_OF[best]!)) best = id;
  }
  if (best) return { status: "ready", selected: native(best), executionMode: recorded(best) };
  const fallback = card.executionMode !== undefined || sameBackend ? wanted : "default";
  return { status: "ready", selected: ids.length > 0 ? undefined : { kind: "mode", mode: fallback }, executionMode: fallback };
}

const resolve = (scenario: Scenario) => resolveThreadTodoStartAccess(scenario);

describe("resolveThreadTodoStartAccess", () => {
  it("shows and starts Antigravity Auto on the Default process when the agent offers it", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), (explicit, offersNativeAuto) => {
      const destinationBackend = "acp:antigravity";
      const destination: ThreadTodoAccessDestination = {
        kind: destinationBackend, label: "Antigravity",
        executionModes: [
          { mode: "default", available: true, label: "Default Access" },
          { mode: "full-access", available: true, label: "Full Access" },
        ],
        acp: {
          registryId: "antigravity", distributionKinds: ["local"], installStatus: "installed",
          authStatus: "not-required", verificationStatus: "not-applicable",
          runtime: { schemaVersion: 1, status: "discovered", modes: { availableModes: [
            { id: "default", label: "Default" },
            ...(offersNativeAuto ? [{ id: "auto", label: "Auto" }] : [{ id: "plan", label: "Plan" }]),
          ] } },
        },
      };
      const access = resolveThreadTodoStartAccess({
        card: explicit ? { executionMode: "auto" } : {},
        sourceBackend: "codex", sourceExecutionMode: explicit ? "default" : "auto",
        destination, destinationBackend,
      });
      if (!offersNativeAuto) {
        expect(access.status).toBe(explicit ? "refused" : "ready");
        if (access.status === "ready") expect(access.executionMode).toBe("default");
        return;
      }
      const nativeAuto = { kind: "native", id: "auto", label: "Auto", executionMode: "auto" };
      expect(access).toMatchObject({
        status: "ready", selected: nativeAuto, executionMode: "default",
        acpRuntime: { currentModeId: "auto" },
        options: expect.arrayContaining([nativeAuto, { kind: "mode", mode: "full-access" }]),
      });
    }));
  });

  it("starts Antigravity in the saved native mode on Default process and resets Full Access to default native mode", () => {
    fc.assert(fc.property(
      fc.constantFrom("default", "full-access"),
      fc.constantFrom("default", "plan", "accept-edits"),
      (executionMode, id) => {
        const backend = "acp:antigravity";
        const destination: ThreadTodoAccessDestination = {
          kind: backend, label: "Antigravity",
          executionModes: [
            { mode: "default", available: true, label: "Default Access" },
            { mode: "full-access", available: true, label: "Full Access" },
          ],
          acp: {
            registryId: "antigravity", distributionKinds: ["local"], installStatus: "installed",
            authStatus: "not-required", verificationStatus: "not-applicable",
            runtime: { schemaVersion: 1, status: "discovered", modes: { availableModes: [
              { id: "default", label: "Default" }, { id: "plan", label: "Plan" },
              { id: "accept-edits", label: "Accept Edits" },
            ] } },
          },
        };
        const access = resolveThreadTodoStartAccess({
          card: { executionMode, nativeAccessMode: { backend, id } },
          sourceBackend: backend, sourceExecutionMode: "default", destination, destinationBackend: backend,
        });
        if (executionMode === "full-access") {
          expect(access).toMatchObject({
            status: "ready",
            executionMode: "full-access",
            selected: { kind: "mode", mode: "full-access" },
          });
          if (access.status === "ready") {
            expect(access.acpRuntime).toBeUndefined();
          }
        } else {
          expect(access).toMatchObject({
            status: "ready",
            executionMode: "default",
            acpRuntime: { currentModeId: id },
          });
        }
      },
    ));
  });

  it("matches the stated rules for every card, source and destination", () => {
    fc.assert(fc.property(scenarioArb, (scenario) => {
      const actual = resolve(scenario);
      const expected = oracle(scenario);
      expect(actual.status).toBe(expected.status);
      if (actual.status !== "ready" || expected.status !== "ready") return;
      expect(sameThreadTodoAccessOption(actual.selected, expected.selected)).toBe(true);
      expect(actual.executionMode).toBe(expected.executionMode);
      // The start writes the selector the menu listed the mode from.
      if (actual.selected?.kind !== "native") {
        expect(actual.acpRuntime).toBeUndefined();
        return;
      }
      const { configId } = nativeSelector(scenario.destination);
      expect(actual.acpRuntime).toEqual(configId
        ? { configValues: { [configId]: actual.selected.id } }
        : { currentModeId: actual.selected.id });
    }), { numRuns: 400 });
  });

  it("never starts above the card's stored access, or the raising thread's when the card names none", () => {
    fc.assert(fc.property(scenarioArb, (scenario) => {
      const access = resolve(scenario);
      if (access.status !== "ready") return;
      const ceiling = scenario.card.executionMode ?? scenario.sourceExecutionMode;
      expect(rank(access.executionMode)).toBeLessThanOrEqual(rank(ceiling));
      const level = access.selected?.kind === "mode" ? access.selected.mode : access.selected?.executionMode;
      if (level) expect(rank(level)).toBeLessThanOrEqual(rank(ceiling));
    }));
  });

  it("offers only the destination's available modes, and shows one of them", () => {
    fc.assert(fc.property(scenarioArb, (scenario) => {
      const access = resolve(scenario);
      const { destination } = scenario;
      const listed = destination.executionModes.length > 0
        ? ORDER.filter((mode) => destination.executionModes.some((entry) => entry.mode === mode && entry.available))
          .map((mode): ThreadTodoAccessOption => ({ kind: "mode", mode }))
        : nativeIds(destination).map((id): ThreadTodoAccessOption => ({ kind: "native", id, label: id }));
      expect(access.options.length).toBe(listed.length);
      listed.forEach((option, index) => expect(sameThreadTodoAccessOption(access.options[index], option)).toBe(true));
      // The raising thread already runs at its mode on its own provider.
      const keepsSourceMode = access.status === "ready" && access.source === "inherited"
        && scenario.destinationBackend === scenario.sourceBackend && destination.executionModes.length > 0;
      if (access.status === "ready" && access.selected && access.options.length > 0 && !keepsSourceMode) {
        expect(access.options.some((option) => sameThreadTodoAccessOption(option, access.selected))).toBe(true);
      }
    }));
  });

  it("starts with exactly the operator's pick, and gates it as Full Access when it carries Full Access", () => {
    fc.assert(fc.property(scenarioArb, fc.nat(), (scenario, index) => {
      const shown = resolve(scenario);
      fc.pre(shown.options.length > 0);
      const option = shown.options[index % shown.options.length]!;
      const card = threadTodoAccessForPick(option, scenario.destinationBackend);
      const started = resolve({ ...scenario, card });
      expect(started.status).toBe("ready");
      if (started.status !== "ready") return;
      expect(sameThreadTodoAccessOption(started.selected, option)).toBe(true);
      expect(started.source).toBe("card");
      // The desktop gate holds back a card whose stored mode is Full Access.
      const level = option.kind === "mode" ? option.mode : option.executionMode;
      expect(card.executionMode === "full-access").toBe(level === "full-access");
      expect(started.executionMode === "full-access").toBe(level === "full-access");
    }));
  });
});
