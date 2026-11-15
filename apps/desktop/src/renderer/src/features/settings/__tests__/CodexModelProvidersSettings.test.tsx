import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BackendModelOption,
  BackendSummary,
  CodexModelProviderCatalogState,
  CodexModelProviderImportScan,
  DesktopCodexModelProvider,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { CodexModelProvidersSettings, slugifyProviderId } from "../CodexModelProvidersSettings";

afterEach(cleanup);

const refuseless: DesktopCodexModelProvider = {
  id: "refuseless",
  name: "Refuseless",
  baseUrl: "https://api.refuseless.example/v1",
  models: ["glm-5.3-abliterated"],
  rates: [{ model: "glm-5.3-abliterated", inputPerMillion: 2, outputPerMillion: 3, cachedInputPerMillion: 0.35 }],
  hasApiKey: true,
};

function renderSettings(
  providers: DesktopCodexModelProvider[] = [],
  scan?: CodexModelProviderImportScan,
  backends?: BackendSummary[],
) {
  const onSave = vi.fn(async () => true);
  const onRefresh = vi.fn(async () => undefined);
  const onRefreshCatalogs = vi.fn(async () => undefined);
  const setCodexModelProviderApiKey = vi.fn(async ({ providerId }: { providerId: string }) => ({ providerId, hasApiKey: true }));
  const testCodexModelProvider = vi.fn(async () => ({
    models: { ok: true, count: 4 },
    responses: { ok: false, model: "glm-5.3-abliterated", error: "HTTP 404" },
    latencyMs: 120,
  }));
  const scanCodexModelProviderImports = vi.fn(async () => scan ?? { candidates: [], skipped: [] });
  const desktopApi = {
    setCodexModelProviderApiKey,
    testCodexModelProvider,
    ...(scan ? { scanCodexModelProviderImports } : {}),
  } as unknown as DesktopApi;
  render(
    <CodexModelProvidersSettings
      backends={backends}
      desktopApi={desktopApi}
      providers={providers}
      saving={false}
      onRefresh={onRefresh}
      onRefreshCatalogs={onRefreshCatalogs}
      onSave={onSave}
    />,
  );
  return {
    onSave,
    onRefresh,
    onRefreshCatalogs,
    setCodexModelProviderApiKey,
    testCodexModelProvider,
    scanCodexModelProviderImports,
  };
}

const mathos: DesktopCodexModelProvider = {
  id: "mathos",
  name: "MathOS",
  baseUrl: "https://mathos.example/v1",
  hasApiKey: true,
};

/** The owner's Codex summary after it read MathOS's `GET /models`. */
function codexSummary(
  models: BackendModelOption[],
  state: Partial<CodexModelProviderCatalogState> = {},
): BackendSummary {
  return {
    kind: "codex",
    launchpadOptions: { models },
    codexModelProviders: [{
      id: "mathos",
      name: "MathOS",
      status: "ready",
      listedCount: 0,
      discoveredCount: models.length,
      readAt: Date.now() - 3 * 60_000,
      ...state,
    }],
  } as unknown as BackendSummary;
}

function mathosModel(id: string, extra: Partial<BackendModelOption> = {}): BackendModelOption {
  return { id: `@mathos/${id}`, providerId: "mathos", providerLabel: "MathOS", supportsReasoning: false, ...extra };
}

const bonsaiSource = { label: "bonsai", configPath: "/home/me/.codex/profiles/bonsai/config.toml" };

const importScan: CodexModelProviderImportScan = {
  candidates: [
    {
      sourceId: "gpu",
      name: "Local Responses",
      baseUrl: "http://127.0.0.1:8080/v1",
      models: ["local-model"],
      local: true,
      needsApiKey: false,
      notes: [],
      sources: [bonsaiSource],
    },
    {
      sourceId: "refuseless",
      name: "Refuseless",
      baseUrl: "https://api.refuseless.example/v1",
      models: [],
      local: false,
      needsApiKey: true,
      apiKeyEnv: "REFUSELESS_API_KEY",
      notes: [],
      sources: [{ label: "Codex home", configPath: "/home/me/.codex/config.toml" }],
    },
  ],
  skipped: [{
    sourceId: "legacy",
    name: "Legacy chat",
    reason: "It uses wire_api = \"chat\". Codex 0.164 and later speak only the Responses API.",
    sources: [bonsaiSource],
  }],
};

