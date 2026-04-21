import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTemporaryTestDirectory } from "@pwragnt/agent-core";
import { FocusedDiffService } from "../diff-focus/focused-diff-service";
import { parseUnifiedDiff, summarizeHunksForFocus } from "../../shared/diff-focus";
import { defaultGrokAppServerConfigPath } from "../../../../../packages/agent-core/src/config/grok-app-server-config.js";
import { stringifyFlatToml } from "../../../../../packages/agent-core/src/config/simple-toml.js";

const ELIGIBLE_DIFF = [
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,7 +1,7 @@",
  " import { alpha } from './alpha';",
  "-import { beta } from './beta';",
  "+import { beta } from './beta/index';",
  " const keep = 1;",
  " const keep2 = 2;",
  " const keep3 = 3;",
  " const keep4 = 4;",
  "@@ -18,7 +18,7 @@",
  " function one() {",
  "   return keep;",
  "-  // old comment",
  "+  // refreshed comment",
  " }",
  " ",
  " export function two() {",
  "@@ -34,7 +34,7 @@",
  " export function three() {",
  "   return 'three';",
  "-  const label = 'before';",
  "+  const label = 'after';",
  "   return label;",
  " }",
  " ",
  " export function four() {",
  "@@ -50,7 +50,7 @@",
  " export function five() {",
  "   return 'five';",
  "-  // lint",
  "+  // linted",
  " }",
  " ",
  " export const six = 6;"
].join("\n");

function makeRequest(diff = ELIGIBLE_DIFF) {
  const parsed = parseUnifiedDiff(diff);
  return {
    filePath: "/repo/src/example.ts",
    diff,
    hunks: summarizeHunksForFocus(parsed)
  };
}

function makeStructuredResult(object: unknown, cachedTokens?: number) {
  return {
    object,
    cachedTokens
  };
}

function makeAiSdkXaiResponse(text: string, cachedTokens?: number): Record<string, unknown> {
  return {
    id: "resp_123",
    object: "response",
    created_at: 0,
    model: "grok-4.20-non-reasoning",
    status: "completed",
    output: [
      {
        id: "msg_1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text
          }
        ]
      }
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details:
        typeof cachedTokens === "number" ? { cached_tokens: cachedTokens } : undefined,
      output_tokens_details: {
        reasoning_tokens: 0
      }
    }
  };
}

