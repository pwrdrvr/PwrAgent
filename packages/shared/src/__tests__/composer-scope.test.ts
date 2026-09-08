import { expect, it } from "vitest";
import { buildOwnedComposerScopeKey, parseOwnedComposerScopeKey } from "../composer-scope";

it("keeps local and same-id remote composer scopes distinct and round-trips colon-bearing identities", () => {
  const owners = [
    { backend: "acp:grok" as const, threadId: "same:with:colons", target: { scope: "local" as const } },
    { backend: "acp:grok" as const, threadId: "same:with:colons", target: { scope: "remote" as const, instanceId: "local" } },
    { backend: "acp:grok" as const, threadId: "same:with:colons", target: { scope: "remote" as const, instanceId: "peer:other" } },
  ];
  const keys = owners.map(buildOwnedComposerScopeKey);
  expect(new Set(keys).size).toBe(3);
  expect(keys.map(parseOwnedComposerScopeKey)).toEqual(owners);
  expect(parseOwnedComposerScopeKey("thread:codex:same")).toBeUndefined();
  expect(parseOwnedComposerScopeKey("thread:v2:broken%")).toBeUndefined();
});
