import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo, useState, type ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelSettingsRecent } from "@pwragent/shared/contracts/agent";
import { type BackendSummary } from "@pwragent/shared/contracts/backend";
import {
  applyNavigationLaunchpadProviderSettingsPatch,
  type NavigationLaunchpadDraft,
} from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../../../lib/desktop-api";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { modelSettingsPill, openModelSettings } from "../../../test/model-settings";
import { Composer as ProductionComposer } from "../Composer";

function Composer(props: ComponentProps<typeof ProductionComposer>) {
  const desktopApi = useMemo<DesktopApi>(() => ({
    ...props.desktopApi,
    getNavigationQueryPage: props.desktopApi?.getNavigationQueryPage
      ?? (async (request) => navigationQueryFixture(request, props)),
  }), [props]);
  return <ProductionComposer {...props} desktopApi={desktopApi} />;
}

beforeAll(() => {
  const emptyRect = { bottom: 0, height: 0, left: 0, right: 0, toJSON: () => ({}), top: 0, width: 0, x: 0, y: 0 } as DOMRect;
  const textPrototype = Text.prototype as Text & {
    getClientRects?: () => DOMRect[];
    getBoundingClientRect?: () => DOMRect;
  };
  textPrototype.getClientRects ??= () => [];
  textPrototype.getBoundingClientRect ??= () => emptyRect;
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => emptyRect;
});

afterEach(() => {
  cleanup();
});

const capabilities = {
  listThreads: true, createThread: true, resumeThread: true, renameThread: false, readThread: true,
  startTurn: true, interruptTurn: true, steerTurn: false, transcriptPagination: true, toolUse: false,
  approvalRequests: true, multiDirectoryThreads: true,
};

const codex = {
  kind: "codex",
  label: "OpenAI",
  available: true,
  methods: ["thread/start", "turn/start"],
  capabilities,
  executionModes: [{ mode: "default", label: "Default Access", available: true, isDefault: true }],
  launchpadOptions: {
    models: [
      { id: "gpt-6-sol", label: "GPT-6-Sol", supportsReasoning: true, supportsFast: true,
        reasoningEfforts: ["low", "medium", "high"] },
    ],
    supportsFastMode: true,
  },
} as BackendSummary;

const claude = {
  kind: "claude",
  label: "Claude",
  available: true,
  methods: ["thread/start", "turn/start"],
  capabilities,
  executionModes: [{ mode: "default", label: "Default Access", available: true, isDefault: true }],
  launchpadOptions: {
    models: [
      { id: "opus", label: "Opus 5.5", supportsReasoning: true, reasoningEfforts: ["low", "medium", "high", "max"] },
      { id: "sonnet", label: "Sonnet 5.5", supportsReasoning: true, reasoningEfforts: ["low", "high"] },
    ],
  },
} as BackendSummary;

const launchpad: NavigationLaunchpadDraft = {
  backend: "codex",
  directoryKey: "directory:/repo",
  directoryKind: "directory",
  directoryLabel: "Repo",
  directoryPath: "/repo",
  executionMode: "default",
  model: "gpt-6-sol",
  reasoningEffort: "medium",
  prompt: "",
  workMode: "local",
  createdAt: 1,
  updatedAt: 1,
} as NavigationLaunchpadDraft;

const grok = {
  kind: "acp:grok",
  label: "Grok",
  available: true,
  methods: ["thread/start", "turn/start"],
  capabilities,
  executionModes: [{ mode: "default", label: "Default Access", available: true, isDefault: true }],
  launchpadOptions: {
    models: [
      { id: "grok-5", label: "Grok 5", isDefault: true, supportsReasoning: true, reasoningEfforts: ["low", "high"] },
      { id: "grok-5-mini", label: "Grok 5 Mini", supportsReasoning: true, reasoningEfforts: ["low", "high"] },
    ],
  },
} as BackendSummary;

function renderLaunchpad(
  recents: { composer: ModelSettingsRecent[]; todoDispatch: ModelSettingsRecent[] },
  options: {
    initial?: NavigationLaunchpadDraft;
    backends?: BackendSummary[];
    onProviderSelected?: ComponentProps<typeof ProductionComposer>["onProviderSelected"];
  } = {},
) {
  const patches: Array<Partial<NavigationLaunchpadDraft>> = [];
  const backends = options.backends ?? [codex, claude];
  let latest = options.initial ?? launchpad;
  const listModelSettingsRecents = vi.fn(async ({ scope }: { scope: string }) => ({
    recents: scope === "composer" ? recents.composer : scope === "todo-dispatch" ? recents.todoDispatch : [],
  }));
  function Harness() {
    const [current, setCurrent] = useState(latest);
    return (
      <Composer
        backends={backends}
        desktopApi={{
          listBackends: vi.fn(async () => ({ fetchedAt: 1, backends })),
          listModelSettingsRecents: listModelSettingsRecents as unknown as DesktopApi["listModelSettingsRecents"],
        }}
        directory={{ key: "directory:/repo", kind: "directory", label: "Repo", path: "/repo" }}
        launchpad={current}
        {...(options.onProviderSelected ? { onProviderSelected: options.onProviderSelected } : {})}
        onUpdateLaunchpad={async (_key, patch) => {
          patches.push(patch);
          latest = applyNavigationLaunchpadProviderSettingsPatch<NavigationLaunchpadDraft>(latest, patch);
          setCurrent(latest);
        }}
        skills={[]}
      />
    );
  }
  render(<Harness />);
  return { patches, listModelSettingsRecents, state: () => latest };
}