describe("FocusedDiffService", () => {
  it("uses a test override response when configured", async () => {
    const originalOverride = process.env.PWRAGNT_FOCUSED_DIFF_TEST_RESPONSE;
    process.env.PWRAGNT_FOCUSED_DIFF_TEST_RESPONSE = JSON.stringify({
      hiddenHunkIndices: [1],
      reason: "test override"
    });

    try {
      const client = {
        generateObject: vi.fn(async () => makeStructuredResult({ decisions: [] }))
      };
      const service = new FocusedDiffService({ client });

      const response = await service.analyze(makeRequest());

      expect(response).toMatchObject({
        mode: "focused",
        source: "heuristic",
        hiddenHunkIndices: [1],
        hiddenHunkCount: 1,
        reason: "test override"
      });
      expect(client.generateObject).not.toHaveBeenCalled();
    } finally {
      if (originalOverride === undefined) {
        delete process.env.PWRAGNT_FOCUSED_DIFF_TEST_RESPONSE;
      } else {
        process.env.PWRAGNT_FOCUSED_DIFF_TEST_RESPONSE = originalOverride;
      }
    }
  });

  it("returns focused hide decisions for eligible diffs", async () => {
    const client = {
      generateObject: vi.fn(async () =>
        makeStructuredResult(
          {
            decisions: [
              {
                index: 1,
                disposition: "hide",
                reasonCode: "comment_only",
                reason: "Comment-only hunk.",
                confidence: 0.96
              },
              {
                index: 2,
                disposition: "show",
                reasonCode: "keep",
                reason: "Behavior changed.",
                confidence: 0.93
              }
            ]
          },
          128
        )
      )
    };
    const service = new FocusedDiffService({ client });

    const response = await service.analyze(makeRequest());

    expect(response).toMatchObject({
      mode: "focused",
      source: "grok",
      hiddenHunkIndices: [1],
      hiddenHunkCount: 1,
      cachedTokens: 128
    });
    expect(response.decisions[1]).toMatchObject({
      index: 1,
      disposition: "hide",
      reasonCode: "comment_only"
    });
  });

  it("reuses cached analysis for the same diff", async () => {
    const client = {
      generateObject: vi.fn(async () =>
        makeStructuredResult({
          decisions: [
            {
              index: 0,
              disposition: "hide",
              reasonCode: "import_reorder",
              reason: "Import-only change.",
              confidence: 0.92
            }
          ]
        })
      )
    };
    const service = new FocusedDiffService({ client });

    const first = await service.analyze(makeRequest());
    const second = await service.analyze(makeRequest());

    expect(first.source).toBe("grok");
    expect(second.source).toBe("cache");
    expect(client.generateObject).toHaveBeenCalledTimes(1);
  });

  it("falls back when Grok returns invalid JSON", async () => {
    const client = {
      generateObject: vi.fn(async () => {
        throw new Error("invalid structured diff response: Unexpected token");
      })
    };
    const service = new FocusedDiffService({ client });

    const response = await service.analyze(makeRequest());

    expect(response).toMatchObject({
      mode: "fallback",
      source: "heuristic",
      hiddenHunkIndices: [],
      hiddenHunkCount: 0
    });
    expect(response.reason).toContain("invalid structured diff response");
  });

  it("does not cache fallback responses from transient failures", async () => {
    const client = {
      generateObject: vi
        .fn()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce(
          makeStructuredResult({
            decisions: [
              {
                index: 1,
                disposition: "hide",
                reasonCode: "comment_only",
                reason: "Comment-only hunk.",
                confidence: 0.96
              }
            ]
          })
        )
    };
    const service = new FocusedDiffService({ client });

    const first = await service.analyze(makeRequest());
    const second = await service.analyze(makeRequest());

    expect(first).toMatchObject({
      mode: "fallback",
      source: "heuristic",
      hiddenHunkIndices: []
    });
    expect(second).toMatchObject({
      mode: "focused",
      source: "grok",
      hiddenHunkIndices: [1]
    });
    expect(client.generateObject).toHaveBeenCalledTimes(2);
  });

  it("returns a full ineligible response for small diffs", async () => {
    const client = {
      generateObject: vi.fn(async () => makeStructuredResult({ decisions: [] }))
    };
    const service = new FocusedDiffService({ client });
    const request = makeRequest(
      [
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1,3 +1,3 @@",
        " const alpha = 1;",
        "-const beta = 2;",
        "+const beta = 3;",
        " export { alpha, beta };"
      ].join("\n")
    );

    const response = await service.analyze(request);

    expect(response).toMatchObject({
      mode: "full",
      source: "ineligible",
      hiddenHunkIndices: [],
      hiddenHunkCount: 0,
      reason: "too_few_hunks"
    });
    expect(client.generateObject).not.toHaveBeenCalled();
  });

  it("reads xAI credentials from runtime config.toml and uses the focused-diff model", async () => {
    const temp = await createTemporaryTestDirectory();
    const originalHome = process.env.HOME;
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const originalXaiApiKey = process.env.XAI_API_KEY;
    const originalXaiBaseUrl = process.env.XAI_BASE_URL;
    const originalGrokModel = process.env.GROK_MODEL;
    const fetchSpy = vi.fn(async (_input, init) =>
      new Response(
        JSON.stringify(
          makeAiSdkXaiResponse(
            JSON.stringify({
              decisions: [
                {
                  index: 1,
                  disposition: "hide",
                  reasonCode: "comment_only",
                  reason: "Comment-only hunk.",
                  confidence: 0.96
                }
              ]
            }),
            64
          )
        ),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );
    const originalFetch = globalThis.fetch;

    try {
      process.env.HOME = temp.path;
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.XAI_API_KEY;
      delete process.env.XAI_BASE_URL;
      delete process.env.GROK_MODEL;

      const configPath = defaultGrokAppServerConfigPath({ homeDir: temp.path });
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        stringifyFlatToml({
          xai_api_key: "config-key",
          xai_base_url: "https://api.example.test/v1",
          grok_model: "grok-4.20-non-reasoning"
        })
      );

      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const service = new FocusedDiffService();
      const response = await service.analyze(makeRequest());

      expect(response).toMatchObject({
        mode: "focused",
        source: "grok",
        hiddenHunkIndices: [1],
        cachedTokens: 64
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.example.test/v1/responses",
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: "Bearer config-key",
            "x-grok-conv-id": "focused-diff-v1"
          }),
          body: expect.stringContaining('"model":"grok-4-1-fast-reasoning"')
        })
      );
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"prompt_cache_key":"focused-diff-v1"')
        })
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
      }
      if (originalXaiApiKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = originalXaiApiKey;
      }
      if (originalXaiBaseUrl === undefined) {
        delete process.env.XAI_BASE_URL;
      } else {
        process.env.XAI_BASE_URL = originalXaiBaseUrl;
      }
      if (originalGrokModel === undefined) {
        delete process.env.GROK_MODEL;
      } else {
        process.env.GROK_MODEL = originalGrokModel;
      }
      await temp.cleanup();
    }
  });
});
