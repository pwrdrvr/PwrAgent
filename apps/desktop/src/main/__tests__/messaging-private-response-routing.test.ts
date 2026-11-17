import { describe, expect, it } from "vitest";
import { privateResponseHarness } from "./fixtures/private-response-harness";
import { messagingModules } from "./fixtures/messaging-controller-modules";

describe("private-response routing to the state owner", () => {
  it("settles a claimed fallback when tool validation rejects before delivery begins", async () => {
    const f = await privateResponseHarness();
    try {
      const turnId = await f.start("old-thread", "DM me the fixture answer");
      const text = "x".repeat(40_001);
      await f.answer("old-thread", turnId, text);
      await f.answer("old-thread", turnId, text);
      expect(f.privateTexts).toEqual([]);
      expect(f.sourceTexts).not.toContain(text);
      expect(messagingModules(f.controller).privateResponses.state(`codex:old-thread:${turnId}`)).toMatchObject({ status: "fallbackAttempted", pending: 0 });
    } finally { await f.close(); }
  });

  it("keeps a repeated final private while the first provider response is unresolved", async () => {
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const provider = new Promise<void>(resolve => { release = resolve; });
    const f = await privateResponseHarness({ beforePrivateDelivery: async () => { entered(); await provider; } });
    let first: Promise<void> | undefined;
    try {
      const turnId = await f.start("old-thread", "DM me the fixture answer");
      first = f.answer("old-thread", turnId, "Fixture concurrent answer");
      await Promise.race([waiting, first.then(() => {
        expect(f.privateTexts, "the private fallback must reach the provider").toContain("Fixture concurrent answer");
      })]);
      await f.answer("old-thread", turnId, "Fixture concurrent answer");
      expect(f.sourceTexts).not.toContain("Fixture concurrent answer");
      release();
      await first;
      expect(f.privateTexts).toEqual(["Fixture concurrent answer"]);
    } finally { release(); await first; await f.close(); }
  });

  it("holds an unphased message and sends the latest text only at the terminal event", async () => {
    const f = await privateResponseHarness();
    try {
      const turnId = await f.start("old-thread", "DM me the fixture answer");
      const key = `codex:old-thread:${turnId}`;
      for (const text of ["Fixture progress", "Fixture final answer"]) {
        await f.controller.handleBackendEvent({ backend: "codex", notification: {
          method: "item/completed", params: { threadId: "old-thread", turnId, item: { id: text, type: "agentMessage", text } },
        } });
      }
      const owner = messagingModules(f.controller).privateResponses;
      expect(owner.heldText(key)).toBe("Fixture final answer");
      expect(f.privateTexts).toEqual([]);
      await f.complete("old-thread", turnId);
      expect(f.privateTexts).toEqual(["Fixture final answer"]);
      expect(owner.heldText(key)).toBeUndefined();
      expect(owner.state(key)).toMatchObject({ status: "terminal", lifetime: "settled", replyCompletion: false, pending: 0 });
    } finally { await f.close(); }
  });

  it("reads the state owner through the current lazy host port", async () => {
    const f = await privateResponseHarness();
    try {
      const modules = messagingModules(f.controller);
      const host = modules.backendEventHost();
      expect(host.privateResponses).toBe(modules.privateResponses);
      const turnId = await f.start("old-thread", "DM me the fixture answer");
      await f.answer("old-thread", turnId, "Fixture answer");
      expect(f.privateTexts).toEqual(["Fixture answer"]);
    } finally { await f.close(); }
  });

  it("retains delivery evidence across the single detach pipeline until authoritative turn cleanup", async () => {
    const f = await privateResponseHarness();
    try {
      const turnId = await f.start("old-thread", "DM me the fixture answer");
      await f.answer("old-thread", turnId, "Fixture detached answer");
      const binding = await f.store.getBinding("binding-old-thread");
      expect(binding).toBeDefined();
      expect(await f.controller.handleBindingRevokeRequest(binding!)).toBe(true);
      expect((await f.store.getBinding(binding!.id))?.revokedAt).toBeDefined();
      await f.answer("old-thread", turnId, "Fixture detached answer");
      expect(f.privateTexts).toEqual(["Fixture detached answer"]);
      expect(f.sourceTexts).not.toContain("Fixture detached answer");
      await f.complete("old-thread", turnId);
      expect(messagingModules(f.controller).privateResponses.state(`codex:old-thread:${turnId}`)).toMatchObject({ status: "terminal", lifetime: "settled" });
    } finally { await f.close(); }
  });

  it("does not resurrect state when an in-flight provider delivery returns after shutdown", async () => {
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const provider = new Promise<void>(resolve => { release = resolve; });
    const f = await privateResponseHarness({ beforePrivateDelivery: async () => { entered(); await provider; } });
    let first: Promise<void> | undefined;
    try {
      const turnId = await f.start("old-thread", "DM me the fixture answer");
      first = f.answer("old-thread", turnId, "Fixture pending answer");
      await Promise.race([waiting, first.then(() => { expect(f.privateTexts).toContain("Fixture pending answer"); })]);
      const owner = messagingModules(f.controller).privateResponses;
      f.controller.dispose();
      release();
      await first;
      expect(owner.state(`codex:old-thread:${turnId}`)).toBeUndefined();
      expect(owner.claimFallback(`codex:old-thread:${turnId}`)).toBe(false);
    } finally { release(); await first; await f.close(); }
  });
});
