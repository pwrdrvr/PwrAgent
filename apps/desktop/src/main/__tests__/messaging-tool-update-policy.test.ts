import { describe, expect, it, vi } from "vitest";
import { MessagingToolUpdatePolicy } from "../messaging/core/messaging-tool-update-policy";
import type { MessagingToolActivity } from "../messaging/core/messaging-tool-activity";

describe("MessagingToolUpdatePolicy", () => {
  it("delivers the first three Show Some updates individually", () => {
    const policy = new MessagingToolUpdatePolicy({ now: () => 1000 });

    expect(processTitles(policy, "show_some", ["one", "two", "three"]))
      .toEqual([
        { kind: "individual", titles: ["one"] },
        { kind: "individual", titles: ["two"] },
        { kind: "individual", titles: ["three"] },
      ]);
  });

  it("batches Show Some updates after the quiet threshold", () => {
    const policy = new MessagingToolUpdatePolicy({ now: () => 1000 });

    expect(processTitles(policy, "show_some", ["one", "two", "three", "four"]))
      .toEqual([
        { kind: "individual", titles: ["one"] },
        { kind: "individual", titles: ["two"] },
        { kind: "individual", titles: ["three"] },
      ]);
    expect(policy.flush()).toEqual([
      expect.objectContaining({
        kind: "batch",
        activities: [expect.objectContaining({ title: "four" })],
      }),
    ]);
  });

  it("uses a 15-second Show More timer and higher threshold", () => {
    let timerDelay: number | undefined;
    const policy = new MessagingToolUpdatePolicy({
      now: () => 1000,
      setTimer: vi.fn((callback, delayMs) => {
        timerDelay = delayMs;
        return setTimeout(callback, delayMs);
      }),
    });

    expect(processTitles(policy, "show_more", ["one", "two", "three", "four", "five"]))
      .toHaveLength(5);
    expect(processTitles(policy, "show_more", ["six"])).toEqual([]);
    expect(timerDelay).toBe(15_000);
  });

  it("keeps Show Less batched until flush", () => {
    const policy = new MessagingToolUpdatePolicy({ now: () => 1000 });

    expect(processTitles(policy, "show_less", ["one", "two"])).toEqual([]);
    expect(policy.flush()).toEqual([
      expect.objectContaining({
        kind: "batch",
        activities: [
          expect.objectContaining({ title: "one" }),
          expect.objectContaining({ title: "two" }),
        ],
      }),
    ]);
  });

  it("delivers every Show All update immediately", () => {
    const policy = new MessagingToolUpdatePolicy({ now: () => 1000 });

    expect(processTitles(policy, "show_all", ["one", "two"])).toEqual([
      { kind: "individual", titles: ["one"] },
      { kind: "individual", titles: ["two"] },
    ]);
  });

  it("suppresses Show None updates", () => {
    const policy = new MessagingToolUpdatePolicy({ now: () => 1000 });

    expect(processTitles(policy, "show_none", ["one", "two"])).toEqual([]);
    expect(policy.flush()).toEqual([]);
  });

  it("flushes pending batches exactly once", () => {
    const policy = new MessagingToolUpdatePolicy({ now: () => 1000 });
    processTitles(policy, "show_less", ["one"]);

    expect(policy.flush()).toHaveLength(1);
    expect(policy.flush()).toEqual([]);
  });

  it("isolates bindings and ignores duplicate item ids", () => {
    const policy = new MessagingToolUpdatePolicy({ now: () => 1000 });
    const duplicate = activity("same-id", "same");

    expect(
      policy.processActivity({
        activity: duplicate,
        bindingId: "binding-1",
        mode: "show_all",
        turnId: "turn-1",
      }),
    ).toHaveLength(1);
    expect(
      policy.processActivity({
        activity: duplicate,
        bindingId: "binding-1",
        mode: "show_all",
        turnId: "turn-1",
      }),
    ).toHaveLength(0);

    processTitles(policy, "show_less", ["one"], "binding-1");
    processTitles(policy, "show_less", ["two"], "binding-2");

    expect(policy.flush({ bindingId: "binding-1" })).toEqual([
      expect.objectContaining({
        bindingId: "binding-1",
        activities: [expect.objectContaining({ title: "one" })],
      }),
    ]);
    expect(policy.flush({ bindingId: "binding-2" })).toEqual([
      expect.objectContaining({
        bindingId: "binding-2",
        activities: [expect.objectContaining({ title: "two" })],
      }),
    ]);
  });
});

function processTitles(
  policy: MessagingToolUpdatePolicy,
  mode: Parameters<MessagingToolUpdatePolicy["processActivity"]>[0]["mode"],
  titles: string[],
  bindingId = "binding-1",
) {
  return titles.flatMap((title, index) =>
    policy.processActivity({
      activity: activity(`${bindingId}-${title}-${index}`, title),
      bindingId,
      mode,
      turnId: "turn-1",
    }).map((delivery) => ({
      kind: delivery.kind,
      titles: delivery.activities.map((item) => item.title),
    })),
  );
}

function activity(id: string, title: string): MessagingToolActivity {
  return {
    id,
    kind: "command",
    status: "completed",
    title,
  };
}
