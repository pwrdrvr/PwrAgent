import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResourceThreadRef } from "@pwragent/shared/contracts/resource-checkouts";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import { ResourceThreadChip } from "../ResourceThreadChip";

afterEach(cleanup);

const LOCAL = "inst-default";
const peerThread: ResourceThreadRef = {
  backend: "codex", threadId: "dev-thread", title: "Shard renderer tests",
  instanceId: "inst-dev", instanceLabel: "studio · dev",
};

describe("ResourceThreadChip", () => {
  // Rule: every control the chip shows does something. The Resources window
  // has no thread links, so a pop-out there could never open a remote viewer.
  it("offers no remote viewer without thread links, and opens the full reference", () => {
    const onOpen = vi.fn();
    render(<ResourceThreadChip thread={peerThread} localInstanceId={LOCAL} onOpen={onOpen} />);
    expect(screen.queryByRole("button", { name: /Open remote viewer/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open thread Shard renderer tests" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(peerThread);
  });

  // Rule: a peer's chip names the peer as people know it, not by its id.
  it("names a peer's unloaded thread by its owner's label in the main window", () => {
    render(
      <ThreadLinkProvider threads={[]} localInstanceId={LOCAL} onShowThread={() => undefined}>
        <ResourceThreadChip thread={peerThread} localInstanceId={LOCAL} />
      </ThreadLinkProvider>,
    );
    expect(screen.getByRole("button", { name: "Open remote viewer for studio · dev" })).toBeInTheDocument();
  });

  it("reads this instance's own thread as a local link", () => {
    render(
      <ThreadLinkProvider threads={[]} localInstanceId={LOCAL} onShowThread={() => undefined}>
        <ResourceThreadChip thread={{ ...peerThread, instanceId: LOCAL, instanceLabel: "studio · default" }} localInstanceId={LOCAL} />
      </ThreadLinkProvider>,
    );
    expect(screen.getByRole("button", { name: "Open thread Shard renderer tests" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open remote viewer/ })).not.toBeInTheDocument();
  });
});
