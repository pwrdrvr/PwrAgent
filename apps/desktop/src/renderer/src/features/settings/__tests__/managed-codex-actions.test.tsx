import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary, DesktopSettingsSnapshot, ListBackendsRequest } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useBackendSummaries, BACKEND_SUMMARIES_REFRESH_EVENT } from "../../../lib/useBackendSummaries";
import { checkForManagedCodexUpdates, refreshManagedCodexModelCatalog } from "../managed-codex-actions";

afterEach(cleanup);

describe("managed Codex model refresh", () => {
  it("rediscovers models and updates an already mounted picker consumer after installing a build", async () => {
    let installed = false;
    let models = ["gpt-6-sol"];
    const requests: Array<ListBackendsRequest | undefined> = [];
    const api = {
      refreshCodexDiscovery: vi.fn(async () => {
        installed = true;
        return { snapshot: {} as DesktopSettingsSnapshot };
      }),
      listBackends: vi.fn(async (request?: ListBackendsRequest) => {
        requests.push(request);
        if (request?.refreshModels === "codex") {
          expect(installed).toBe(true);
          models = ["gpt-6.1-sol", "gpt-6-sol"];
        }
        return { fetchedAt: Date.now(), backends: [{ kind: "codex", launchpadOptions: { models: models.map((id) => ({ id })) } }] as BackendSummary[] };
      }),
    };
    function PickerModels() {
      const { backends } = useBackendSummaries(api as unknown as DesktopApi);
      return <p>{backends[0]?.launchpadOptions?.models?.map((model) => model.id).join(", ")}</p>;
    }
    render(<PickerModels />);
    await screen.findByText("gpt-6-sol");
    expect(api.refreshCodexDiscovery).not.toHaveBeenCalled();
    await act(async () => { await checkForManagedCodexUpdates(api); });
    expect(await screen.findByText("gpt-6.1-sol, gpt-6-sol")).toBeInTheDocument();
    expect(requests).toEqual([
      { includeUnavailable: true },
      { includeUnavailable: true, refreshModels: "codex", discoveryIntent: "settings-user-action" },
      { includeUnavailable: true },
    ]);
  });

  it("does not report a successful catalog refresh when discovery fails", async () => {
    const onRefresh = vi.fn();
    window.addEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, onRefresh);
    try {
      await expect(refreshManagedCodexModelCatalog({ listBackends: async () => { throw new Error("Model discovery failed"); } }))
        .rejects.toThrow("Model discovery failed");
      expect(onRefresh).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, onRefresh);
    }
  });
});
