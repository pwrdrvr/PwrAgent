import type { NavigationThreadSummary } from "@pwragent/shared";
import { federatedThreadIdentityKey } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import { getThreadRowStatus, isThreadActive, isThreadNeedingAttention } from "../ThreadRowStatus";

const remoteTarget = {
  scope: "remote" as const,
  instanceId: "peer-harold",
};

function buildRemoteThread(): NavigationThreadSummary {
  return {
    id: "thread-shared-id",
    title: "Remote thread",
    titleSource: "explicit",
    source: "codex",
    threadStatus: "idle",
    linkedDirectories: [],
    inbox: { inInbox: false },
    federation: {
      ref: {
        backend: "codex",
        target: remoteTarget,
        threadId: "thread-shared-id",
      },
      instanceLabel: "Harold-MBP-M2-Max",
    },
  };
}

describe("isThreadActive", () => {
  it("does not let an unscoped stale session mark a remote row active", () => {
    expect(isThreadActive(buildRemoteThread(), {
      "codex:thread-shared-id": true,
    })).toBe(false);
  });

  it("reads renderer thinking from the remote thread identity", () => {
    const thread = buildRemoteThread();
    expect(isThreadActive(thread, {
      [federatedThreadIdentityKey(thread.federation!.ref)]: true,
    })).toBe(true);
  });
});

it("shows idle parents with live workers in navigation and clears them when workers finish", () => {
  const thread = { ...buildRemoteThread(), hasActiveSubAgent: true };
  expect(isThreadActive(thread)).toBe(true);
  expect(getThreadRowStatus(thread)).toBe("thinking");
  expect(isThreadNeedingAttention(thread)).toBe(true);
  expect(isThreadActive({ ...thread, hasActiveSubAgent: false })).toBe(false);
});
