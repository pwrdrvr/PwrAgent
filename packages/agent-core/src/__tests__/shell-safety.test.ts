import { describe, expect, it } from "vitest";
import { classifyShellCommand, splitShellWords } from "../tools/shell-safety.js";

describe("shell safety", () => {
  it("classifies safe read-only commands", () => {
    expect(classifyShellCommand("rg UNIQUE src")).toEqual({
      safe: true,
      commandAction: "search",
    });
    expect(classifyShellCommand("git status --short")).toEqual({
      safe: true,
      commandAction: "unknown",
    });
  });

  it("requires approval for unsafe ripgrep flags and mutating git commands", () => {
    expect(classifyShellCommand("rg --search-zip UNIQUE src")).toEqual({
      safe: false,
      commandAction: "search",
      reason: "ripgrep flag requires approval: --search-zip",
    });
    expect(classifyShellCommand("rg --pre cat UNIQUE src")).toEqual({
      safe: false,
      commandAction: "search",
      reason: "ripgrep flag requires approval: --pre",
    });
    expect(classifyShellCommand("git push")).toEqual({
      safe: false,
      commandAction: "unknown",
      reason: "mutating or unknown git commands require approval",
    });
  });

  it("treats shell metacharacters as requiring approval", () => {
    expect(classifyShellCommand("git status | wc -l")).toEqual({
      safe: false,
      commandAction: "unknown",
      reason: "shell metacharacters require approval",
    });
  });

  it("splits shell words while respecting quoted segments", () => {
    expect(splitShellWords('rg "hello world" src')).toEqual([
      "rg",
      "hello world",
      "src",
    ]);
  });
});
