import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GROK_THREAD_TITLE_MODEL,
  GrokThreadTitleGenerator,
  THREAD_TITLE_PROMPT_VERSION,
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

  it("preserves recognized issue and PR references", async () => {
    const service = new ThreadTitleGenerationService({
      generators: {
        codex: makeGenerator({ title: "PR 456 issue 123 followup" }),
      },
    });

    await expect(
      service.generateTitle({
        backend: "codex",
        userPrompt: "In issue 123 and PR 456, why does rename fail?",
      })
    ).resolves.toMatchObject({
      status: "generated",
      title: "PR 456 issue 123 followup",
    });
  });

  it("preserves bare numeric references", async () => {
    const service = new ThreadTitleGenerationService({
      generators: {
        codex: makeGenerator({ title: "456 rename followup" }),
      },
    });

    await expect(
      service.generateTitle({
        backend: "codex",
        userPrompt: "Can we inspect 456 for rename behavior?",
      })
    ).resolves.toMatchObject({
      status: "generated",
      title: "456 rename followup",
    });
  });

  it("rejects titles that drop ticket references from the prompt", async () => {
    const service = new ThreadTitleGenerationService({
      generators: {
        codex: makeGenerator({ title: "Checkout crash followup" }),
      },
    });

    await expect(
      service.generateTitle({
        backend: "codex",
        userPrompt: "PROJECT-123 investigate checkout crash",
      })
    ).resolves.toEqual({
      status: "invalid",
      reason: "ticket_reference_missing",
    });
  });

  it("rejects titles that preserve only one of multiple references", async () => {
    const service = new ThreadTitleGenerationService({
      generators: {
        codex: makeGenerator({ title: "Issue 123 rename followup" }),
      },
    });

    await expect(
      service.generateTitle({
        backend: "codex",
        userPrompt: "In issue 123 and PR 456, why does rename fail?",
      })
    ).resolves.toEqual({
      status: "invalid",
      reason: "ticket_reference_missing",
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

  it("rejects overlong and wordy generated titles", async () => {
    const longTitleService = new ThreadTitleGenerationService({
      generators: {
        codex: makeGenerator({
          title: "This title is intentionally much too long for the desktop thread title limit",
        }),
      },
    });
    const wordyTitleService = new ThreadTitleGenerationService({
      generators: {
        codex: makeGenerator({ title: "One two three four five six seven" }),
      },
    });

    await expect(
      longTitleService.generateTitle({
        backend: "codex",
        userPrompt: "Name this thread",
      })
    ).resolves.toEqual({
      status: "invalid",
      reason: "title_too_long",
    });
    await expect(
      wordyTitleService.generateTitle({
        backend: "codex",
        userPrompt: "Name this thread",
      })
    ).resolves.toEqual({
      status: "invalid",
      reason: "title_too_many_words",
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
    });
  });

  it("returns unavailable when a backend generator is absent", async () => {
    const service = new ThreadTitleGenerationService({
      generators: { grok: undefined },
    });

    await expect(
      service.generateTitle({
        backend: "grok",
        userPrompt: "Name this thread",
      })
    ).resolves.toEqual({
      status: "unavailable",
      reason: "grok_title_generator_unavailable",
    });
  });
});

describe("GrokThreadTitleGenerator", () => {
  it("calls xAI with the fast non-reasoning title model", async () => {
    const client = {
      generateObject: vi.fn(async () => ({
        object: { title: "Thread naming" },
        cachedTokens: 8,
      })),
    };
    const generator = new GrokThreadTitleGenerator({ client });

    await expect(
      generator.generateTitle({
        prompt: "Name this thread",
        promptVersion: THREAD_TITLE_PROMPT_VERSION,
        schema: { type: "object" },
        schemaName: "thread_title",
        timeoutMs: 5_000,
      })
    ).resolves.toEqual({
      status: "ok",
      object: { title: "Thread naming" },
      cachedTokens: 8,
    });

    expect(client.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: DEFAULT_GROK_THREAD_TITLE_MODEL,
        promptCacheKey: THREAD_TITLE_PROMPT_VERSION,
        schemaName: "thread_title",
        headers: {
          "x-grok-conv-id": THREAD_TITLE_PROMPT_VERSION,
        },
      })
    );
  });
});
