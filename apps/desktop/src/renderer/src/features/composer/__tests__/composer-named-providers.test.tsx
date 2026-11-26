import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo, useState, type ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyNavigationLaunchpadProviderSettingsPatch,
  type NavigationLaunchpadDraft,
} from "@pwragent/shared/contracts/navigation";
import { type BackendModelOption, type BackendSummary } from "@pwragent/shared/contracts/backend";
import type { DesktopApi } from "../../../lib/desktop-api";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { composerDropdownOptionLabels } from "../../../test/model-catalog";
import { chooseEffort, effortStops, modelSettingsPill, openModelSettings } from "../../../test/model-settings";
import { Composer as ProductionComposer } from "../Composer";

/**
 * Two OpenAI-compatible providers registered for Codex beside OpenAI, both
 * serving `gpt-oss-120b`, plus one whose catalog read failed with nothing
 * listed. MathOS and Acme Lab are placeholders.
 */
function Composer(props: ComponentProps<typeof ProductionComposer>) {
  const desktopApi = useMemo<DesktopApi>(() => ({
    ...props.desktopApi,
    getNavigationQueryPage: props.desktopApi?.getNavigationQueryPage
      ?? (async (request) => navigationQueryFixture(request, props)),
  }), [props.desktopApi, props.directories, props.threads]);
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

const MATHOS_MODELS = Array.from({ length: 300 }, (_, index) => `mathos-model-${index}`);

const models: BackendModelOption[] = [
  { id: "gpt-6-sol", label: "GPT-6-Sol", supportsReasoning: true, reasoningEfforts: ["low", "high"] },
  { id: "gpt-oss-120b", label: "gpt-oss-120b" },
  ...["gpt-oss-120b", ...MATHOS_MODELS].map((id) => ({
    id: `@mathos/${id}`,
    label: id,
    providerId: "mathos",
    providerLabel: "MathOS",
    supportsReasoning: false,
    supportsFast: false,
  })),
  {
    id: "@refuseless/gpt-oss-120b",
    label: "gpt-oss-120b",
    providerId: "refuseless",
    providerLabel: "Refuseless",
    supportsReasoning: false,
    supportsFast: false,
  },
];

const codex = {
  kind: "codex",
  label: "OpenAI",
  available: true,
  methods: ["thread/start", "turn/start"],
  capabilities: {
    listThreads: true,
    createThread: true,
    resumeThread: true,
    renameThread: false,
    readThread: true,
    startTurn: true,
    interruptTurn: true,
    steerTurn: false,
    transcriptPagination: true,
    toolUse: false,
    approvalRequests: true,
    multiDirectoryThreads: true,
  },
  executionModes: [{ mode: "default", label: "Default Access", available: true, isDefault: true }],
  launchpadOptions: { models, reasoningEfforts: ["low", "high"] },
  modelDefaults: { model: "gpt-6-sol", reasoningEffortsByModel: {} },
  codexModelProviders: [
    { id: "mathos", name: "MathOS", status: "ready", listedCount: 0, discoveredCount: 301 },
    { id: "refuseless", name: "Refuseless", status: "unavailable", listedCount: 1, error: "HTTP 503" },
    { id: "acme", name: "Acme Lab", status: "unavailable", listedCount: 0, error: "HTTP 401" },
    { id: "flint", name: "Flint", status: "unavailable", listedCount: 0, error: "fetch failed" },
  ],
} as BackendSummary;

const initialLaunchpad: NavigationLaunchpadDraft = {
  backend: "codex",
  directoryKey: "directory:/repo",
  directoryKind: "directory",
  directoryLabel: "Repo",
  directoryPath: "/repo",
  executionMode: "default",
  model: "gpt-6-sol",
  prompt: "",
  workMode: "local",
  createdAt: 1,
  updatedAt: 1,
} as NavigationLaunchpadDraft;

/** The Provider rail or the Model list in the model pill's panel. */
function openDropdown(label: "Provider" | "Model"): HTMLElement {
  return within(openModelSettings()).getByRole("listbox", { name: label });
}

function openUnavailableProviders(): HTMLElement {
  fireEvent.click(within(openModelSettings()).getByRole("button", { name: "Unavailable" }));
  return screen.getByRole("listbox", { name: "Provider: Unavailable" });
}

function renderLaunchpad(
  backend: BackendSummary = codex,
  startingLaunchpad: NavigationLaunchpadDraft = initialLaunchpad,
) {
  const patches: Array<Partial<NavigationLaunchpadDraft>> = [];
  function Harness() {
    const [launchpad, setLaunchpad] = useState(startingLaunchpad);
    return (
      <Composer
        backends={[backend]}
        desktopApi={{ listBackends: vi.fn(async () => ({ fetchedAt: 1, backends: [backend] })) }}
        directory={{ key: "directory:/repo", kind: "directory", label: "Repo", path: "/repo" }}
        launchpad={launchpad}
        onUpdateLaunchpad={async (_key, patch) => {
          patches.push(patch);
          setLaunchpad((current) =>
            applyNavigationLaunchpadProviderSettingsPatch<NavigationLaunchpadDraft>(current, patch));
        }}
        skills={[]}
      />
    );
  }
  render(<Harness />);
  return patches;
}

describe("named Codex model providers in the composer", () => {
  it("lists each provider by its own name in the Provider picker, and says why one offers nothing", () => {
    renderLaunchpad();
    const list = openDropdown("Provider");
    // The rail holds the providers that work now. The rest wait behind an
    // Unavailable disclosure at its end.
    expect(composerDropdownOptionLabels(list)).toEqual(["OpenAI", "MathOS"]);
    expect(within(list).getByRole("option", { name: /MathOS/ })).toHaveTextContent("Runs on Codex · 301 models");
    const unavailable = openUnavailableProviders();
    expect(composerDropdownOptionLabels(unavailable)).toEqual(["Refuseless", "Acme Lab", "Flint"]);
    expect(within(unavailable).getByRole("option", { name: /Refuseless/ }))
      .toHaveTextContent("Runs on Codex · 1 model · catalog unavailable");
    const acme = within(unavailable).getByRole("option", { name: /Acme Lab/ });
    expect(acme).toHaveTextContent("No models. Catalog unavailable: HTTP 401");
    expect(acme).toHaveAttribute("aria-disabled", "true");
    // A stopped local server is offline, not an error: the reason waits in the tooltip.
    const flint = within(unavailable).getByRole("option", { name: /Flint/ });
    expect(flint).toHaveTextContent("Runs on Codex · offline");
    expect(flint).not.toHaveTextContent("fetch failed");
    expect(flint).toHaveAttribute("aria-disabled", "true");
    expect(flint).toHaveAttribute("aria-description",
      "Flint did not answer (fetch failed). Start it, or list a model in Settings.");
  });

  it("starts a MathOS thread on Codex with a MathOS model, and offers MathOS's whole catalog alone", async () => {
    const patches = renderLaunchpad(codex, {
      ...initialLaunchpad,
      reasoningEffort: "high",
      providerSettings: {
        codex: {
          model: "gpt-6-sol",
          reasoningEffort: "high",
          reasoningEffortsByModel: { "gpt-6-sol": "high" },
        },
      },
    });
    expect(modelSettingsPill()).toHaveAttribute("data-model", "gpt-6-sol");
    fireEvent.click(within(openDropdown("Provider")).getByRole("option", { name: /MathOS/ }));
    await waitFor(() => {
      expect(modelSettingsPill()).toHaveTextContent("MathOS");
    });
    expect(patches.at(-1)).toMatchObject({
      backend: "codex",
      model: "@mathos/gpt-oss-120b",
      reasoningEffort: undefined,
      fastMode: undefined,
      serviceTier: undefined,
    });
    expect(modelSettingsPill()).not.toHaveAttribute("data-effort");
    expect(effortStops()).toEqual([]);
    const modelList = openDropdown("Model");
    // The same upstream id, served by MathOS, and every model MathOS lists.
    expect(composerDropdownOptionLabels(modelList)).toEqual(["gpt-oss-120b", ...MATHOS_MODELS]);
    fireEvent.click(within(modelList).getByRole("option", { name: "mathos-model-299" }));
    await waitFor(() => {
      expect(modelSettingsPill()).toHaveAttribute("data-model", "@mathos/mathos-model-299");
    });
    // Back to OpenAI: OpenAI's model, never a MathOS id on an OpenAI thread.
    fireEvent.click(within(openDropdown("Provider")).getByRole("option", { name: "OpenAI" }));
    await waitFor(() => {
      expect(modelSettingsPill()).toHaveAttribute("data-model", "gpt-6-sol");
    });
    expect(composerDropdownOptionLabels(openDropdown("Model"))).toEqual(["GPT-6-Sol", "gpt-oss-120b"]);
    // Resolve the model and its supported settings together. MathOS has no
    // reasoning or speed settings; OpenAI restores its model's saved effort.
    expect(patches.at(-1)).toMatchObject({
      backend: "codex",
      model: "gpt-6-sol",
      reasoningEffort: "high",
      fastMode: undefined,
      serviceTier: undefined,
    });
    expect(modelSettingsPill()).toHaveAttribute("data-effort", "high");
  });

  it("offers a MathOS model's own effort levels, starting on its default, and sends the one chosen", async () => {
    // MathOS's `GET /models` named this model's levels; the others name none.
    const withEfforts = {
      ...codex,
      launchpadOptions: {
        ...codex.launchpadOptions,
        models: models.map((model) => model.id === "@mathos/mathos-model-7"
          ? {
              ...model,
              supportsReasoning: true,
              reasoningEfforts: ["low", "high", "max", "ultramath"],
              defaultReasoningEffort: "high",
            }
          : model),
      },
    } as BackendSummary;
    const patches = renderLaunchpad(withEfforts, { ...initialLaunchpad, model: "@mathos/mathos-model-7" });
    await waitFor(() => expect(modelSettingsPill()).toHaveAttribute("data-effort", "high"));
    expect(effortStops()).toEqual(["low", "high", "max", "ultramath"]);
    chooseEffort("ultramath");
    await waitFor(() => expect(patches.at(-1)).toMatchObject({ reasoningEffort: "ultramath" }));
    // A MathOS model whose endpoint names no levels has no effort bar.
    fireEvent.click(within(openDropdown("Model")).getByRole("option", { name: "mathos-model-8" }));
    await waitFor(() => {
      expect(effortStops()).toEqual([]);
    });
  });

  it("keeps an unset OpenAI choice on OpenAI when an endpoint marks its model current", () => {
    const withMathosDefault = {
      ...codex,
      launchpadOptions: {
        models: models.map((model) => model.id === "@mathos/mathos-model-0" ? { ...model, current: true } : model),
      },
    } as BackendSummary;
    render(
      <Composer
        backends={[withMathosDefault]}
        desktopApi={{ listBackends: vi.fn(async () => ({ fetchedAt: 1, backends: [withMathosDefault] })) }}
        directory={{ key: "directory:/repo", kind: "directory", label: "Repo", path: "/repo" }}
        launchpad={{ ...initialLaunchpad, model: undefined }}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />,
    );
    expect(modelSettingsPill()).toHaveAttribute("data-model", "gpt-6-sol");
    expect(modelSettingsPill()).toHaveTextContent("OpenAI");
  });

  it("restores endpoint defaults and access independently of OpenAI", async () => {
    const patches = renderLaunchpad({
      ...codex,
      modelProviderDefaults: {
        "codex-provider:mathos": {
          model: "@mathos/mathos-model-9", reasoningEffortsByModel: {}, executionMode: "auto",
        },
      },
    }, { ...initialLaunchpad, executionMode: "full-access" });
    fireEvent.click(within(openDropdown("Provider")).getByRole("option", { name: /MathOS/ }));
    await waitFor(() => expect(patches.at(-1)).toMatchObject({
      backend: "codex", codexModelProviderId: "mathos", model: "@mathos/mathos-model-9", executionMode: "auto",
    }));
    fireEvent.click(within(openDropdown("Provider")).getByRole("option", { name: "OpenAI" }));
    await waitFor(() => expect(patches.at(-1)).toMatchObject({ model: "gpt-6-sol", executionMode: "full-access" }));
  });

  it("keeps an endpoint selected after its model default is reset", () => {
    renderLaunchpad(codex, { ...initialLaunchpad, codexModelProviderId: "mathos", model: undefined });
    expect(modelSettingsPill()).toHaveTextContent("MathOS");
    expect(composerDropdownOptionLabels(openDropdown("Model"))).toEqual(["gpt-oss-120b", ...MATHOS_MODELS]);
  });

  it("keeps Refuseless's identical model id apart from MathOS's", async () => {
    const patches = renderLaunchpad();
    fireEvent.click(within(openUnavailableProviders())
      .getByRole("option", { name: /Refuseless/ }));
    await waitFor(() => {
      expect(patches.at(-1)).toMatchObject({ backend: "codex", model: "@refuseless/gpt-oss-120b" });
    });
    expect(composerDropdownOptionLabels(openDropdown("Model"))).toEqual(["gpt-oss-120b"]);
    expect(screen.getByText("Catalog unavailable: HTTP 503. Showing the models listed in Settings."))
      .toHaveClass("model-settings__footnote");
  });

  it("names an existing MathOS thread's provider MathOS, not OpenAI", async () => {
    render(
      <Composer
        backends={[codex]}
        desktopApi={{ onAgentEvent: () => () => undefined }}
        disabled={false}
        skills={[]}
        thread={{
          id: "mathos-thread",
          title: "Prove the lemma",
          titleSource: "explicit",
          source: "codex",
          model: "@mathos/gpt-oss-120b",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    // The panel names the thread's provider; the pill names its model alone.
    const panel = openModelSettings();
    expect(panel.querySelector(".model-settings__head-name")).toHaveTextContent("MathOS");
    expect(modelSettingsPill()).toHaveTextContent("gpt-oss-120b");
    expect(modelSettingsPill()).not.toHaveTextContent("MathOS");
  });
});
