import { describe, expect, it } from "vitest";
import {
  buildAcpBackendId,
  buildLegacyEncodedThreadIdentityKey,
  buildThreadIdentityKey,
  encodeLegacyThreadIdentityKey,
  encodeNavigationSnapshotThreadKeysForProtocolV1,
  isAcpBackendId,
  isAppServerBackendKind,
  isAppServerBuiltinBackendKind,
  normalizeNavigationSnapshotThreadKeys,
  normalizeThreadIdentityKey,
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

  it("keeps ACP backend ids intact and parses them structurally", () => {
    const key = buildThreadIdentityKey("acp:gemini", "thread:with:colon");

    expect(key).toBe("acp:gemini:thread:with:colon");
    expect(parseThreadIdentityKey(key)).toEqual({
      backend: "acp:gemini",
      threadId: "thread:with:colon",
    });
  });

  it("retains an explicit encoded form for compatibility boundaries", () => {
    expect(
      buildLegacyEncodedThreadIdentityKey(
        "acp:gemini",
        "thread:with:colon",
      ),
    ).toBe("acp%3Agemini:thread:with:colon");
    expect(
      encodeLegacyThreadIdentityKey("acp:gemini:thread:with:colon"),
    ).toBe("acp%3Agemini:thread:with:colon");
  });

  it("parses legacy percent-encoded ACP thread keys", () => {
    expect(parseThreadIdentityKey("acp%3Agemini:thread:with:colon")).toEqual({
      backend: "acp:gemini",
      threadId: "thread:with:colon",
    });
    expect(
      normalizeThreadIdentityKey("acp%3Agemini:thread:with:colon"),
    ).toBe("acp:gemini:thread:with:colon");
  });

  it("normalizes legacy keys in navigation snapshots from older peers", () => {
    const snapshot = normalizeNavigationSnapshotThreadKeys({
      backend: "all",
      fetchedAt: 1,
      unchanged: false,
      threads: [],
      inboxThreadKeys: ["acp%3Agemini:thread-1"],
      directories: [{
        key: "directory-1",
        kind: "directory",
        label: "Project",
        threadKeys: ["acp%3Agemini:thread-1"],
        needsAttentionCount: 0,
      }],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });

    expect(snapshot.inboxThreadKeys).toEqual(["acp:gemini:thread-1"]);
    expect(snapshot.directories[0]?.threadKeys).toEqual([
      "acp:gemini:thread-1",
    ]);
  });

  it("encodes navigation keys for protocol-v1 federation peers", () => {
    const snapshot = encodeNavigationSnapshotThreadKeysForProtocolV1({
      backend: "all",
      fetchedAt: 1,
      unchanged: false,
      threads: [],
      inboxThreadKeys: ["acp:gemini:thread-1"],
      directories: [{
        key: "directory-1",
        kind: "directory",
        label: "Project",
        threadKeys: ["acp:gemini:thread-1"],
        needsAttentionCount: 0,
      }],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });

    expect(snapshot.inboxThreadKeys).toEqual(["acp%3Agemini:thread-1"]);
    expect(snapshot.directories[0]?.threadKeys).toEqual([
      "acp%3Agemini:thread-1",
    ]);
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
