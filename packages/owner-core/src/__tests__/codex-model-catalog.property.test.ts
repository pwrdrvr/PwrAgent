import fc from "fast-check";
import { buildModelMenu } from "@pwragent/shared/model-menu";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../codex-app-server/client";
import type { CodexClientHost, CodexClientTransport } from "../codex-app-server/host";

function model(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, displayName: id, hidden: false, isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    defaultReasoningEffort: "medium", inputModalities: ["text", "image"],
    additionalSpeedTiers: [], serviceTiers: [],
    ...overrides,
  };
}

function fixture(version = "0.169.0") {
  let response: unknown = { data: [], nextCursor: null };
  let receive: (message: string) => void = () => undefined;
  const transport: CodexClientTransport = {
    connect: async () => undefined,
    close: async () => undefined,
    setCloseHandler: () => undefined,
    setMessageHandler: (handler) => { receive = handler; },
    send: (message) => {
      const request = JSON.parse(message);
      if (request.id === undefined) return;
      expect(["initialize", "model/list"]).toContain(request.method);
      const result = request.method === "model/list" ? response : {
        userAgent: `codex/${version}`, codexHome: "/fixture/codex-home",
        platformFamily: "unix", platformOs: "macos",
      };
      receive(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    },
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const host: CodexClientHost = {
    createTransport: () => transport,
    clientInfo: { name: "fixture", title: "Fixture" },
    logger, rpcLogger: logger,
    listingDiagnostics: { trace: async (_stage, _fields, operation) => await operation(), link: () => undefined },
    authState: { isBlocked: () => false, assertAvailable: () => undefined },
    signInRequiredMessage: "Sign in",
    buildShellEnvironment: (env) => env,
    enrichThreadDirectory: async () => ({ linkedDirectories: [] }),
    sampleAppServerProcessTree: async () => ({}),
  };
  return {
    client: new CodexAppServerClient({}, host), logger,
    respond: (value: unknown) => { response = value; },
  };
}

describe("Codex model catalog compatibility", () => {
  const familyCatalog = [
    "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna",
    "gpt-6.2-sol", "gpt-6.2-astra", "gpt-6-sol", "gpt-5.6-luna", "future-model",
  ];
  const familyMenu = {
    primary: [
      "gpt-6.2-astra", "gpt-6-astra", "gpt-6.2-sol", "gpt-6.1-sol",
      "gpt-6.1-terra", "gpt-6-luna", "future-model",
    ],
    other: ["gpt-6-sol", "gpt-5.6-luna"],
  };

  async function readFamilyMenu(ids: string[], version?: string) {
    const { client, respond } = fixture(version);
    respond({ data: ids.map((id) => model(id)), nextCursor: null });
    try {
      const menu = buildModelMenu({ kind: "codex", models: await client.listModels() });
      return {
        primary: menu.primary.map((entry) => entry.id),
        other: menu.other.map((entry) => entry.id),
      };
    } finally {
      await client.close();
    }
  }

  it("places GPT-6.2 beside its Astra and Sol siblings while keeping 6.1 primary", async () => {
    expect(await readFamilyMenu(familyCatalog)).toEqual(familyMenu);
  });

  it.each(["0.143.0", "0.169.0"])("keeps family order regardless of catalog order on Codex %s", async (version) => {
    // Rule: newest Astra and Sol variants precede their siblings, independent
    // of provider ordering. Keep 6.1 primary during the 6.2 evaluation period.
    await fc.assert(fc.asyncProperty(
      fc.shuffledSubarray(familyCatalog, { minLength: familyCatalog.length, maxLength: familyCatalog.length }),
      async (ids) => {
        expect(await readFamilyMenu(ids, version)).toEqual(familyMenu);
      },
    ));
  });

  it.each(["0.143.0", "0.169.0"])("shows Daybreak Blue Latest when listed by Codex %s", async (version) => {
    const { client, respond } = fixture(version);
    const id = "gpt-daybreak-blue-latest";
    respond({ data: [model(id)], nextCursor: null });
    try {
      const menu = buildModelMenu({ kind: "codex", models: await client.listModels() });
      expect(menu.primary).toContainEqual(expect.objectContaining({
        id,
        label: "Daybreak Blue Latest",
      }));
    } finally {
      await client.close();
    }
  });

  it("keeps GPT-6.2 Sol with audio beside GPT-6.2 Astra and warns about audio", async () => {
    const { client, respond, logger } = fixture();
    respond({ data: [
      model("gpt-6.2-sol", { inputModalities: ["text", "image", "audio"] }),
      model("gpt-6.2-astra"),
    ], nextCursor: null });
    try {
      const models = await client.listModels();
      expect(models.map((entry) => entry.id).sort()).toEqual(["gpt-6.2-astra", "gpt-6.2-sol"]);
      expect(models.every((entry) => entry.supportsImage)).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith("model/list ignored unsupported input modalities", {
        modelId: "gpt-6.2-sol", inputModalities: ["audio"],
      });
    } finally {
      await client.close();
    }
  });

  it("preserves known capabilities when any or all models gain modality names or unrelated settings", async () => {
    // Rule: additive discovery metadata cannot remove a model or change a
    // capability PwrAgent already understands. Oracle: the original catalog.
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ image: fc.boolean(), modalities: fc.array(fc.string(), { minLength: 1, maxLength: 4 }), setting: fc.jsonValue() }), { minLength: 1, maxLength: 5 }),
      async (additions) => {
        const { client, respond } = fixture();
        const original = additions.map(({ image }, i) => model(`fixture-${i}`, {
          inputModalities: image ? ["text", "image"] : ["text"],
        }));
        try {
          respond({ data: original, nextCursor: null });
          const expected = await client.listModels();
          respond({ data: original.map((entry, i) => ({
            ...entry,
            inputModalities: [...entry.inputModalities as string[], ...additions[i]!.modalities.map((name) => `future-${name}`)],
            futureSetting: additions[i]!.setting,
          })), nextCursor: null });
          expect(await client.listModels()).toEqual(expected);
        } finally {
          await client.close();
        }
      },
    ));
  });

  it("isolates malformed entries without changing the valid visible catalog", async () => {
    // Rule: corrupting one consumed field only removes that entry. Oracle:
    // the valid visible entries supplied by the server, before interleaving.
    const field = fc.constantFrom(
      "id", "displayName", "hidden", "isDefault", "supportedReasoningEfforts",
      "defaultReasoningEffort", "inputModalities", "additionalSpeedTiers", "serviceTiers",
    );
    await fc.assert(fc.asyncProperty(fc.array(field, { minLength: 1, maxLength: 9 }), async (fields) => {
      const { client, respond, logger } = fixture();
      const valid = [model("visible-a"), model("visible-b"), model("hidden", { hidden: true })];
      try {
        respond({ data: valid, nextCursor: null });
        const expected = await client.listModels();
        const invalid = fields.map((key, i) => model(`broken-${i}`, { [key]: null }));
        respond({ data: [invalid[0], valid[0], ...invalid.slice(1), ...valid.slice(1), null, 42], nextCursor: null });
        expect(await client.listModels()).toEqual(expected);
        expect(logger.warn).toHaveBeenCalledWith("model/list skipped malformed model", expect.objectContaining({ index: 0 }));
      } finally {
        await client.close();
      }
    }));
  });

  it("skips one malformed model beside a valid model", async () => {
    const { client, respond, logger } = fixture();
    respond({ data: [model("broken", { serviceTiers: [null] }), model("valid")], nextCursor: null });
    try {
      expect((await client.listModels()).map((entry) => entry.id)).toEqual(["valid"]);
      expect(logger.warn).toHaveBeenCalledWith("model/list skipped malformed model", { index: 0, modelId: "broken" });
    } finally {
      await client.close();
    }
  });

  it.each([
    null, [], {}, { data: null, nextCursor: null },
    { data: [], nextCursor: 42 }, { data: [model("valid")] },
    { data: [model("broken", { inputModalities: ["text", 42] })], nextCursor: null },
  ])("still rejects unusable responses: %j", async (response) => {
    const { client, respond } = fixture();
    respond(response);
    try {
      await expect(client.listModels()).rejects.toThrow("model/list response");
    } finally {
      await client.close();
    }
  });

  it("accepts an authoritative empty catalog", async () => {
    const { client, respond, logger } = fixture();
    respond({ data: [], nextCursor: null });
    try {
      expect(await client.listModels()).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
