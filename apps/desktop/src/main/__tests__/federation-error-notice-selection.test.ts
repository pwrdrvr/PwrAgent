import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { describe, expect, it } from "vitest";
import { FederationAccountingStream } from "../federation/federation-event-stream";
import {
  eventMatchesThreadSelection,
  navigationInvalidationForLocalEvent,
  projectLocalEventForFederation,
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

  it("keeps local PR aliases off compact, sequenced and legacy peer events", () => {
    const event: AgentEvent = { backend: "codex", navigationPullRequestKeyAliases: ["github.com/fixture/old#42"],
      notification: { method: "pullRequest/status/updated", params: { prKey: "github.com/fixture/new#42",
        pr: { provider: "github.com", org: "fixture", repo: "new", number: 42, state: "passing", url: "https://github.com/fixture/new/pull/42" } } },
    };
    const federated = projectLocalEventForFederation(event, "owner");
    const sequenced = new FederationAccountingStream().encode(federated, { epoch: "scope", sequence: 1 });
    for (const payload of [navigationInvalidationForLocalEvent(event), sequenced, unsequencedFederationEventPayload(federated)]) {
      expect(payload).toBeDefined();
      expect(JSON.stringify(payload)).not.toContain("github.com/fixture/old#42");
    }
  });

  it("preserves a native review terminal's related turn ID across both transports", () => {
    const event: AgentEvent = {
      backend: "codex",
      relatedReviewTurnId: "interrupt",
      notification: { method: "turn/completed", params: {
        threadId: "thread", turnId: "review", turn: { id: "review", status: "completed", output: [] },
      } },
    };
    const federated = projectLocalEventForFederation(event, "owner");
    const stream = new FederationAccountingStream();
    const sequenced = stream.encode(federated, { epoch: "review", sequence: 1 });
    for (const received of [stream.decode(sequenced), unsequencedFederationEventPayload(federated)]) {
      expect(received).toMatchObject({
        relatedReviewTurnId: "interrupt",
        notification: { params: { turnId: "review" } },
      });
    }
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