async function settleRecents(list: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(list).toHaveBeenCalledWith({ scope: "todo-dispatch" }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("new-thread Recent settings", () => {
  it("opens on Recent and starts the next thread on a recent provider, model, effort and speed in one click", async () => {
    const { patches, listModelSettingsRecents } = renderLaunchpad({
      composer: [
        { backend: "claude", model: "opus", reasoningEffort: "high" },
        // A model this catalog no longer lists is not offered.
        { backend: "claude", model: "opus-4", reasoningEffort: "high" },
      ],
      todoDispatch: [
        { backend: "codex", model: "gpt-6-sol", reasoningEffort: "high", fastMode: true },
        { backend: "claude", model: "opus", reasoningEffort: "high" },
      ],
    });
    await waitFor(() => expect(listModelSettingsRecents).toHaveBeenCalledWith({ scope: "todo-dispatch" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const panel = openModelSettings();
    expect(within(panel).getByRole("button", { name: "Recent" })).toHaveAttribute("aria-pressed", "true");
    const rows = within(within(panel).getByRole("listbox", { name: "Recent settings" })).getAllByRole("option");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Claude, Opus 5.5, high effort",
      "OpenAI, GPT-6-Sol, high effort, Fast",
    ]);

    fireEvent.click(rows[0]!);
    await waitFor(() => expect(modelSettingsPill()).toHaveAttribute("data-model", "opus"));
    expect(patches.at(-1)).toMatchObject({ backend: "claude", model: "opus", reasoningEffort: "high" });
    expect(modelSettingsPill()).toHaveAttribute("data-effort", "high");
    expect(screen.queryByRole("dialog")).toBeNull();

    // The row now matches the launchpad, so it carries the check.
    const reopened = openModelSettings();
    await waitFor(() => {
      expect(within(reopened).getByRole("option", { name: "Claude, Opus 5.5, high effort" }))
        .toHaveAttribute("aria-selected", "true");
    });
    fireEvent.click(within(reopened).getByRole("option", { name: "OpenAI, GPT-6-Sol, high effort, Fast" }));
    await waitFor(() => expect(modelSettingsPill()).toHaveAttribute("data-model", "gpt-6-sol"));
    expect(patches.at(-1)).toMatchObject({
      backend: "codex", model: "gpt-6-sol", reasoningEffort: "high", fastMode: true, serviceTier: undefined,
    });
  });

  it("replays a row's unset model and effort as unset, and checks that row after", async () => {
    const { listModelSettingsRecents, state } = renderLaunchpad({
      // A thread that started on Claude's default model and effort.
      composer: [{ backend: "claude" }],
      todoDispatch: [],
    }, { initial: { ...launchpad, backend: "claude", model: "opus", reasoningEffort: "high" } });
    await settleRecents(listModelSettingsRecents);
    const panel = openModelSettings();
    fireEvent.click(within(panel).getByRole("option", { name: "Claude, Default model" }));
    await waitFor(() => expect(state().model).toBeUndefined());
    expect(state().reasoningEffort).toBeUndefined();

    const reopened = openModelSettings();
    await waitFor(() => {
      expect(within(reopened).getByRole("option", { name: "Claude, Default model" }))
        .toHaveAttribute("aria-selected", "true");
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  });

  it("keeps a Recent row's agent model through that agent's catalog refresh", async () => {
    const onProviderSelected = vi.fn(async () => grok);
    const { listModelSettingsRecents, state } = renderLaunchpad({
      composer: [{ backend: "acp:grok", model: "grok-5-mini", reasoningEffort: "low" }],
      todoDispatch: [],
    }, { backends: [codex, claude, grok], onProviderSelected });
    await settleRecents(listModelSettingsRecents);
    const panel = openModelSettings();
    fireEvent.click(within(panel).getByRole("option", { name: "Grok, Grok 5 Mini, low effort" }));
    await waitFor(() => expect(onProviderSelected).toHaveBeenCalledWith("acp:grok"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(state()).toMatchObject({ backend: "acp:grok", model: "grok-5-mini", reasoningEffort: "low" });
  });

  it("opens on the editor, with no Recent tab, before any thread has started", async () => {
    const { listModelSettingsRecents } = renderLaunchpad({ composer: [], todoDispatch: [] });
    await waitFor(() => expect(listModelSettingsRecents).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const panel = openModelSettings();
    expect(within(panel).queryByRole("button", { name: "Recent" })).toBeNull();
    expect(within(panel).getByRole("listbox", { name: "Model" })).toBeTruthy();
    // Opening reads the lists again; let that read land.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  });
});
