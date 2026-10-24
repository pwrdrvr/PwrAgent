import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import { TurnInputContent } from "../TurnInputContent";
import { ImageGalleryLayer } from "../ImageGalleryLayer";
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
    act(() => {
      link.focus();
    });
    expect(link).toHaveFocus();
    fireEvent.click(link);
    expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: sender, messageId: "correspondence:one" }));
  });

  it("opens a sender breadcrumb's destination message through the common transcript renderer", () => {
    const onShowThread = vi.fn();
    render(<ThreadLinkProvider onShowThread={onShowThread} threads={[{
      id: recipient, source: "codex", title: "Destination", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    }]}>
      <TranscriptMessage parentThreadId={sender} skills={[]} message={{ type: "message", id: "correspondence:one", role: "assistant", origin: { kind: "pwragent", systemReason: "thread-correspondence" }, text: `**Message to [Destination](pwragent://thread/${recipient}?backend=codex&messageId=user%3Aturn-1)** · Receiving thread started work\n\nFull outgoing content.` }} />
    </ThreadLinkProvider>);
    expect(screen.getByText("Thread delivery")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Destination/ }));
    expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: recipient, messageId: "user:turn-1" }));
  });

  it("identifies a received prompt as coming from another thread", () => {
    render(<TranscriptMessage parentThreadId={recipient} skills={[]} message={{
      type: "message", id: "received-one", role: "user", text: "Please check the query name.",
      origin: { kind: "agent", sourceThread: { backend: "codex", threadId: sender, title: "Source thread" } },
    }} />);
    expect(screen.getByText("From thread")).toBeInTheDocument();
    expect(screen.getByText("Source thread")).toBeInTheDocument();
  });
});

describe("queued message images", () => {
  it("pages between the message's images in one lightbox", () => {
    render(<>
      <TurnInputContent input={[
        { type: "text", text: "Two screenshots" },
        { type: "image", url: "data:image/png;base64,QQ==", name: "first.png" },
        { type: "image", url: "data:image/png;base64,Qg==", name: "second.png" },
      ]} />
      <ImageGalleryLayer />
    </>);

    fireEvent.click(screen.getByRole("button", { name: /Expand transcript image 3/ }));
    const dialog = screen.getByRole("dialog", { name: "Expanded image" });
    expect(within(dialog).getByText("Image 2 of 2")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Next image" }))
      .toHaveAttribute("aria-disabled", "true");

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(within(dialog).getByText("Image 1 of 2")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the lightbox open and paging after the message leaves", () => {
    const view = render(<>
      <TurnInputContent input={[
        { type: "image", url: "data:image/png;base64,QQ==", name: "first.png" },
        { type: "image", url: "data:image/png;base64,Qg==", name: "second.png" },
      ]} />
      <ImageGalleryLayer />
    </>);

    fireEvent.click(screen.getByRole("button", { name: /Expand transcript image 1/ }));
    // The message is sent: the view that opened the lightbox unmounts.
    view.rerender(<ImageGalleryLayer />);

    const dialog = screen.getByRole("dialog", { name: "Expanded image" });
    expect(within(dialog).getByText("Image 1 of 2")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(within(dialog).getByText("Image 2 of 2")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
