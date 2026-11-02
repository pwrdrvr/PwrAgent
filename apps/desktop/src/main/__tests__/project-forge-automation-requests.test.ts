import { describe, expect, it } from "vitest";
import {
  assertProjectHeldWakeupResolutions,
  readProjectForgeDirectoryKey,
} from "../app-server/project-forge-automation-requests";

describe("readProjectForgeDirectoryKey", () => {
  it("accepts a Directories project key", () => {
    expect(readProjectForgeDirectoryKey({ directoryKey: "directory:/repo/PwrAgent" }))
      .toBe("directory:/repo/PwrAgent");
  });

  it.each([
    ["a workspace", "workspace:/Users/fixture/.pwragent/projects"],
    ["the unlinked bucket", "unlinked"],
    ["an empty path", "directory:"],
    ["a key no project could have", `directory:/${"a".repeat(4_096)}`],
    ["a non-string", 42],
  ])("refuses %s", (_name, directoryKey) => {
    expect(() => readProjectForgeDirectoryKey({ directoryKey }))
      .toThrow("Directories project");
  });
});

describe("assertProjectHeldWakeupResolutions", () => {
  it("accepts send and discard for a named entry and thread", () => {
    expect(() => assertProjectHeldWakeupResolutions([
      { entryId: "held-1", backend: "codex", threadId: "thread-1", action: "send" },
      { entryId: "held-2", backend: "claude", threadId: "thread-2", action: "discard" },
    ])).not.toThrow();
  });

  it("refuses a malformed resolution or an oversized batch", () => {
    expect(() => assertProjectHeldWakeupResolutions([
      { entryId: "held-1", backend: "codex", threadId: "thread-1", action: "later" },
    ])).toThrow("send or discard");
    expect(() => assertProjectHeldWakeupResolutions([
      { entryId: "held-1", backend: "not-a-backend", threadId: "thread-1", action: "send" },
    ])).toThrow("send or discard");
    expect(() => assertProjectHeldWakeupResolutions("all")).toThrow("at most 500");
    expect(() => assertProjectHeldWakeupResolutions(Array.from({ length: 501 }, (_, index) => ({
      entryId: `held-${index}`, backend: "codex", threadId: "thread-1", action: "send",
    })))).toThrow("at most 500");
  });
});
