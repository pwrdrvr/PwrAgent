import type { AgentEvent } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import { FederationAccountingStream } from "../federation/federation-event-stream";
import {
  eventMatchesThreadSelection,
  navigationInvalidationForLocalEvent,
  unsequencedFederationEventPayload,
} from "../federation/federation-runtime";

describe("federation error notice selection", () => {
  it("preserves owner-local directory scope through tiny invalidations and both event transports", () => {
    const event = { backend: "codex", navigationDirectoryScope: { version: 1, directoryKeys: ["directory:/off-page"] },
      notification: { method: "thread/backgroundTasks/updated", params: { threadId: "hidden-descendant", tasks: [] } },
    } as AgentEvent;
    const invalidation = navigationInvalidationForLocalEvent(event)!;
    expect(invalidation.navigationDirectoryScope).toEqual(event.navigationDirectoryScope);
    expect(invalidation.notification.params).not.toHaveProperty("tasks");
    const encoded = new FederationAccountingStream().encode(invalidation, { epoch: "scope", sequence: 1 });
    expect(new FederationAccountingStream().decode(JSON.parse(JSON.stringify(encoded)))?.navigationDirectoryScope)
      .toEqual(event.navigationDirectoryScope);
    expect(unsequencedFederationEventPayload(invalidation).navigationDirectoryScope).toEqual(event.navigationDirectoryScope);
  });

  it("delivers a headless failure to subscribers of its visible owner thread", () => {
    const event: AgentEvent = {
      backend: "codex",
      errorNoticeContext: {
        backend: "codex",
        threadId: "agent-thread",
        title: "Search/Signals Agent",
        automationName: "Search Bots",
      },
      notification: {
        method: "turn/failed",
        params: {
          threadId: "headless-thread",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "failed", error: { message: "Spend cap" } },
        },
      },
    };
    expect(eventMatchesThreadSelection(event, "transcript", {
      kind: "threads",
      threads: [{ backend: "codex", threadId: "agent-thread" }],
    })).toBe(true);
    expect(eventMatchesThreadSelection(event, "transcript", {
      kind: "threads",
      threads: [{ backend: "codex", threadId: "other-thread" }],
    })).toBe(false);
    const encoded = new FederationAccountingStream().encode(event, {
      epoch: "stream-1", sequence: 1,
    });
    const relayed = new FederationAccountingStream().decode(
      JSON.parse(JSON.stringify(encoded)),
    );
    expect(relayed?.errorNoticeContext).toEqual(event.errorNoticeContext);
    const unsequenced = JSON.parse(JSON.stringify(
      unsequencedFederationEventPayload(event),
    )) as AgentEvent;
    expect(unsequenced.errorNoticeContext).toEqual(event.errorNoticeContext);
    expect(eventMatchesThreadSelection(unsequenced, "transcript", {
      kind: "threads",
      threads: [{ backend: "codex", threadId: "agent-thread" }],
    })).toBe(true);
  });
});
