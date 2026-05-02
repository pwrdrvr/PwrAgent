import { describe, expect, it } from "vitest";
import type { BackendModelOption } from "@pwragnt/shared";
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
    const grokClient = {
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
      codex: createClient(),
      grok: grokClient,
    });

    const first = catalog.readModels("grok", "backend-summary");
    const second = catalog.readModels("grok", "thread-start-defaults");
    resolveModels?.([{ id: "grok-4", label: "Grok 4" }]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ id: "grok-4", label: "Grok 4" }],
      [{ id: "grok-4", label: "Grok 4" }],
    ]);
    expect(grokClient.callCount).toBe(1);
    expect(grokClient.diagnostics[0]).toMatchObject({
      callerReason: "backend-summary",
    });
    expect(grokClient.diagnostics[0]?.ownerId).toMatch(
      /^backend-model-catalog-/,
    );
  });

  it("caches successful empty model lists", async () => {
    const grokClient = createClient({ models: [] });
    const catalog = new BackendModelCatalog({
      codex: createClient(),
      grok: grokClient,
    });

    await expect(catalog.readModels("grok", "backend-summary")).resolves.toEqual([]);
    await expect(catalog.readModels("grok", "thread-start-defaults")).resolves.toEqual([]);

    expect(grokClient.callCount).toBe(1);
  });

  it("clears failed in-flight reads so later consumers can retry", async () => {
    const grokClient = createClient({
      errors: [new Error("Grok is still starting")],
      models: [{ id: "grok-4", label: "Grok 4" }],
    });
    const catalog = new BackendModelCatalog({
      codex: createClient(),
      grok: grokClient,
    });

    await expect(catalog.readModels("grok", "backend-summary")).rejects.toThrow(
      "Grok is still starting",
    );
    await expect(catalog.readModels("grok", "thread-start-defaults")).resolves.toEqual([
      { id: "grok-4", label: "Grok 4" },
    ]);

    expect(grokClient.callCount).toBe(2);
  });
});
