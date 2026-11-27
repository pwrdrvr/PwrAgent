import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BackendAcpRuntimeCapabilities,
  BackendSummary,
} from "@pwragent/shared/contracts/backend";
import type {
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import type {
  AppServerBackendKind,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import { Composer } from "../Composer";
import {
  accessStopValues,
  allowAccessStop,
  chooseAccessStop,
  openAccessPicker,
  queryAccessTriggers,
} from "../../../test/access-picker";

vi.mock("../dictation-capture", () => ({ startDictationCapture: vi.fn() }));

afterEach(() => {
  cleanup();
});

const BACKEND_KINDS: readonly AppServerBackendKind[] = [
  "codex",
  "claude",
  "acp:antigravity",
  "acp:kimi",
  "acp:grok",
  "acp:qwen",
  "acp:gemini",
];

const NATIVE_MODES = [
  { id: "default", label: "Default" },
  { id: "accept-edits", label: "Accept Edits" },
  { id: "auto", label: "Auto" },
  { id: "plan", label: "Plan" },
  { id: "yolo", label: "Yolo" },
] as const;

const backendSummaryArb: fc.Arbitrary<BackendSummary> = fc.record({
  kind: fc.constantFrom(...BACKEND_KINDS),
  executionModes: fc.subarray<ThreadExecutionMode>(["default", "auto", "full-access"]),
  nativeModes: fc.subarray([...NATIVE_MODES]),
  useConfigOption: fc.boolean(),
}).map(({ kind, executionModes, nativeModes, useConfigOption }) => {
  const isAcp = kind.startsWith("acp:");
  const registryId = isAcp ? kind.slice(4) : undefined;
  const runtime: BackendAcpRuntimeCapabilities | undefined = isAcp && nativeModes.length > 0
    ? {
        schemaVersion: 1,
        status: "discovered",
        ...(useConfigOption
          ? {
              configOptions: [{
                id: registryId === "grok" ? "permission_mode" : "mode",
                label: "Mode",
                type: "select",
                category: "mode",
                currentValue: nativeModes[0]!.id,
                values: nativeModes.map((m) => ({ value: m.id, label: m.label })),
              }],
            }
          : {}),
        modes: {
          availableModes: nativeModes.map((m) => ({ id: m.id, label: m.label })),
          currentModeId: nativeModes[0]!.id,
        },
      }
    : undefined;
  return {
    kind,
    label: kind,
    available: true,
    methods: [],
    capabilities: {
      listThreads: true,
      createThread: true,
      resumeThread: true,
      renameThread: true,
      readThread: true,
      startTurn: true,
      interruptTurn: true,
      steerTurn: false,
      transcriptPagination: false,
      toolUse: true,
      approvalRequests: true,
      multiDirectoryThreads: false,
    },
    executionModes: executionModes.map((mode) => ({
      mode,
      label: mode === "auto" ? "Auto" : mode === "full-access" ? "Full Access" : "Default Access",
      available: true,
      ...(mode === "default" ? { isDefault: true } : {}),
    })),
    ...(isAcp
      ? {
          acp: {
            registryId: registryId!,
            distributionKinds: ["local"],
            installStatus: "installed",
            authStatus: "not-required",
            verificationStatus: "not-applicable",
            ...(runtime ? { runtime } : {}),
          },
        }
      : {}),
  } as unknown as BackendSummary;
});

function antigravityBackend(): BackendSummary {
  return {
    kind: "acp:antigravity",
    label: "Antigravity",
    available: true,
    methods: [],
    capabilities: {
      listThreads: true,
      createThread: true,
      resumeThread: true,
      renameThread: true,
      readThread: true,
      startTurn: true,
      interruptTurn: true,
      steerTurn: true,
      transcriptPagination: false,
      toolUse: true,
      approvalRequests: true,
      multiDirectoryThreads: false,
    },
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
        configOptions: [{
          id: "mode",
          label: "Mode",
          type: "select",
          category: "mode",
          currentValue: "default",
          values: [
            { value: "default", label: "Default" },
            { value: "accept-edits", label: "Accept Edits" },
            { value: "auto", label: "Auto" },
            { value: "plan", label: "Plan" },
          ],
        }],
        modes: {
          availableModes: [
            { id: "default", label: "Default" },
            { id: "accept-edits", label: "Accept Edits" },
            { id: "auto", label: "Auto" },
            { id: "plan", label: "Plan" },
          ],
          currentModeId: "default",
        },
      },
    },
  };
}

