import { describe, expect, it } from "vitest";
import { CodexModelProviderTranslator } from "../codex-app-server/codex-model-provider-translation";

function translator(ids: string[] = ["refuseless"]) {
  const configured = new Set(ids);
  return { configured, translator: new CodexModelProviderTranslator(() => configured) };
}

describe("CodexModelProviderTranslator", () => {
  it("turns a qualified model into Codex's model and modelProvider when a thread starts", () => {
    const { translator: t } = translator();
    expect(t.translateRequest("thread/start", { model: "@refuseless/glm-5.3-abliterated", cwd: "/repo" }))
      .toEqual({ model: "glm-5.3-abliterated", modelProvider: "refuseless", cwd: "/repo" });
    expect(t.translateRequest("thread/start", { model: "gpt-5.5" })).toEqual({ model: "gpt-5.5" });
  });

  it("never rewrites turn input text", () => {
    const { translator: t } = translator();
    const input = [{ type: "text", text: "use model @refuseless/x", model: "@refuseless/x" }];
    const params = { threadId: "t1", input, model: "@refuseless/glm-5.3-abliterated" };
    const translated = t.translateRequest("turn/start", params) as Record<string, unknown>;
    expect(translated.model).toBe("glm-5.3-abliterated");
    expect(translated.input).toBe(input);
    expect(translated).not.toHaveProperty("modelProvider");
  });

  it("learns a thread's provider from responses and qualifies what Codex reports", () => {
    const { translator: t } = translator();
    const started = t.observeResponse("thread/start", {}, {
      thread: { id: "t1", modelProvider: "refuseless", model: "glm-5.3-abliterated" },
      model: "glm-5.3-abliterated",
      modelProvider: "refuseless",
    }) as Record<string, any>;
    expect(started.thread.model).toBe("@refuseless/glm-5.3-abliterated");
    expect(started.model).toBe("@refuseless/glm-5.3-abliterated");
    expect(t.providerForThread("t1")).toBe("refuseless");

    const listed = t.observeResponse("thread/list", {}, {
      data: [
        { id: "t2", modelProvider: "refuseless", model: "deepseek-v4.1-flash" },
        { id: "t3", modelProvider: "openai", model: "gpt-5.5" },
      ],
    }) as { data: Array<{ id: string; model: string }> };
    expect(listed.data.map((thread) => thread.model)).toEqual(["@refuseless/deepseek-v4.1-flash", "gpt-5.5"]);
  });

  it("leaves providers PwrAgent did not configure as Codex reports them", () => {
    const { translator: t } = translator();
    const result = t.observeResponse("thread/read", { threadId: "t4" }, {
      thread: { id: "t4", modelProvider: "my-own", model: "llama" },
    }) as { thread: { model: string } };
    expect(result.thread.model).toBe("llama");
    expect(t.providerForThread("t4")).toBeUndefined();
  });

  it("reports every provider Codex named, and nothing for a thread it has not", () => {
    const { translator: t } = translator();
    t.observeResponse("thread/read", { threadId: "t4" }, { thread: { id: "t4", modelProvider: "ollama", model: "llama" } });
    t.observeResponse("thread/read", { threadId: "t5" }, { thread: { id: "t5", modelProvider: "openai", model: "gpt-5.5" } });
    t.observeResponse("thread/read", { threadId: "t6" }, { thread: { id: "t6", modelProvider: "refuseless", model: "glm" } });
    expect(t.reportedProviderForThread("t4")).toBe("ollama");
    expect(t.reportedProviderForThread("t5")).toBe("openai");
    expect(t.reportedProviderForThread("t6")).toBe("refuseless");
    expect(t.reportedProviderForThread("t7")).toBeUndefined();
  });

  it("resumes a provider thread on its provider and refuses a switch to another", () => {
    const { translator: t } = translator(["refuseless", "bonsai"]);
    t.observeResponse("thread/read", { threadId: "t1" }, { thread: { id: "t1", modelProvider: "refuseless", model: "glm" } });
    expect(t.translateRequest("thread/resume", { threadId: "t1" }))
      .toEqual({ threadId: "t1", modelProvider: "refuseless" });
    expect(() => t.translateRequest("turn/start", { threadId: "t1", model: "@bonsai/bonsai-2" }))
      .toThrow(/runs on refuseless/);
    expect(() => t.translateRequest("thread/start", {
      model: "@refuseless/glm",
      review: { model: "@bonsai/bonsai-2" },
    })).toThrow(/more than one model provider/);
  });

  it("qualifies models in notifications for a provider thread", () => {
    const { translator: t } = translator();
    t.observeResponse("thread/start", {}, { thread: { id: "t1", modelProvider: "refuseless", model: "glm" } });
    expect(t.translateNotification("thread/settings/updated", { threadId: "t1", settings: { model: "glm" } }))
      .toEqual({ threadId: "t1", settings: { model: "@refuseless/glm" } });
    const other = { threadId: "t9", settings: { model: "gpt-5.5" } };
    expect(t.translateNotification("thread/settings/updated", other)).toBe(other);
    expect(t.translateNotification("thread/started", { thread: { id: "t5", modelProvider: "refuseless", model: "glm" } }))
      .toEqual({ thread: { id: "t5", modelProvider: "refuseless", model: "@refuseless/glm" } });
  });

  it("forgets a provider once it is removed from Settings", () => {
    const { configured, translator: t } = translator();
    t.observeResponse("thread/start", {}, { thread: { id: "t1", modelProvider: "refuseless", model: "glm" } });
    configured.delete("refuseless");
    expect(t.providerForThread("t1")).toBeUndefined();
    expect(t.qualifyModel("t1", "glm")).toBe("glm");
  });

  it("bounds the threads it remembers", () => {
    const configured = new Set(["refuseless"]);
    const t = new CodexModelProviderTranslator(() => configured, 2);
    for (const id of ["a", "b", "c"]) {
      t.observeResponse("thread/start", {}, { thread: { id, modelProvider: "refuseless", model: "glm" } });
    }
    expect(t.providerForThread("a")).toBeUndefined();
    expect(t.providerForThread("c")).toBe("refuseless");
  });
});

