import { describe, expect, it } from "vitest";
import type { AppServerThreadMessageOrigin } from "@pwragent/shared";
import { delegatedTurnAttribution } from "../app-server/delegated-turn-attribution";

const origin: AppServerThreadMessageOrigin = {
  kind: "agent",
  sourceThread: { backend: "codex", threadId: "source", turnId: "parent", rootTurnId: "root" },
};

describe("delegated turn attribution", () => {
  it("forwards exact parent and root through stored provenance", () => {
    expect(delegatedTurnAttribution(structuredClone(origin))).toEqual({ parentTurnId: "parent", rootTurnId: "root" });
  });

  it("keeps an unknown root unknown", () => {
    expect(delegatedTurnAttribution({ ...origin, sourceThread: { ...origin.sourceThread!, rootTurnId: undefined } }))
      .toEqual({ parentTurnId: "parent" });
  });

  it.each([undefined, { kind: "pwragent" as const },
    { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "old-record" } },
    { ...origin, kind: "pwragent" as const },
    { ...origin, sourceThread: { ...origin.sourceThread!, backend: "claude" as const } },
  ])("does not manufacture ancestry for %j", (value) => {
    expect(delegatedTurnAttribution(value)).toEqual({});
  });

  it("attributes a batch only when every message has the same exact ancestry", () => {
    expect(delegatedTurnAttribution(origin, [origin, structuredClone(origin)]))
      .toEqual({ parentTurnId: "parent", rootTurnId: "root" });
    for (const change of [{ turnId: "other" }, { rootTurnId: "other" }, { instanceId: "other" }, { turnId: undefined }]) {
      const other = { ...origin, sourceThread: { ...origin.sourceThread!, ...change } };
      expect(delegatedTurnAttribution(other, [origin, other])).toEqual({});
    }
  });
});
