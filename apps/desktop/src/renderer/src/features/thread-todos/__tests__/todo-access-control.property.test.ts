import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BackendAcpRuntimeCapabilities, BackendSummary } from "@pwragent/shared/contracts/backend";
import type { ThreadExecutionMode } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import {
  resolveThreadTodoStartAccess,
  sameThreadTodoAccessOption,
  threadTodoAccessForPick,
  type ThreadTodoAccessCard,
} from "@pwragent/shared/thread-todo-access";
import { accessShieldLevel, accessStops } from "../../composer/access-picker-model";
import { todoAccessControl } from "../todo-access-control";
import { threadTodoRunRaisesToFullAccess } from "../useThreadTodoFullAccessGate";

/**
 * A start card draws its access with the composer's picker. The picker reads
 * the card's options through `todoAccessControl`, and a stop it commits goes
 * back to the card as `threadTodoAccessForPick` of the option behind it. The
 * card's Start gate judges the stored level, so a stop must store exactly the
 * level it shows: a stop drawn as Full Access must be one Start confirms, and
 * no other stop may store Full Access.
 */

const MODES: readonly ThreadExecutionMode[] = ["default", "auto", "full-access"];
const NATIVE_IDS = ["default", "accept-edits", "auto", "auto-edit", "plan", "yolo", "architect"];

/**
 * How much each option lets the agent do, by its name, as the design orders
 * the bar: Plan < Default < Accept Edits < Auto < Full Access. An unknown
 * mode, such as Architect, runs under Default.
 */
const FREEDOM: Readonly<Record<string, number>> = {
  plan: 0,
  default: 1,
  architect: 1,
  "accept-edits": 2,
  "auto-edit": 2,
  auto: 3,
  yolo: 4,
  "full-access": 4,
};

const runtimeArb: fc.Arbitrary<BackendAcpRuntimeCapabilities> = fc.record({
  ids: fc.uniqueArray(fc.constantFrom(...NATIVE_IDS), { maxLength: 6 }),
  configOption: fc.boolean(),
}).map(({ ids, configOption }) => ({
  schemaVersion: 1,
  status: "ready",
  ...(configOption
    ? {
        configOptions: [{
          id: "permission_mode",
          label: "Mode",
          type: "select",
          category: "mode",
          values: ids.map((id) => ({ value: id, label: id, description: `${id} mode` })),
        }],
      }
    : { modes: { availableModes: ids.map((id) => ({ id, label: id })) } }),
}) as unknown as BackendAcpRuntimeCapabilities);

const listedModesArb = fc.subarray([...MODES]).chain((available) =>
  fc.constant(MODES.map((mode) => ({ mode, label: mode, available: available.includes(mode) }))));

/** A provider with PwrAgent modes, an agent with only its own, or Antigravity's mix of both. */
const destinationArb: fc.Arbitrary<BackendSummary> = fc.oneof(
  listedModesArb.map((executionModes) => ({
    kind: "codex", label: "OpenAI", available: true, methods: [], executionModes,
  }) as unknown as BackendSummary),
  runtimeArb.map((runtime) => ({
    kind: "acp:kimi", label: "Kimi", available: true, methods: [], executionModes: [], acp: { runtime },
  }) as unknown as BackendSummary),
  fc.tuple(listedModesArb, runtimeArb).map(([executionModes, runtime]) => ({
    kind: "acp:antigravity", label: "Antigravity", available: true, methods: [], executionModes, acp: { runtime },
  }) as unknown as BackendSummary),
);

const cardArb: fc.Arbitrary<ThreadTodoAccessCard> = fc.record({
  executionMode: fc.option(fc.constantFrom(...MODES), { nil: undefined }),
  nativeId: fc.option(fc.constantFrom(...NATIVE_IDS), { nil: undefined }),
}).map(({ executionMode, nativeId }) => ({
  ...(executionMode ? { executionMode } : {}),
  ...(nativeId ? { nativeAccessMode: { backend: "acp:antigravity" as const, id: nativeId } } : {}),
}));

const caseArb = fc.record({
  destination: destinationArb,
  card: cardArb,
  sourceExecutionMode: fc.constantFrom(...MODES),
  sameSource: fc.boolean(),
});

function resolve(input: {
  destination: BackendSummary;
  card: ThreadTodoAccessCard;
  sourceExecutionMode: ThreadExecutionMode;
  sameSource: boolean;
}) {
  const { destination, card, sourceExecutionMode, sameSource } = input;
  // A native pick is stored for the card's own destination.
  const stored = card.nativeAccessMode
    ? { ...card, nativeAccessMode: { ...card.nativeAccessMode, backend: destination.kind } }
    : card;
  return resolveThreadTodoStartAccess({
    card: stored,
    sourceBackend: sameSource ? destination.kind : "claude",
    sourceExecutionMode,
    destination,
    destinationBackend: destination.kind,
  });
}

function freedomOf(name: string): number {
  return FREEDOM[name] ?? FREEDOM.default!;
}