describe("CodexModelProvidersSettings", () => {
  it("adds a provider with a key, models and rates, storing the key first", async () => {
    const calls: string[] = [];
    const { onSave, setCodexModelProviderApiKey } = renderSettings();
    onSave.mockImplementation(async () => {
      calls.push("config");
      return true;
    });
    setCodexModelProviderApiKey.mockImplementation(async ({ providerId }) => {
      calls.push("key");
      return { providerId, hasApiKey: true };
    });
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Provider name" }), { target: { value: "Refuseless" } });
    expect(screen.getByRole("textbox", { name: "Provider ID" })).toHaveValue("refuseless");
    fireEvent.change(screen.getByRole("textbox", { name: "Base URL" }), { target: { value: "https://api.refuseless.example/v1/" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-test" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Model id to add" }), { target: { value: "glm-5.3-abliterated" } });
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    fireEvent.change(screen.getByRole("textbox", { name: "glm-5.3-abliterated input rate" }), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("textbox", { name: "glm-5.3-abliterated output rate" }), { target: { value: "$3" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and reconnect" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(setCodexModelProviderApiKey).toHaveBeenCalledWith({ providerId: "refuseless", apiKey: "sk-test" });
    expect(onSave).toHaveBeenCalledWith([{
      id: "refuseless",
      name: "Refuseless",
      baseUrl: "https://api.refuseless.example/v1",
      models: ["glm-5.3-abliterated"],
      rates: [{ model: "glm-5.3-abliterated", inputPerMillion: 2, outputPerMillion: 3 }],
    }]);
    expect(calls).toEqual(["key", "config"]);
  });

  it("refuses a reserved id before writing anything", () => {
    const { onSave } = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Provider ID" }), { target: { value: "openai" } });
    expect(screen.getByText(/"openai" is reserved/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add and reconnect" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("edits a provider without changing its id and keeps its stored key", async () => {
    const { onSave, setCodexModelProviderApiKey } = renderSettings([refuseless]);
    const list = screen.getByRole("group", { name: "Codex model providers" });
    expect(within(list).getByText("Refuseless")).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Provider ID" })).toHaveAttribute("readonly");
    fireEvent.change(screen.getByRole("textbox", { name: "Provider name" }), { target: { value: "Refuseless AI" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and reconnect" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const { hasApiKey: _hasApiKey, ...saved } = refuseless;
    expect(onSave).toHaveBeenCalledWith([{ ...saved, name: "Refuseless AI" }]);
    expect(setCodexModelProviderApiKey).not.toHaveBeenCalled();
  });

  it("removes a provider and its key", async () => {
    const { onSave, setCodexModelProviderApiKey } = renderSettings([refuseless]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove provider" }));
    await waitFor(() => expect(setCodexModelProviderApiKey).toHaveBeenCalledWith({ providerId: "refuseless" }));
    expect(onSave).toHaveBeenCalledWith([]);
  });

  it("reports a Responses API failure from the connection test", async () => {
    const { testCodexModelProvider } = renderSettings([refuseless]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(testCodexModelProvider).toHaveBeenCalled());
    expect(await screen.findByText(/4 models · 120 ms/u)).toBeInTheDocument();
    expect(screen.getByText(/Codex needs Responses API compatibility/u)).toBeInTheDocument();
    expect(screen.getByText(/A passing check does not validate a full PwrAgent turn/u)).toBeInTheDocument();
  });

  it("offers the providers Codex config files define and imports one into the form", async () => {
    const { onSave, setCodexModelProviderApiKey } = renderSettings([], importScan);
    const imports = await screen.findByRole("group", { name: "Providers in Codex config files" });
    expect(within(imports).getByText("Local Responses")).toBeInTheDocument();
    expect(within(imports).getByText(/Legacy chat/u)).toBeInTheDocument();
    expect(within(imports).getByText(/wire_api = "chat"/u)).toBeInTheDocument();
    fireEvent.click(within(imports).getByRole("button", { name: "Import Local Responses" }));
    expect(screen.queryByRole("group", { name: "Providers in Codex config files" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Provider name" })).toHaveValue("Local Responses");
    expect(screen.getByRole("textbox", { name: "Provider ID" })).toHaveValue("gpu");
    expect(screen.getByRole("textbox", { name: "Base URL" })).toHaveValue("http://127.0.0.1:8080/v1");
    expect(within(screen.getByRole("table", { name: "Provider models" })).getByText("local-model")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Runs locally" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.getByText(/Imported from \/home\/me\/\.codex\/profiles\/bonsai\/config\.toml/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add and reconnect" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith([{
      id: "gpu",
      name: "Local Responses",
      baseUrl: "http://127.0.0.1:8080/v1",
      models: ["local-model"],
      local: true,
    }]);
    expect(setCodexModelProviderApiKey).not.toHaveBeenCalled();
  });

  it("explains an unsupported Bonsai import without offering an import action, even if it was already added", async () => {
    const baseUrl = "http://127.0.0.1:18080/v1";
    const { onSave } = renderSettings([{ id: "bonsai", name: "Bonsai", baseUrl, hasApiKey: false }], {
      candidates: [],
      skipped: [{
        sourceId: "bonsai",
        name: "PrismML Bonsai (local)",
        baseUrl,
        reason: "Import cannot preserve its Responses compatibility bridge, model catalog, context limits, feature restrictions, or custom launcher. Keep using its working PwrAgent profile.",
        sources: [bonsaiSource],
      }],
    });
    const skipped = await screen.findByRole("list", { name: "Not importable" });
    expect(within(skipped).getByText(/Responses compatibility bridge/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import PrismML Bonsai (local)" })).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("preserves Bonsai's isolated compatibility and catalog when importing and editing", async () => {
    const candidate = {
      ...importScan.candidates[0], sourceId: "bonsai", name: "Bonsai", models: ["Bonsai.gguf"],
      compatibility: "bonsai" as const, catalogPath: "/profiles/bonsai/models.json",
      notes: ["Uses an isolated Codex runtime and Responses bridge."],
    };
    const { onSave } = renderSettings([], { candidates: [candidate], skipped: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Import Bonsai" }));
    expect(screen.getByText(/isolated Codex runtime and Responses bridge/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add and reconnect" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([expect.objectContaining({
      compatibility: "bonsai", catalogPath: "/profiles/bonsai/models.json",
    })]));
  });

  it("asks for the key an imported provider needs and stores it in the keychain", async () => {
    const { onSave, setCodexModelProviderApiKey } = renderSettings([], importScan);
    fireEvent.click(await screen.findByRole("button", { name: "Import Refuseless" }));
    expect(screen.getByText(/Codex read it from \$REFUSELESS_API_KEY\. Keys are not copied from files/u))
      .toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Runs locally" })).toHaveAttribute("aria-checked", "false");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-pasted" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and reconnect" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(setCodexModelProviderApiKey).toHaveBeenCalledWith({ providerId: "refuseless", apiKey: "sk-pasted" });
  });

  it("hides an endpoint that is already a provider and picks a free id", async () => {
    const taken: DesktopCodexModelProvider = {
      id: "gpu",
      name: "Other GPU",
      baseUrl: "http://gpu.lan:8000/v1",
      hasApiKey: false,
    };
    renderSettings([refuseless, taken], importScan);
    const imports = await screen.findByRole("group", { name: "Providers in Codex config files" });
    expect(within(imports).queryByRole("button", { name: "Import Refuseless" })).not.toBeInTheDocument();
    fireEvent.click(within(imports).getByRole("button", { name: "Import Local Responses" }));
    expect(screen.getByRole("textbox", { name: "Provider ID" })).toHaveValue("gpu-2");
  });

  it("lists the models the endpoint returned, with their effort levels, and refreshes them", async () => {
    const { onRefreshCatalogs } = renderSettings([mathos], undefined, [codexSummary([
      mathosModel("deepseek-v4.1-flash", {
        label: "DeepSeek V4.1 Flash",
        supportsReasoning: true,
        reasoningEfforts: ["low", "high", "max", "ultramath"],
        defaultReasoningEffort: "high",
      }),
      mathosModel("mistral-large-4-0", { label: "Mistral Large 4.0" }),
    ])]);
    const list = screen.getByRole("group", { name: "Codex model providers" });
    // The closed row says what the last read found, not only typed ids.
    expect(within(list).getByText("2 models")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("2 models from GET /models · read 3m ago")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Provider models" });
    expect(within(table).getByText("DeepSeek V4.1 Flash")).toBeInTheDocument();
    expect(within(table).getByLabelText("Effort levels: low, high, max, ultramath; default high")).toBeInTheDocument();
    expect(within(table).getByText("None listed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(onRefreshCatalogs).toHaveBeenCalledTimes(1));
    expect(onRefreshCatalogs).toHaveBeenCalledWith("mathos");
    onRefreshCatalogs.mockRejectedValueOnce(new Error("The model list was read, but this window could not load it."));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/this window could not load it/u)).toBeInTheDocument();
  });

  it("keeps a 2,000-model catalog to 50 rows, finds a model by its words, and prices any of them", async () => {
    const models = Array.from({ length: 2_000 }, (_, index) => mathosModel(`vendor-${index % 40}/model-${index}`));
    models[1_234] = mathosModel("zai-org/glm-5.3", { label: "GLM 5.3" });
    const { onSave } = renderSettings([mathos], undefined, [codexSummary(models, { truncated: true })]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const table = screen.getByRole("table", { name: "Provider models" });
    expect(within(table).getAllByRole("row")).toHaveLength(51);
    expect(screen.getByText(/Showing 50 of 2,000\. Type to narrow the list\./u)).toBeInTheDocument();
    expect(screen.getByText("2,000 models from GET /models (more not loaded) · read 3m ago")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Find a model" }), { target: { value: "5.3 glm" } });
    const narrowed = screen.getByRole("table", { name: "Provider models" });
    expect(within(narrowed).getAllByRole("row")).toHaveLength(2);
    fireEvent.change(within(narrowed).getByRole("textbox", { name: "zai-org/glm-5.3 input rate" }), { target: { value: "0.6" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Find a model" }), { target: { value: "no such model" } });
    expect(screen.getByText("No models match “no such model”.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save and reconnect" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    // The model gets a rate without being added to the provider's own list.
    expect(onSave).toHaveBeenCalledWith([{
      id: "mathos",
      name: "MathOS",
      baseUrl: "https://mathos.example/v1",
      rates: [{ model: "zai-org/glm-5.3", inputPerMillion: 0.6 }],
    }]);
  });

  it("shows a new provider's models from its connection test", async () => {
    const { testCodexModelProvider } = renderSettings();
    testCodexModelProvider.mockResolvedValueOnce({
      models: { ok: true, count: 1, items: [{ id: "kimi-k3.1-pro", label: "Kimi K3.1 Pro", reasoningEfforts: ["low", "high"] }] },
      responses: { ok: true, model: "kimi-k3.1-pro" },
      latencyMs: 90,
    } as never);
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(screen.getByText("Test the connection to read the endpoint's models.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Provider name" }), { target: { value: "MathOS" } });
    // Typed with a trailing slash, which the test's request drops.
    fireEvent.change(screen.getByRole("textbox", { name: "Base URL" }), { target: { value: "https://mathos.example/v1/" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    const table = await screen.findByRole("table", { name: "Provider models" });
    expect(within(table).getByText("Kimi K3.1 Pro")).toBeInTheDocument();
    expect(within(table).getByLabelText("Effort levels: low, high")).toBeInTheDocument();
    expect(screen.getByText("1 model from GET /models · from this test")).toBeInTheDocument();
    // A different URL is not what the test read.
    fireEvent.change(screen.getByRole("textbox", { name: "Base URL" }), { target: { value: "https://other.example/v1" } });
    expect(screen.queryByRole("table", { name: "Provider models" })).not.toBeInTheDocument();
  });

  it("offers only the added models when the endpoint's list is off", () => {
    renderSettings([{ ...mathos, discoverModels: false, models: ["prover-large"] }], undefined, [codexSummary([
      mathosModel("prover-large"),
    ], { status: "off" })]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("Only the models added here are offered.")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Provider models" });
    expect(within(table).getByText("prover-large")).toBeInTheDocument();
    expect(within(table).getByText("Added")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
  });

  it("never keeps rows hidden behind a filter that is no longer shown", () => {
    const models = Array.from({ length: 12 }, (_, index) => mathosModel(`model-${index}`));
    renderSettings([{ ...mathos, models: ["prover-large"] }], undefined, [codexSummary(models)]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find a model" }), { target: { value: "model-3" } });
    expect(within(screen.getByRole("table", { name: "Provider models" })).getAllByRole("row")).toHaveLength(2);
    // The list goes off: one added model is left, and the filter field goes.
    fireEvent.click(screen.getByRole("switch", { name: "List the endpoint's models" }));
    expect(screen.queryByRole("textbox", { name: "Find a model" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Provider models" })).getByText("prover-large")).toBeInTheDocument();
  });

  it("does not show the saved URL's models for an edited, untested URL", () => {
    renderSettings([mathos], undefined, [codexSummary([mathosModel("kimi-k3.1-pro")])]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    // The same endpoint, spelled with a trailing slash, keeps its read.
    fireEvent.change(screen.getByRole("textbox", { name: "Base URL" }), { target: { value: "https://mathos.example/v1/" } });
    expect(screen.getByRole("table", { name: "Provider models" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Base URL" }), { target: { value: "https://other.example/v1" } });
    expect(screen.queryByRole("table", { name: "Provider models" })).not.toBeInTheDocument();
    expect(screen.getByText("Test the connection to read the endpoint's models.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
  });

  it("says a provider saved with its list off has not been read when the list is turned on", () => {
    renderSettings([{ ...mathos, discoverModels: false }], undefined, [codexSummary([], { status: "off" })]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("switch", { name: "List the endpoint's models" }));
    expect(screen.getByText("Save, or test the connection, to read the endpoint's models.")).toBeInTheDocument();
    expect(screen.queryByText(/0 models from GET \/models/u)).not.toBeInTheDocument();
  });

  it("drops the rate of an added model when it is removed", async () => {
    const { onSave } = renderSettings([refuseless]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove glm-5.3-abliterated" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and reconnect" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith([{ id: "refuseless", name: "Refuseless", baseUrl: "https://api.refuseless.example/v1" }]);
  });

  it("derives an id from a name", () => {
    expect(slugifyProviderId("Refuseless AI")).toBe("refuseless-ai");
    expect(slugifyProviderId("42 Bonsai!")).toBe("bonsai");
  });
});
