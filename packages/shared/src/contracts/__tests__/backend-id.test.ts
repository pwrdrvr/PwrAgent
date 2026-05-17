import { describe, expect, it } from "vitest";
import {
  buildAcpBackendId,
  buildThreadIdentityKey,
  isAcpBackendId,
  isAppServerBackendKind,
  isAppServerBuiltinBackendKind,
  parseThreadIdentityKey,
} from "../navigation";

describe("backend identity helpers", () => {
  it("recognizes built-in and ACP backend ids", () => {
    expect(isAppServerBuiltinBackendKind("codex")).toBe(true);
    expect(isAppServerBuiltinBackendKind("grok")).toBe(true);
    expect(isAppServerBuiltinBackendKind("acp:gemini")).toBe(false);

    expect(isAcpBackendId("acp:gemini")).toBe(true);
    expect(isAcpBackendId("acp:open-code")).toBe(true);
    expect(isAcpBackendId("acp:")).toBe(false);
    expect(isAcpBackendId("acp:bad id")).toBe(false);

    expect(isAppServerBackendKind("codex")).toBe(true);
    expect(isAppServerBackendKind("grok")).toBe(true);
    expect(isAppServerBackendKind("acp:gemini")).toBe(true);
    expect(isAppServerBackendKind("unknown")).toBe(false);
  });

  it("builds ACP backend ids from registry ids", () => {
    expect(buildAcpBackendId("gemini")).toBe("acp:gemini");
    expect(buildAcpBackendId(" open-code ")).toBe("acp:open-code");
    expect(() => buildAcpBackendId("../bad")).toThrow("Invalid ACP registry id");
  });

  it("keeps legacy built-in thread keys stable", () => {
    expect(buildThreadIdentityKey("codex", "thread-1")).toBe("codex:thread-1");
    expect(buildThreadIdentityKey("grok", "thread:with:colon")).toBe(
      "grok:thread:with:colon",
    );
  });

  it("escapes dynamic backend ids so thread ids parse unambiguously", () => {
    const key = buildThreadIdentityKey("acp:gemini", "thread:with:colon");

    expect(key).toBe("acp%3Agemini:thread:with:colon");
    expect(parseThreadIdentityKey(key)).toEqual({
      backend: "acp:gemini",
      threadId: "thread:with:colon",
    });
  });

  it("parses legacy built-in keys", () => {
    expect(parseThreadIdentityKey("codex:thread-1")).toEqual({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(parseThreadIdentityKey("grok:thread:with:colon")).toEqual({
      backend: "grok",
      threadId: "thread:with:colon",
    });
  });

  it("rejects malformed thread identity keys", () => {
    expect(parseThreadIdentityKey("missing-separator")).toBeUndefined();
    expect(parseThreadIdentityKey("unknown:thread-1")).toBeUndefined();
    expect(parseThreadIdentityKey("acp%3A:thread-1")).toBeUndefined();
  });
});
