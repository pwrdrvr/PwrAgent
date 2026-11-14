import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo, useState, type ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyNavigationLaunchpadProviderSettingsPatch,
  type BackendModelOption,
  type BackendSummary,
  type NavigationLaunchpadDraft,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { composerDropdownOptionLabels } from "../../../test/model-catalog";
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

function openDropdown(label: string): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}(?::|$)`) }));
  return screen.getByRole("listbox", { name: label });
}

function renderLaunchpad() {
  const patches: Array<Partial<NavigationLaunchpadDraft>> = [];
  function Harness() {
    const [launchpad, setLaunchpad] = useState(initialLaunchpad);
    return (
      <Composer
        backends={[codex]}
        desktopApi={{ listBackends: vi.fn(async () => ({ fetchedAt: 1, backends: [codex] })) }}
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
    expect(composerDropdownOptionLabels(list)).toEqual(["OpenAI", "MathOS", "Refuseless", "Acme Lab"]);
    expect(within(list).getByRole("option", { name: /MathOS/ })).toHaveTextContent("Runs on Codex · 301 models");
    expect(within(list).getByRole("option", { name: /Refuseless/ }))
      .toHaveTextContent("Runs on Codex · 1 model · catalog unavailable");
    const acme = within(list).getByRole("option", { name: /Acme Lab/ });
    expect(acme).toHaveTextContent("No models. Catalog unavailable: HTTP 401");
    expect(acme).toHaveAttribute("aria-disabled", "true");
  });

  it("starts a MathOS thread on Codex with a MathOS model, and offers MathOS's whole catalog alone", async () => {
    const patches = renderLaunchpad();
    expect(screen.getByRole("button", { name: /^Model(?::|$)/ })).toHaveAttribute("data-value", "gpt-6-sol");
    fireEvent.click(within(openDropdown("Provider")).getByRole("option", { name: /MathOS/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Provider(?::|$)/ })).toHaveTextContent("MathOS");
    });
    expect(patches.at(-1)).toMatchObject({ backend: "codex", model: "@mathos/gpt-oss-120b" });
    const modelList = openDropdown("Model");
    // The same upstream id, served by MathOS, and every model MathOS lists.
    expect(composerDropdownOptionLabels(modelList)).toEqual(["gpt-oss-120b", ...MATHOS_MODELS]);
    fireEvent.click(within(modelList).getByRole("option", { name: "mathos-model-299" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Model(?::|$)/ })).toHaveAttribute("data-value", "@mathos/mathos-model-299");
    });
    // Back to OpenAI: OpenAI's model, never a MathOS id on an OpenAI thread.
    fireEvent.click(within(openDropdown("Provider")).getByRole("option", { name: "OpenAI" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Model(?::|$)/ })).toHaveAttribute("data-value", "gpt-6-sol");
    });
    expect(composerDropdownOptionLabels(openDropdown("Model"))).toEqual(["GPT-6-Sol", "gpt-oss-120b"]);
    // A local switch sets the model only; the remembered effort, Fast mode and
    // tier restore through the provider-settings patch as for any provider.
    expect(Object.keys(patches.at(-1)!)).not.toEqual(expect.arrayContaining(["serviceTier"]));
    expect(Object.keys(patches.at(-1)!)).not.toEqual(expect.arrayContaining(["reasoningEffort"]));
  });

  it("names the provider of the default model when the launchpad has chosen none", () => {
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
    expect(screen.getByRole("button", { name: /^Model(?::|$)/ })).toHaveAttribute("data-value", "@mathos/mathos-model-0");
    expect(screen.getByRole("button", { name: /^Provider(?::|$)/ })).toHaveTextContent("MathOS");
  });

  it("keeps Refuseless's identical model id apart from MathOS's", async () => {
    const patches = renderLaunchpad();
    fireEvent.click(within(openDropdown("Provider")).getByRole("option", { name: /Refuseless/ }));
    await waitFor(() => {
      expect(patches.at(-1)).toMatchObject({ backend: "codex", model: "@refuseless/gpt-oss-120b" });
    });
    expect(composerDropdownOptionLabels(openDropdown("Model"))).toEqual(["gpt-oss-120b"]);
    expect(screen.getByText("Catalog unavailable: HTTP 503. Showing the models listed in Settings."))
      .toHaveClass("composer-dropdown__footnote");
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
    expect(screen.getByLabelText("Provider")).toHaveTextContent("MathOS");
    expect(screen.getByRole("button", { name: /^Model(?::|$)/ })).toHaveTextContent("gpt-oss-120b");
    expect(screen.getByRole("button", { name: /^Model(?::|$)/ })).not.toHaveTextContent("MathOS ·");
  });
});
