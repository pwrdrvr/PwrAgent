import { describe, expect, it, vi } from "vitest";
import type { AppServerBackendKind } from "@pwragent/shared";
import {
  ThreadTitleGenerationService,
  type ThreadTitleGenerator,
} from "../app-server/thread-title-generation-service";

function makeGenerator(object: unknown): ThreadTitleGenerator {
  return {
    generateTitle: vi.fn(async () => ({
      status: "ok",
      object,
      cachedTokens: 12,
    } as const)),
  };
}

describe("ThreadTitleGenerationService", () => {
  it("accepts a valid generated title", async () => {
    const generator = makeGenerator({ title: "PROJECT-123 checkout crash" });
    const service = new ThreadTitleGenerationService({
      generators: { codex: generator },
    });

    await expect(
      service.generateTitle({
        backend: "codex",
        userPrompt: "PROJECT-123 investigate checkout crash",
      })
    ).resolves.toEqual({
      status: "generated",
      title: "PROJECT-123 checkout crash",
      cachedTokens: 12,
    });
    const schema = vi.mocked(generator.generateTitle).mock.calls[0]?.[0]
      .schema as {
        properties?: { title?: Record<string, unknown> };
      };
    expect(schema.properties?.title).not.toHaveProperty("maxLength");
  });

  it("allows 20 seconds for title generators by default", async () => {
    const generateTitle = vi.fn(async () => ({
      status: "ok",
      object: { title: "Thread naming" },
    } as const));
    const service = new ThreadTitleGenerationService({
      generators: { codex: { generateTitle } },
    });

    await service.generateTitle({
      backend: "codex",
      userPrompt: "Name this thread",
    });

    expect(generateTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 20_000,
      })
    );
  });

  it("uses a backend-specific resolver without falling back to Codex", async () => {
    const acpGenerator = makeGenerator({ title: "Favorite cereal" });
    const codexGenerator = makeGenerator({ title: "Wrong backend" });
    const generatorResolver = vi.fn((backend: AppServerBackendKind) =>
      backend === "acp:kimi" ? acpGenerator : undefined,
    );
    const service = new ThreadTitleGenerationService({
      generators: { codex: codexGenerator },
      generatorResolver,
    });

    await expect(
      service.generateTitle({
        backend: "acp:kimi",
        threadId: "kimi-session-1",
        userPrompt:
          "We're testing something here... just tell me your favorite cereal.",
      })
    ).resolves.toEqual({
      status: "generated",
      title: "Favorite cereal",
      cachedTokens: 12,
    });
    expect(generatorResolver).toHaveBeenCalledWith("acp:kimi");
    expect(acpGenerator.generateTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "acp:kimi",
        threadId: "kimi-session-1",
      }),
    );
    expect(codexGenerator.generateTitle).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "accepts recognized issue and PR references in generated titles",
      generatedTitle: "PR 456 issue 123 followup",
      userPrompt: "In issue 123 and PR 456, why does rename fail?",
    },
    {
      name: "allows bare numbers to be omitted from generated titles",
      generatedTitle: "Rename behavior",
      userPrompt: "Can we inspect 456 for rename behavior?",
    },
    {
      name: "does not treat arbitrary prompt numbers as ticket references",
      generatedTitle: "Thread rename rejection",
      userPrompt:
        "At 19:36:47.622 thread title generation rejected a rename for thread 019dd673-a098-7021-a344-a09e4d8ec850.",
    },
    {
      name: "accepts titles that drop ticket references from the prompt",
      generatedTitle: "Checkout crash followup",
      userPrompt: "PROJECT-123 investigate checkout crash",
    },
    {
      name: "accepts titles that preserve only one of multiple references",
      generatedTitle: "Issue 123 rename followup",
      userPrompt: "In issue 123 and PR 456, why does rename fail?",
    },
    {
      name: "accepts generated titles that omit GitHub PR references from quoted context",
      generatedTitle: "PR attachment API mismatch",
      userPrompt:
        "> PRs created: > - #12998: https://github.com/ExampleOrg/catalog-service/pull/12998 > - #12999 stacked on it: https://github.com/ExampleOrg/catalog-service/pull/12999 Why could the agent not attach the PR to the thread?",
    },
    {
      name: "accepts first-turn handoff titles with non-ticket task markers",
      generatedTitle: "Dynamic subagent monitoring",
      userPrompt:
        "**Handoff Message: Dynamic Subagent Monitoring for Long-Running Tasks**\n\nTask #1: monitor the spawned agents.\nTask #2: report long-running tool calls.",
    },
  ])("$name", async ({ generatedTitle, userPrompt }) => {
    const service = new ThreadTitleGenerationService({
      generators: {
        codex: makeGenerator({ title: generatedTitle }),
      },
    });

    await expect(
      service.generateTitle({
        backend: "codex",
        userPrompt,
      })
    ).resolves.toMatchObject({
      status: "generated",
      title: generatedTitle,
    });
  });

  it("cleans wrapper quotes and trailing punctuation", async () => {
    const service = new ThreadTitleGenerationService({
      generators: {
        codex: makeGenerator({ title: '"Rename thread #123."' }),
      },
    });

    await expect(
      service.generateTitle({
        backend: "codex",
        userPrompt: "Can we inspect #123 rename behavior?",
      })
    ).resolves.toMatchObject({
      status: "generated",
      title: "Rename thread #123",
    });
  });

  it("allows 30 percent title slack and truncates beyond it", async () => {
    const longTitleService = new ThreadTitleGenerationService({
      generators: {
        codex: makeGenerator({
          title: "x".repeat(66),
        }),
      },
    });
    const wordyTitleService = new ThreadTitleGenerationService({
      generators: {
        codex: makeGenerator({
          title: "Paul Revere opening by the Beastie Boys",
        }),
      },
    });

    await expect(
      longTitleService.generateTitle({
        backend: "codex",
        userPrompt: "Name this thread",
      })
    ).resolves.toEqual({
      status: "generated",
      title: "x".repeat(65),
      cachedTokens: 12,
    });
    await expect(
      wordyTitleService.generateTitle({
        backend: "codex",
        userPrompt: "Name this thread",
      })
    ).resolves.toEqual({
      status: "generated",
      title: "Paul Revere opening by the Beastie Boys",
      cachedTokens: 12,
    });

    const eightWordService = new ThreadTitleGenerationService({
      generators: {
        codex: makeGenerator({
          title: "One two three four five six seven eight",
        }),
      },
    });
    await expect(
      eightWordService.generateTitle({
        backend: "codex",
        userPrompt: "Name this thread",
      })
    ).resolves.toEqual({
      status: "generated",
      title: "One two three four five six seven",
      cachedTokens: 12,
    });
  });

  it("preserves helper metadata when a generated title is invalid", async () => {
    const tokenUsage = {
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 8,
      totalTokens: 128,
    };
    const service = new ThreadTitleGenerationService({
      generators: {
        codex: {
          generateTitle: vi.fn(async () => ({
            status: "ok" as const,
            object: { title: 123 },
            helperThreadId: "title-helper-thread",
            helperTurnId: "title-helper-turn",
            model: "gpt-5.4-mini",
            reasoningEffort: "low",
            serviceTier: "priority",
            tokenUsage,
          })),
        },
      },
    });

    await expect(
      service.generateTitle({
        backend: "codex",
        userPrompt: "Name this thread",
      })
    ).resolves.toEqual({
      status: "invalid",
      reason: "title_must_be_string",
      helperThreadId: "title-helper-thread",
      helperTurnId: "title-helper-turn",
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
      serviceTier: "priority",
      tokenUsage,
    });
  });

  it("rejects malformed title objects", async () => {
    const service = new ThreadTitleGenerationService({
      generators: {
        codex: makeGenerator({ title: 123 }),
      },
    });

    await expect(
      service.generateTitle({
        backend: "codex",
        userPrompt: "Name this thread",
      })
    ).resolves.toEqual({
      status: "invalid",
      reason: "title_must_be_string",
      cachedTokens: 12,
    });
  });

  it("returns unavailable when a backend generator is absent", async () => {
    const service = new ThreadTitleGenerationService();

    await expect(
      service.generateTitle({
        backend: "acp:grok",
        userPrompt: "Name this thread",
      })
    ).resolves.toEqual({
      status: "unavailable",
      reason: "acp:grok_title_generator_unavailable",
    });
  });
});