function makeLaunchpad(
  backend: AppServerBackendKind,
  executionMode: ThreadExecutionMode,
  acpRuntime?: NavigationLaunchpadDraft["acpRuntime"],
): NavigationLaunchpadDraft {
  return {
    directoryKey: "directory:/repo",
    directoryKind: "directory",
    directoryLabel: "Repo",
    directoryPath: "/repo",
    backend,
    executionMode,
    ...(acpRuntime ? { acpRuntime } : {}),
    prompt: "",
    workMode: "local",
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeThread(
  backend: AppServerBackendKind,
  executionMode: ThreadExecutionMode,
  acpRuntime?: NavigationThreadSummary["acpRuntime"],
): NavigationThreadSummary {
  return {
    id: "thread-1",
    title: "Thread",
    titleSource: "explicit",
    source: backend,
    executionMode,
    ...(acpRuntime ? { acpRuntime } : {}),
    linkedDirectories: [],
    inbox: { inInbox: false },
  };
}

describe("Composer single access mode control property", () => {
  it("renders at most one access/mode dropdown for every provider on launchpads and live threads", () => {
    fc.assert(
      fc.property(
        backendSummaryArb,
        fc.constantFrom<ThreadExecutionMode>("default", "full-access"),
        fc.boolean(),
        (backend, executionMode, isLaunchpad) => {
          cleanup();
          render(
            <Composer
              backends={[backend]}
              disabled={false}
              launchpad={isLaunchpad ? makeLaunchpad(backend.kind, executionMode) : undefined}
              onSetAcpRuntimeOption={async () => undefined}
              onSetExecutionMode={async () => undefined}
              onUpdateLaunchpad={async () => undefined}
              skills={[]}
              thread={isLaunchpad ? undefined : makeThread(backend.kind, executionMode)}
            />,
          );
          expect(queryAccessTriggers().length).toBeLessThanOrEqual(1);
          expect(screen.queryAllByLabelText(/^(Access mode|Agent mode)(?::|$)/)).toHaveLength(0);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("renders one Access picker for Antigravity, ordered by freedom, and confirms + normalizes Plan -> Full Access inline on launchpad", async () => {
    const onUpdateLaunchpad = vi.fn(async () => undefined);
    render(
      <Composer
        backends={[antigravityBackend()]}
        disabled={false}
        launchpad={makeLaunchpad("acp:antigravity", "default", { configValues: { mode: "plan" } })}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />,
    );
    const controls = queryAccessTriggers();
    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveAccessibleName("Access: Plan");
    expect(controls[0]).toHaveValue("plan");
    expect(controls[0]).toHaveAttribute("aria-haspopup", "dialog");

    expect(accessStopValues()).toEqual(["plan", "default", "accept-edits", "auto", "full-access"]);
    expect(within(openAccessPicker()).getByRole("slider", { name: "Access level" }))
      .toHaveAttribute("aria-valuetext", "Plan");

    chooseAccessStop("full-access");
    // The bar shows the stop, but nothing changes until Allow, and the
    // confirmation is inline rather than the modal warning.
    expect(onUpdateLaunchpad).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Enable Full Access?" })).not.toBeInTheDocument();
    expect(controls[0]).toHaveValue("plan");

    allowAccessStop();
    await waitFor(() => {
      expect(onUpdateLaunchpad).toHaveBeenCalledWith(
        "directory:/repo",
        expect.objectContaining({
          executionMode: "full-access",
          acpRuntime: expect.objectContaining({
            configValues: { mode: "default" },
          }),
        }),
        { stickySettingsChanged: true },
      );
    });
  });

  it("transitions an existing Antigravity thread atomically from Full Access to Accept Edits through one call", async () => {
    const onSetExecutionMode = vi.fn(async () => undefined);
    const onSetAcpRuntimeOption = vi.fn(async () => undefined);
    render(
      <Composer
        backends={[antigravityBackend()]}
        disabled={false}
        onSetAcpRuntimeOption={onSetAcpRuntimeOption}
        onSetExecutionMode={onSetExecutionMode}
        skills={[]}
        thread={makeThread("acp:antigravity", "full-access", { configValues: { mode: "default" } })}
      />,
    );
    const controls = queryAccessTriggers();
    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveValue("full-access");

    chooseAccessStop("accept-edits");

    await waitFor(() => {
      expect(onSetExecutionMode).toHaveBeenCalledWith("default", {
        source: "configOption",
        optionId: "mode",
        value: "accept-edits",
      });
    });
    expect(onSetAcpRuntimeOption).not.toHaveBeenCalled();
  });
});
