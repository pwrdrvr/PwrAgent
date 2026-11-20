import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { combinedDeliveryInput } from "@pwragent/shared/combined-delivery";
import {
  type AppServerThreadMessageEntry,
  type AppServerThreadMessageOrigin,
  type AppServerThreadMessagePart,
} from "@pwragent/shared/contracts/normalized-app-server";
import { type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import { TranscriptMessage } from "../TranscriptMessage";

const thread = (id: string, title: string) => ({
  id, title, titleSource: "derived", source: "codex", linkedDirectories: [],
  inbox: { inInbox: true, unread: false },
}) as NavigationThreadSummary;

const members: Array<{ text: string; origin: AppServerThreadMessageOrigin; createdAt: number }> = [
  {
    text: "Migration 0018 is applied in production and the feature is dormant.",
    origin: { kind: "agent", sourceThread: { backend: "codex", threadId: "lane-d", title: "Lane D" } },
    createdAt: Date.UTC(2026, 10, 18, 0, 5, 12),
  },
  {
    text: "Release-inputs PR is open; waiting on the dry run.",
    origin: { kind: "agent", sourceThread: { backend: "codex", threadId: "lane-a", title: "Lane A" } },
    createdAt: Date.UTC(2026, 10, 18, 0, 5, 13),
  },
  {
    text: "PR #12 checks passed on head abc.",
    origin: { kind: "pwragent", prAutomation: { kind: "watch", prKey: "github.com/acme/release#12", prNumber: 12, headSha: "abc" } },
    createdAt: Date.UTC(2026, 10, 18, 0, 5, 14),
  },
];

function delivery(layout: "items" | "merged"): AppServerThreadMessageEntry {
  const input = combinedDeliveryInput(members.map((member) => ({
    input: [{ type: "text", text: member.text }],
    messageOrigin: member.origin,
    createdAt: member.createdAt,
  })));
  const texts = input.flatMap((item) => item.type === "text" ? [item.text] : []);
  const parts: AppServerThreadMessagePart[] = layout === "items"
    ? texts.map((text) => ({ type: "text", text }))
    : [{ type: "text", text: texts.join("\n") }];
  return {
    type: "message",
    id: "delivery",
    role: "user",
    text: texts.join("\n"),
    parts,
    createdAt: Date.UTC(2026, 10, 18, 0, 5, 15),
    origin: {
      kind: "agent",
      deliveredMessages: members.map((member) => ({ origin: member.origin, receivedAt: member.createdAt, inputItemCount: 1 })),
    },
  };
}

function renderDelivery(message: AppServerThreadMessageEntry) {
  const onShowThread = vi.fn();
  const view = render(
    <ThreadLinkProvider onShowThread={onShowThread} threads={[thread("lane-d", "Lane D"), thread("lane-a", "Lane A")]}>
      <TranscriptMessage parentThreadId="parent" parentThreadBackend="codex" skills={[]} message={message} />
    </ThreadLinkProvider>,
  );
  return { ...view, onShowThread };
}

describe("a combined delivery in the transcript", () => {
  it.each(["items", "merged"] as const)("shows one bubble with each sender's own provenance (%s)", (layout) => {
    const { container, onShowThread } = renderDelivery(delivery(layout));
    expect(container.querySelectorAll(".transcript-message--delivery")).toHaveLength(1);
    expect(screen.getByText("Delivered together · 3")).toBeInTheDocument();
    expect(container.querySelectorAll(".transcript-delivery__member")).toHaveLength(3);
    expect(screen.getAllByText("From thread")).toHaveLength(2);
    expect(screen.getByText("github.com/acme/release#12")).toBeInTheDocument();
    // Agent messages show their text; the PR watch wake keeps its own
    // summary, as it does when it arrives alone.
    for (const member of members.slice(0, 2)) expect(screen.getAllByText(member.text)).toHaveLength(1);
    // PwrAgent's framing lines for the model are not shown.
    expect(container.textContent).not.toContain("delivered together. Each starts");
    expect(container.textContent).not.toContain("Message 1 of 3");
    // Each sender's thread chip opens that sender's thread.
    fireEvent.click(screen.getByRole("button", { name: "Open thread Lane A" }));
    expect(onShowThread).toHaveBeenCalledWith({ backend: "codex", threadId: "lane-a" });
    fireEvent.click(screen.getByRole("button", { name: "Open thread Lane D" }));
    expect(onShowThread).toHaveBeenCalledWith({ backend: "codex", threadId: "lane-d" });
  });

  it("copies each section's sender and text, not the framing written for the model", async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    render(
      <ThreadLinkProvider onShowThread={vi.fn()} threads={[thread("lane-d", "Lane D"), thread("lane-a", "Lane A")]}>
        <TranscriptMessage parentThreadId="parent" parentThreadBackend="codex" skills={[]} desktopApi={{ copyText }} message={delivery("items")} />
      </ThreadLinkProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Copy message" })[0]!);
    });
    expect(copyText).toHaveBeenCalledWith([
      `From thread · Lane D\n${members[0]!.text}`,
      `From thread · Lane A\n${members[1]!.text}`,
      `PwrAgent · github.com/acme/release#12\n${members[2]!.text}`,
    ].join("\n\n"));
  });

  it("shows a delivery without the recorded layout as one message", () => {
    const message = delivery("items");
    const { container } = renderDelivery({ ...message, origin: { kind: "agent" } });
    expect(container.querySelector(".transcript-message--delivery")).not.toBeInTheDocument();
    expect(container.textContent).toContain("Message 1 of 3");
  });
});
