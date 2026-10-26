import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopCodexModelProvider } from "@pwragent/shared";
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

function renderSettings(providers: DesktopCodexModelProvider[] = []) {
  const onSave = vi.fn(async () => true);
  const onRefresh = vi.fn(async () => undefined);
  const setCodexModelProviderApiKey = vi.fn(async ({ providerId }: { providerId: string }) => ({ providerId, hasApiKey: true }));
  const testCodexModelProvider = vi.fn(async () => ({
    models: { ok: true, count: 4 },
    responses: { ok: false, model: "glm-5.3-abliterated", error: "HTTP 404" },
    latencyMs: 120,
  }));
  const desktopApi = { setCodexModelProviderApiKey, testCodexModelProvider } as unknown as DesktopApi;
  render(
    <CodexModelProvidersSettings
      desktopApi={desktopApi}
      providers={providers}
      saving={false}
      onRefresh={onRefresh}
      onSave={onSave}
    />,
  );
  return { onSave, onRefresh, setCodexModelProviderApiKey, testCodexModelProvider };
}

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
    expect(screen.getByText(/Codex needs the Responses API/u)).toBeInTheDocument();
  });

  it("derives an id from a name", () => {
    expect(slugifyProviderId("Refuseless AI")).toBe("refuseless-ai");
    expect(slugifyProviderId("42 Bonsai!")).toBe("bonsai");
  });
});
