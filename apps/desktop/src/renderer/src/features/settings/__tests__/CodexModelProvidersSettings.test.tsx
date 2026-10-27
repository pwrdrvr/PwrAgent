import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexModelProviderImportScan, DesktopCodexModelProvider } from "@pwragent/shared";
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
) {
  const onSave = vi.fn(async () => true);
  const onRefresh = vi.fn(async () => undefined);
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
      desktopApi={desktopApi}
      providers={providers}
      saving={false}
      onRefresh={onRefresh}
      onSave={onSave}
    />,
  );
  return { onSave, onRefresh, setCodexModelProviderApiKey, testCodexModelProvider, scanCodexModelProviderImports };
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
    fireEvent.change(screen.getByRole("textbox", { name: "Model ids" }), { target: { value: "glm-5.3-abliterated\n" } });
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
    expect(screen.getByRole("textbox", { name: "Model ids" })).toHaveValue("local-model");
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

  it("derives an id from a name", () => {
    expect(slugifyProviderId("Refuseless AI")).toBe("refuseless-ai");
    expect(slugifyProviderId("42 Bonsai!")).toBe("bonsai");
  });
});
