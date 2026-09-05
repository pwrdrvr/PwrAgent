import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import { TurnInputContent } from "../TurnInputContent";
import { TranscriptMessage } from "../TranscriptMessage";

const sender = "019f5d79-a595-73f2-84d9-a0976762c303";
const recipient = "019f5d79-a595-73f2-84d9-a0976762c304";

describe("correspondence navigation", () => {
  it("opens a queued message's source anchor even before its navigation row is loaded", () => {
    const onShowThread = vi.fn();
    render(<ThreadLinkProvider onShowThread={onShowThread} threads={[]}>
      <TurnInputContent input={[{ type: "text", text: "# Queue content" }]}
        origin={{ kind: "agent", sourceThread: { backend: "codex", threadId: sender, messageId: "correspondence:one", title: "Source thread" } }} />
    </ThreadLinkProvider>);
    const link = screen.getByRole("button", { name: /Source thread/ });
    link.focus();
    expect(link).toHaveFocus();
    fireEvent.click(link);
    expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: sender, messageId: "correspondence:one" }));
  });

  it("opens a sender breadcrumb's destination message through the common transcript renderer", () => {
    const onShowThread = vi.fn();
    render(<ThreadLinkProvider onShowThread={onShowThread} threads={[{
      id: recipient, source: "codex", title: "Destination", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    }]}>
      <TranscriptMessage parentThreadId={sender} skills={[]} message={{ type: "message", id: "correspondence:one", role: "assistant", origin: { kind: "pwragent" }, text: `**Accepted for execution** · To [Destination](pwragent://thread/${recipient}?backend=codex&messageId=user%3Aturn-1)\n\nFull outgoing content.` }} />
    </ThreadLinkProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Destination/ }));
    expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: recipient, messageId: "user:turn-1" }));
  });
});
