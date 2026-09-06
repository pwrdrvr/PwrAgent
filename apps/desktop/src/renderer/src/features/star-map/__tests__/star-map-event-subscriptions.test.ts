import { describe, expect, it } from "vitest";
import type { FederationCapability } from "@pwragent/shared";
import { buildStarMapEventSubscriptions } from "../star-map-event-subscriptions";

const capabilities: FederationCapability[] = [
  "thread_navigation", "thread_detail", "event_subscriptions", "pending_request_control", "scheduled_actions",
];
const peers = ["owner_one", "owner_two"].map((id) => ({ id, status: "connected" as const, capabilities }));
const card = (id: string, ownerInstanceId = "owner_one") => ({
  ownerInstanceId, thread: { id, source: "codex" as const },
});

describe("Star Map event demand", () => {
  it("keeps navigation broad and detail restricted to open cards", () => {
    const [one, two] = buildStarMapEventSubscriptions(peers, [card("B"), card("A"), card("A")]);
    const selected = { kind: "threads", threads: [
      { backend: "codex", threadId: "A" }, { backend: "codex", threadId: "B" },
    ] };
    expect(one.eventClassSelections).toEqual({
      navigation: { kind: "all" }, star_map: { kind: "all" }, scheduled_actions: { kind: "all" },
      transcript: selected, pending_requests: selected,
    });
    expect(two.eventClasses).not.toContain("transcript");
    const [closed] = buildStarMapEventSubscriptions(peers, []);
    expect(closed.eventClasses).toEqual(["navigation", "star_map", "scheduled_actions"]);
    expect(closed.eventClassSelections).toBeUndefined();
  });

  it("uses the foreign thread's owner, not its mounted graph group", () => {
    const foreign = { ...card("foreign"), thread: {
      ...card("foreign").thread,
      federation: {
        instanceLabel: "Two", ref: {
          backend: "codex" as const, threadId: "foreign",
          target: { scope: "remote" as const, instanceId: "owner_two" },
        },
      },
    } };
    const [one, two] = buildStarMapEventSubscriptions(peers, [foreign]);
    expect(one.eventClasses).not.toContain("transcript");
    expect(two.eventClassSelections?.transcript).toEqual({
      kind: "threads", threads: [{ backend: "codex", threadId: "foreign" }],
    });
  });

  it("does not request detail denied by capabilities or disconnected peers", () => {
    expect(buildStarMapEventSubscriptions([{ ...peers[0]!, status: "disconnected" }], [card("A")])).toEqual([]);
    const [restricted] = buildStarMapEventSubscriptions([{
      ...peers[0]!, capabilities: ["event_subscriptions", "thread_navigation"],
    }], [card("A")]);
    expect(restricted.eventClasses).toEqual(["navigation", "star_map"]);
    expect(restricted.eventClassSelections?.transcript).toBeUndefined();
  });
});
