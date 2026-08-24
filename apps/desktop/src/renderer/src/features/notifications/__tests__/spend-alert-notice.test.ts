import { describe, expect, it } from "vitest";
import { buildSpendAlertNotice } from "../spend-alert-notice";

describe("spend alert notice", () => {
  it("describes active-turn spend against its configured threshold", () => {
    const notice = buildSpendAlertNotice({
      alert: {
        alertId: "spend-alert:active-turn:codex:thread-1:turn-2:5000000",
        createdAt: 1_800_000_000_000,
        currency: "USD",
        kind: "active-turn-spend",
        spendMicros: 5_250_000,
        threadId: "thread-1",
        thresholdMicros: 5_000_000,
        turnId: "turn-2",
      },
      backend: "codex",
    });

    expect(notice).toMatchObject({
      autoDismiss: false,
      coalescing: {
        key: "thread-cost:local:codex:thread-1",
        priority: 1,
      },
      dismissGroup: {
        key: "thread-cost",
        label: "cost notices",
      },
      message: expect.stringContaining("$5.25"),
      title: "Active turn spend threshold reached",
      tone: "warning",
    });
    expect(notice.message).toContain("$5.00 threshold");
  });

  it("describes total thread spend", () => {
    const notice = buildSpendAlertNotice({
      alert: {
        alertId: "spend-alert:thread:codex:thread-1:25000000",
        createdAt: 1_800_000_000_000,
        currency: "USD",
        kind: "thread-spend",
        spendMicros: 31_000_000,
        threadId: "thread-1",
        thresholdMicros: 25_000_000,
      },
      backend: "codex",
      instanceId: "peer-a",
    });

    expect(notice).toMatchObject({
      coalescing: {
        key: "thread-cost:remote:peer-a:codex:thread-1",
        priority: 2,
      },
      id: "thread-cost-notice:remote:peer-a:spend-alert:thread:codex:thread-1:25000000",
      message: expect.stringContaining("$31.00"),
      title: "Thread spend threshold reached",
    });
  });
});
