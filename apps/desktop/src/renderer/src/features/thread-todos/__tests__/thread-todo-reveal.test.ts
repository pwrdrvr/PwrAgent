import { describe, expect, it } from "vitest";
import { consumeThreadTodoReveal } from "../thread-todo-reveal";

describe("consumeThreadTodoReveal", () => {
  it("acts once per click, and only for the click's thread", () => {
    const request = { threadKey: "codex:a" };
    expect(consumeThreadTodoReveal(undefined, "codex:a")).toBe(false);
    expect(consumeThreadTodoReveal(request, "codex:b")).toBe(false);
    expect(consumeThreadTodoReveal(request, "codex:a")).toBe(true);
    // The rail panel mounting after the stack took it does not act again.
    expect(consumeThreadTodoReveal(request, "codex:a")).toBe(false);
    expect(consumeThreadTodoReveal({ threadKey: "codex:a" }, "codex:a")).toBe(true);
  });
});