describe("CodexModelProviderTranslator request copies", () => {
  it("does not change the caller's params", () => {
    const configured = new Set(["refuseless"]);
    const t = new CodexModelProviderTranslator(() => configured);
    t.observeResponse("thread/start", {}, { thread: { id: "t1", modelProvider: "refuseless", model: "glm" } });
    const params = { threadId: "t1" };
    t.translateRequest("thread/resume", params);
    expect(params).toEqual({ threadId: "t1" });
  });
});

describe("CodexModelProviderTranslator default-provider threads", () => {
  it("refuses to move a thread on Codex's default provider onto a configured one", () => {
    const configured = new Set(["refuseless"]);
    const t = new CodexModelProviderTranslator(() => configured);
    t.observeResponse("thread/read", { threadId: "t1" }, { thread: { id: "t1", modelProvider: "openai", model: "gpt-5.5" } });
    expect(t.providerForThread("t1")).toBeUndefined();
    expect(() => t.translateRequest("thread/resume", { threadId: "t1", model: "@refuseless/glm" }))
      .toThrow(/runs on Codex's default provider/);
    expect(() => t.translateRequest("turn/start", { threadId: "t1", model: "@refuseless/glm" }))
      .toThrow(/default provider/);
    expect(t.translateRequest("turn/start", { threadId: "t1", model: "gpt-5.5" }))
      .toEqual({ threadId: "t1", model: "gpt-5.5" });
    // A fork starts a new thread, so it may take another provider.
    expect(t.translateRequest("thread/fork", { threadId: "t1", model: "@refuseless/glm" }))
      .toEqual({ threadId: "t1", model: "glm", modelProvider: "refuseless" });
  });
});
