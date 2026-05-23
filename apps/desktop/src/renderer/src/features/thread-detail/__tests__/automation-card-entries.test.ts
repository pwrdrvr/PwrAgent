import { describe, expect, it } from "vitest";
import type { AppServerThreadEntry } from "@pwragent/shared";
import {
  buildAutomationCardActivityEntries,
  injectAutomationCards,
} from "../automation-card-entries";

describe("automation-card-entries", () => {
  it("builds source-labeled automation activity entries", () => {
    expect(
      buildAutomationCardActivityEntries([
        {
          id: "automation-card:run-1",
          backend: "codex",
          threadId: "thread-1",
          automationId: "automation-1",
          automationName: "Inbox watch",
          runId: "run-1",
          status: "completed",
          summary: "Inbox watch: nothing urgent",
          details: "No unread priority messages.",
          occurredAt: 1_000,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "automation-card-run-1",
        summary: "Automation - Inbox watch: nothing urgent",
        createdAt: 1_000,
        status: "completed",
        details: [
          expect.objectContaining({ label: "No unread priority messages." }),
          expect.objectContaining({ label: "Source: Inbox watch" }),
          expect.objectContaining({ label: "Run status: completed" }),
        ],
      }),
    ]);
  });

  it("injects cards after existing entries with the same timestamp", () => {
    const entries: AppServerThreadEntry[] = [
      {
        type: "message",
        id: "message-1",
        role: "assistant",
        text: "Existing message.",
        createdAt: 1_000,
      },
    ];

    expect(
      injectAutomationCards(entries, [
        {
          id: "automation-card:run-1",
          backend: "codex",
          threadId: "thread-1",
          automationId: "automation-1",
          automationName: "Inbox watch",
          runId: "run-1",
          status: "failed",
          summary: "Inbox watch: failed",
          occurredAt: 1_000,
        },
      ]).map((entry) => entry.id),
    ).toEqual(["message-1", "automation-card-run-1"]);
  });
});