describe("a start card's access picker", () => {
  it("draws every option the card offers as one distinct stop, and maps each back to it", () => {
    fc.assert(fc.property(caseArb, (input) => {
      const resolved = resolve(input);
      const { control, optionFor } = todoAccessControl(resolved, input.destination.acp?.runtime);
      const stops = accessStops(control);
      expect(stops).toHaveLength(resolved.options.length);
      expect(new Set(stops.map((stop) => stop.option.value)).size).toBe(stops.length);
      for (const option of resolved.options) {
        const matches = stops.filter((stop) => sameThreadTodoAccessOption(optionFor(stop.option.value), option));
        expect(matches).toHaveLength(1);
      }
      // The chosen stop is the card's selection, and there is none without one.
      const selected = resolved.status === "ready" ? resolved.selected : undefined;
      const offered = selected && resolved.options.some((option) => sameThreadTodoAccessOption(option, selected));
      if (offered) {
        expect(sameThreadTodoAccessOption(optionFor(control.value), selected)).toBe(true);
      } else {
        expect(control.value).toBe("");
        expect(control.selectedOption).toBeUndefined();
      }
    }));
  });

  it("orders the stops from least to most freedom", () => {
    fc.assert(fc.property(caseArb, (input) => {
      const resolved = resolve(input);
      const { control, optionFor } = todoAccessControl(resolved, input.destination.acp?.runtime);
      const freedom = accessStops(control).map((stop) => {
        const option = optionFor(stop.option.value)!;
        return option.kind === "mode" ? freedomOf(option.mode) : freedomOf(option.id);
      });
      for (let index = 1; index < freedom.length; index += 1) {
        expect(freedom[index]!).toBeGreaterThanOrEqual(freedom[index - 1]!);
      }
    }));
  });

  it("stores the level each stop shows, so Start confirms exactly the stops drawn as Full Access", () => {
    fc.assert(fc.property(caseArb, fc.nat(), (input, index) => {
      const resolved = resolve(input);
      const { control, optionFor } = todoAccessControl(resolved, input.destination.acp?.runtime);
      const stops = accessStops(control);
      fc.pre(stops.length > 0);
      const stop = stops[index % stops.length]!;
      const picked = optionFor(stop.option.value)!;
      const stored = threadTodoAccessForPick(picked, input.destination.kind);
      expect(stored.executionMode).toBe(stop.option.executionMode);
      const todo = {
        id: "card",
        action: { type: "start_thread", prompt: "Run it", ...stored },
      } as unknown as ThreadTodo;
      const drawnFull = accessShieldLevel(stops, stop.option) === "full";
      expect(threadTodoRunRaisesToFullAccess(todo)).toBe(drawnFull);
      expect(stop.option.requiresFullAccessConfirmation).toBe(drawnFull);
    }));
  });

  // Shrunk counterexamples from mutating the adapter, kept as examples.
  const kimi = (ids: string[]) => ({
    destination: {
      kind: "acp:kimi", label: "Kimi", available: true, methods: [], executionModes: [],
      acp: { runtime: { schemaVersion: 1, status: "ready", modes: { availableModes: ids.map((id) => ({ id, label: id })) } } },
    } as unknown as BackendSummary,
    card: {},
    sourceExecutionMode: "default" as const,
    sameSource: false,
  });

  it("draws the shield at the level the thread starts at, also on a card it cannot change", () => {
    // A card stored on another machine, or on an owner without these rules,
    // resolves with no destination catalog: it lists no stops, and its
    // readout must still show the level the start applies.
    fc.assert(fc.property(caseArb, fc.boolean(), (input, locked) => {
      const resolved = locked
        ? resolveThreadTodoStartAccess({
            card: input.card.executionMode ? { executionMode: input.card.executionMode } : {},
            sourceBackend: input.sameSource ? input.destination.kind : "claude",
            sourceExecutionMode: input.sourceExecutionMode,
            destination: undefined,
            destinationBackend: input.destination.kind,
          })
        : resolve(input);
      fc.pre(resolved.status === "ready");
      if (resolved.status !== "ready") return;
      const { control, level } = todoAccessControl(resolved, locked ? undefined : input.destination.acp?.runtime);
      const shield = accessShieldLevel(accessStops(control), level);
      expect(shield === "full").toBe(resolved.executionMode === "full-access");
    }));
  });

  it("draws a locked Full Access card's shield full", () => {
    const resolved = resolveThreadTodoStartAccess({
      card: { executionMode: "full-access" },
      sourceBackend: "codex",
      sourceExecutionMode: "default",
      destination: undefined,
      destinationBackend: "codex",
    });
    const { control, level } = todoAccessControl(resolved);
    expect(accessShieldLevel(accessStops(control), level)).toBe("full");
  });

  it("puts an agent's Default before its Accept Edits, whatever order it lists them in", () => {
    const input = kimi(["accept-edits", "default"]);
    const { control } = todoAccessControl(resolve(input), input.destination.acp?.runtime);
    expect(accessStops(control).map((stop) => stop.option.value)).toEqual(["default", "accept-edits"]);
  });

  it("stores an agent's Auto at the level its stop shows", () => {
    const input = kimi(["default", "auto"]);
    const { control, optionFor } = todoAccessControl(resolve(input), input.destination.acp?.runtime);
    const auto = accessStops(control).find((stop) => stop.option.value === "auto")!;
    expect(threadTodoAccessForPick(optionFor("auto")!, "acp:kimi").executionMode).toBe(auto.option.executionMode);
  });

  it("keeps an Antigravity id that repeats a PwrAgent mode apart from it", () => {
    // Example: the resolver drops Antigravity's own Default and Auto beside
    // PwrAgent's, but a stop key must stay unique if it ever lists both.
    const { control, optionFor } = todoAccessControl({
      status: "ready",
      selected: { kind: "native", id: "auto", label: "Auto" },
      source: "card",
      wanted: "default",
      executionMode: "default",
      options: [
        { kind: "mode", mode: "auto" },
        { kind: "native", id: "auto", label: "Auto" },
      ],
    });
    expect(control.options.map((option) => option.value)).toEqual(["auto", "native:auto"]);
    expect(control.value).toBe("native:auto");
    expect(optionFor("native:auto")).toEqual({ kind: "native", id: "auto", label: "Auto" });
  });
});
