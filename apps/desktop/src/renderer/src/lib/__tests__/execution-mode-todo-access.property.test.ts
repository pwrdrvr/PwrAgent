import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeConfigOption,
  BackendSummary,
} from "@pwragent/shared/contracts/backend";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadExecutionMode } from "@pwragent/shared/contracts/normalized-app-server";
import { resolveThreadTodoStartAccess, threadTodoAccessForPick } from "@pwragent/shared/thread-todo-access";
import { getAcpRuntimeModeControl, getProviderAccessControl } from "../execution-mode";

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

/** An agent whose own selector owns approval policy, as current Kimi is: it lists no PwrAgent modes. */
function backendFor(runtime: BackendAcpRuntimeCapabilities): BackendSummary {
  return {
    kind: "acp:kimi",
    label: "Kimi",
    available: true,
    methods: [],
    executionModes: [],
    acp: { runtime },
  } as unknown as BackendSummary;
}

/** Antigravity: PwrAgent's Default and Full Access pick its process, and its own modes ride along. */
function antigravityFor(runtime: BackendAcpRuntimeCapabilities): BackendSummary {
  return {
    kind: "acp:antigravity",
    label: "Antigravity",
    available: true,
    methods: [],
    executionModes: [
      { mode: "default", label: "Default Access", available: true },
      { mode: "full-access", label: "Full Access", available: true },
    ],
    acp: { runtime },
  } as unknown as BackendSummary;
}

/** What the composer writes for a pick of `id`, and then shows on the thread. */
function expectComposerWrite(backend: BackendSummary, runtime: unknown, id: string) {
  const composer = getAcpRuntimeModeControl(backend, undefined)!;
  expect(runtime).toEqual(composer.source === "configOption"
    ? { configValues: { [composer.optionId]: id } }
    : { currentModeId: id });
  const thread = { acpRuntime: runtime } as unknown as NavigationThreadSummary;
  expect(getAcpRuntimeModeControl(backend, thread)?.value).toBe(id);
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
      const shown = cardAccess(backend);
      fc.pre(getAcpRuntimeModeControl(backend, undefined) !== undefined && shown.options.length > 0);
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
      // The composer then shows the pick on the started thread.
      expectComposerWrite(backend, access.acpRuntime, option.id);
    }), { numRuns: 500 });
  });

  it("offer Antigravity the exact same unified option set in the composer and on start cards", () => {
    fc.assert(fc.property(runtimeArb, (runtime) => {
      const backend = antigravityFor(runtime);
      const composer = getProviderAccessControl(backend, undefined);
      const card = cardAccess(backend);
      expect(card.options.map((option) => option.kind === "native" ? option.id : option.mode))
        .toEqual(composer?.options.map((option) => option.value) ?? []);
      // Full Access is the process, never Yolo through the Agent mode.
      expect(card.options.some((option) => option.kind === "native" && option.executionMode === "full-access")).toBe(false);
    }), { numRuns: 500 });
  });

  it("start Antigravity's picked mode through the unified selector, and reset Full Access to default native mode", () => {
    fc.assert(fc.property(runtimeArb, fc.nat(), fc.boolean(), (runtime, index, fullAccess) => {
      const backend = antigravityFor(runtime);
      const native = cardAccess(backend).options.filter((option) => option.kind === "native");
      fc.pre(native.length > 0);
      const option = native[index % native.length]!;
      if (option.kind !== "native") return;
      const pick = threadTodoAccessForPick(option, backend.kind);
      const card = fullAccess ? { ...pick, executionMode: "full-access" as const } : pick;
      const access = resolveThreadTodoStartAccess({
        card,
        sourceBackend: backend.kind,
        sourceExecutionMode: card.executionMode,
        destination: backend,
        destinationBackend: backend.kind,
      });
      expect(access.status).toBe("ready");
      if (access.status !== "ready") return;
      expect(access.executionMode).toBe(fullAccess ? "full-access" : "default");
      const thread = {
        executionMode: access.executionMode,
        acpRuntime: access.acpRuntime,
      } as unknown as NavigationThreadSummary;
      if (fullAccess) {
        expect(getProviderAccessControl(backend, thread)?.value).toBe("full-access");
      } else {
        expectComposerWrite(backend, access.acpRuntime, option.id);
        expect(getProviderAccessControl(backend, thread)?.value).toBe(option.id);
      }
    }), { numRuns: 500 });
  });
});
