import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeConfigOption,
  BackendSummary,
} from "@pwragent/shared/contracts/backend";
import type { ThreadExecutionMode } from "@pwragent/shared/contracts/normalized-app-server";
import { resolveThreadTodoStartAccess, threadTodoAccessForPick } from "@pwragent/shared/thread-todo-access";
import { getAcpRuntimeModeControl } from "../execution-mode";

const MODE_IDS = ["default", "accept-edits", "auto", "auto-edit", "plan", "yolo", "architect"];

/** Values as an agent lists them; Antigravity, Kimi and Qwen mirror their session modes. */
const valuesArb = fc.uniqueArray(fc.constantFrom(...MODE_IDS), { maxLength: 5 });

const configOptionArb: fc.Arbitrary<BackendAcpRuntimeConfigOption> = fc.record({
  id: fc.constantFrom("permission_mode", "mode", "approval", "model", "thought_level"),
  category: fc.constantFrom("mode", "model", "thought_level", undefined),
  values: valuesArb,
}).map(({ id, category, values }) => ({
  id,
  label: id,
  type: "select",
  ...(category ? { category } : {}),
  values: values.map((value) => ({ value, label: value })),
}) as BackendAcpRuntimeConfigOption);

/** Any mix of mode-carrying config options and ACP session modes. */
const runtimeArb: fc.Arbitrary<BackendAcpRuntimeCapabilities> = fc.record({
  configOptions: fc.option(fc.uniqueArray(configOptionArb, { selector: (option) => option.id, maxLength: 4 }), { nil: undefined }),
  sessionModes: fc.option(valuesArb, { nil: undefined }),
}).map(({ configOptions, sessionModes }) => ({
  schemaVersion: 1,
  status: "ready",
  ...(configOptions ? { configOptions } : {}),
  ...(sessionModes ? { modes: { availableModes: sessionModes.map((id) => ({ id, label: id })) } } : {}),
}) as unknown as BackendAcpRuntimeCapabilities);

function backendFor(runtime: BackendAcpRuntimeCapabilities): BackendSummary {
  return {
    kind: "acp:antigravity",
    label: "Antigravity",
    available: true,
    methods: [],
    executionModes: [],
    acp: { runtime },
  } as unknown as BackendSummary;
}

function cardAccess(backend: BackendSummary, sourceExecutionMode: ThreadExecutionMode = "full-access") {
  return resolveThreadTodoStartAccess({
    card: {},
    sourceBackend: backend.kind,
    sourceExecutionMode,
    destination: backend,
    destinationBackend: backend.kind,
  });
}

describe("the composer's mode picker and a start card's Access menu", () => {
  it("offer the same modes for every runtime an agent can advertise", () => {
    fc.assert(fc.property(runtimeArb, (runtime) => {
      const backend = backendFor(runtime);
      const composer = getAcpRuntimeModeControl(backend, undefined);
      const card = cardAccess(backend);
      expect(card.options.map((option) => option.kind === "native" ? option.id : option.mode))
        .toEqual(composer?.options.map((option) => option.value) ?? []);
    }), { numRuns: 500 });
  });

  it("start a picked mode through the selector the composer writes", () => {
    fc.assert(fc.property(runtimeArb, fc.nat(), (runtime, index) => {
      const backend = backendFor(runtime);
      const composer = getAcpRuntimeModeControl(backend, undefined);
      const shown = cardAccess(backend);
      fc.pre(composer !== undefined && shown.options.length > 0);
      const option = shown.options[index % shown.options.length]!;
      fc.pre(option.kind === "native");
      if (option.kind !== "native") return;
      // Start at the pick's own level, so the start keeps exactly the pick.
      const pick = threadTodoAccessForPick(option, backend.kind);
      const access = resolveThreadTodoStartAccess({
        card: pick,
        sourceBackend: backend.kind,
        sourceExecutionMode: pick.executionMode,
        destination: backend,
        destinationBackend: backend.kind,
      });
      expect(access.status).toBe("ready");
      if (access.status !== "ready") return;
      expect(access.acpRuntime).toEqual(composer!.source === "configOption"
        ? { configValues: { [composer!.optionId]: option.id } }
        : { currentModeId: option.id });
    }), { numRuns: 500 });
  });
});
