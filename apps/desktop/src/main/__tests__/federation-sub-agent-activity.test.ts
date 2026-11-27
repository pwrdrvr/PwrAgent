import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { FederationThreadSelection } from "@pwragent/shared/contracts/federation";
import { navigationQueryEventRequiresRefresh } from "@pwragent/shared/navigation-query-events";
import { describe, expect, it } from "vitest";
import { FederationAccountingStream } from "../federation/federation-event-stream";
import {
  eventMatchesThreadSelection,
  federationEventClassForMethod,
  navigationInvalidationForLocalEvent,
  projectLocalEventForFederation,
  unsequencedFederationEventPayload,
} from "../federation/federation-runtime";

/**
 * A peer's thread rows draw what its running sub-agents are doing, so the
 * activity snapshot reaches navigation subscribers, not only an open
 * transcript. It changes once per sub-agent tool call, so it must reach them
 * as itself and never as a navigation invalidation or a collection refresh.
 */
describe("sub-agent activity across federation", () => {
  const event: AgentEvent = { backend: "claude", notification: { method: "thread/subAgentActivity/updated",
    params: { threadId: "parent", activities: [{ monitorId: "claude-native:task-1", activity: "Reading app.css" }] } } };

  it("reaches navigation subscribers of the thread, and only them", () => {
    expect(federationEventClassForMethod(event.notification.method)).toBe("navigation");
    const subscribed: FederationThreadSelection = { kind: "threads", threads: [{ backend: "claude", threadId: "parent" }] };
    const other: FederationThreadSelection = { kind: "threads", threads: [{ backend: "claude", threadId: "elsewhere" }] };
    expect(eventMatchesThreadSelection(event, "navigation", subscribed)).toBe(true);
    expect(eventMatchesThreadSelection(event, "navigation", other)).toBe(false);
  });

  it("never invalidates navigation or refreshes a collection", () => {
    expect(navigationInvalidationForLocalEvent(event)).toBeUndefined();
    expect(navigationQueryEventRequiresRefresh(event.notification.method, event.notification.params)).toBe(false);
  });

  it("arrives whole over sequenced and legacy transports", () => {
    const federated = projectLocalEventForFederation(event, "owner");
    const encoded = new FederationAccountingStream().encode(federated, { epoch: "activity", sequence: 1 });
    expect(new FederationAccountingStream().decode(JSON.parse(JSON.stringify(encoded)))?.notification)
      .toEqual(event.notification);
    expect(unsequencedFederationEventPayload(federated).notification).toEqual(event.notification);
  });
});
