import { describe, expect, it } from "vitest";
import { PrThreadIndex } from "../pr-status/pr-thread-index";

describe("primary PR thread index", () => {
  it("retains shared ownership when one thread detaches or changes its primary PR", () => {
    const index = new PrThreadIndex();
    index.set("codex:one", ["repo#1", "repo#1"]);
    index.set("acp:two", ["repo#1"]);
    index.set("codex:one", ["repo#2"]);
    expect([...index.get("repo#1")!]).toEqual(["acp:two"]);
    expect([...index.get("repo#2")!]).toEqual(["codex:one"]);
    index.set("acp:two", []);
    expect(index.has("repo#1")).toBe(false);
    expect(index.has("repo#2")).toBe(true);
    index.clear();
    expect(index.has("repo#2")).toBe(false);
  });
});
