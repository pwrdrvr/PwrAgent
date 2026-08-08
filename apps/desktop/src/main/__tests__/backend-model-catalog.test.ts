import { describe, expect, it } from "vitest";
import type { BackendModelOption } from "@pwragent/shared";
import { BackendModelCatalog } from "../app-server/backend-model-catalog";

function createClient(params?: {
  models?: BackendModelOption[];
  errors?: Error[];
}) {
  const diagnostics: Array<{ callerReason?: string; ownerId?: string } | undefined> = [];
  let callCount = 0;

  return {
    get callCount() {
      return callCount;
    },
    diagnostics,
    async listModels(requestDiagnostics?: {
      callerReason?: string;
      ownerId?: string;
    }): Promise<BackendModelOption[]> {
      callCount += 1;
      diagnostics.push(requestDiagnostics);
      const error = params?.errors?.shift();
      if (error) {
        throw error;
      }
      return params?.models ?? [];
    },
  };
}

describe("BackendModelCatalog", () => {
  it("coalesces concurrent model reads for one backend", async () => {
    let resolveModels:
      | ((models: BackendModelOption[]) => void)
      | undefined;
    const diagnostics: Array<{ callerReason?: string; ownerId?: string } | undefined> = [];
    let callCount = 0;
    const codexClient = {
      get callCount() {
        return callCount;
      },
      diagnostics,
      async listModels(requestDiagnostics?: {
        callerReason?: string;
        ownerId?: string;
      }): Promise<BackendModelOption[]> {
        callCount += 1;
        diagnostics.push(requestDiagnostics);
        return await new Promise<BackendModelOption[]>((resolve) => {
          resolveModels = resolve;
        });
      },
    };
    const catalog = new BackendModelCatalog({
      codex: codexClient,
    });

    const first = catalog.readModels("codex", "backend-summary");
    const second = catalog.readModels("codex", "thread-start-defaults");
    resolveModels?.([{ id: "gpt-5.4", label: "GPT-5.4" }]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ id: "gpt-5.4", label: "GPT-5.4" }],
      [{ id: "gpt-5.4", label: "GPT-5.4" }],
    ]);
    expect(codexClient.callCount).toBe(1);
    expect(codexClient.diagnostics[0]).toMatchObject({
      callerReason: "backend-summary",
    });
    expect(codexClient.diagnostics[0]?.ownerId).toMatch(
      /^backend-model-catalog-/,
    );
  });

  it("caches successful empty model lists", async () => {
    const codexClient = createClient({ models: [] });
    const catalog = new BackendModelCatalog({
      codex: codexClient,
    });

    await expect(catalog.readModels("codex", "backend-summary")).resolves.toEqual([]);
    await expect(catalog.readModels("codex", "thread-start-defaults")).resolves.toEqual([]);

    expect(codexClient.callCount).toBe(1);
  });

  it("clears failed in-flight reads so later consumers can retry", async () => {
    const codexClient = createClient({
      errors: [new Error("Codex is still starting")],
      models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
    });
    const catalog = new BackendModelCatalog({
      codex: codexClient,
    });

    await expect(catalog.readModels("codex", "backend-summary")).rejects.toThrow(
      "Codex is still starting",
    );
    await expect(catalog.readModels("codex", "thread-start-defaults")).resolves.toEqual([
      { id: "gpt-5.4", label: "GPT-5.4" },
    ]);

    expect(codexClient.callCount).toBe(2);
  });
});
