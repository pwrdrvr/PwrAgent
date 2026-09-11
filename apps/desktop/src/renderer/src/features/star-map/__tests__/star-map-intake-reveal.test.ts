import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { findStarMapIntakeRevealTarget } from "../star-map-intake-reveal";

function thread(
  id: string,
  source: NavigationThreadSummary["source"] = "codex",
): NavigationThreadSummary {
  return { id, source, title: id } as unknown as NavigationThreadSummary;
}

const LOCAL = "pwr_local";

describe("findStarMapIntakeRevealTarget", () => {
  it("waits while the owning feed has not carried the thread yet", () => {
    expect(
      findStarMapIntakeRevealTarget({
        localInstanceId: LOCAL,
        localThreads: [thread("thread-old")],
        remoteThreadsByInstance: new Map(),
        reveal: { instanceId: LOCAL, threadKey: "codex:thread-new" },
      }),
    ).toBeUndefined();
  });

  it("reveals a local thread once the refresh carries it", () => {
    const created = thread("thread-new");
    expect(
      findStarMapIntakeRevealTarget({
        localInstanceId: LOCAL,
        localThreads: [thread("thread-old"), created],
        remoteThreadsByInstance: new Map(),
        reveal: { instanceId: LOCAL, threadKey: "codex:thread-new" },
      }),
    ).toBe(created);
  });

  it("reveals a thread created through a remote instance's [+]", () => {
    const created = thread("thread-new");
    expect(
      findStarMapIntakeRevealTarget({
        localInstanceId: LOCAL,
        localThreads: [],
        remoteThreadsByInstance: new Map([["pwr_peer", [created]]]),
        reveal: { instanceId: "pwr_peer", threadKey: "codex:thread-new" },
      }),
    ).toBe(created);
  });

  it("does not reveal a same-id thread belonging to another instance", () => {
    // Thread ids are backend-scoped, not globally unique, so a search across
    // every feed would fly the map to the wrong instance's card.
    expect(
      findStarMapIntakeRevealTarget({
        localInstanceId: LOCAL,
        localThreads: [thread("thread-new")],
        remoteThreadsByInstance: new Map(),
        reveal: { instanceId: "pwr_peer", threadKey: "codex:thread-new" },
      }),
    ).toBeUndefined();
  });

  it("distinguishes threads that share an id across backends", () => {
    const acp = thread("thread-new", "acp:grok");
    expect(
      findStarMapIntakeRevealTarget({
        localInstanceId: LOCAL,
        localThreads: [thread("thread-new"), acp],
        remoteThreadsByInstance: new Map(),
        reveal: { instanceId: LOCAL, threadKey: "acp:grok:thread-new" },
      }),
    ).toBe(acp);
  });

  it("reveals a thread captured before federation health named this instance", () => {
    // `localInstanceId` is `health?.instanceId ?? "local"`, so a [+] clicked
    // before health lands captures the placeholder.
    const created = thread("thread-new");
    expect(
      findStarMapIntakeRevealTarget({
        localInstanceId: LOCAL,
        localThreads: [created],
        remoteThreadsByInstance: new Map(),
        reveal: { instanceId: "local", threadKey: "codex:thread-new" },
      }),
    ).toBe(created);
  });

  it("reveals a thread captured while health is momentarily absent", () => {
    const created = thread("thread-new");
    expect(
      findStarMapIntakeRevealTarget({
        localInstanceId: "local",
        localThreads: [created],
        remoteThreadsByInstance: new Map(),
        reveal: { instanceId: LOCAL, threadKey: "codex:thread-new" },
      }),
    ).toBe(created);
  });

  it("resolves nothing without a pending reveal", () => {
    expect(
      findStarMapIntakeRevealTarget({
        localInstanceId: LOCAL,
        localThreads: [thread("thread-new")],
        remoteThreadsByInstance: new Map(),
        reveal: undefined,
      }),
    ).toBeUndefined();
  });
});
