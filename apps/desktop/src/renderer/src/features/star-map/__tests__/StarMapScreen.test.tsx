import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";

function buildDesktopApi(): DesktopApi {
  return {
    readFederationHealth: vi.fn(async () => ({
      health: {
        enabled: false,
        role: "client" as const,
        status: "disabled" as const,
        instanceId: "pwr_local",
        localCelestialIcon: "sun" as const,
        peers: [],
      },
    })),
    onAgentEvent: vi.fn(() => () => undefined),
  };
}

function unreadThread(id: string): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "generated",
    linkedDirectories: [
      {
        id: "dir-1",
        label: "PwrSnap",
        path: "/tmp/pwrsnap",
        kind: "worktree",
      },
    ],
    source: "codex",
    inbox: { inInbox: true, reason: "updated-since-seen" },
    updatedAt: 100,
  } as unknown as NavigationThreadSummary;
}

describe("StarMapScreen", () => {
  it("renders the single-instance map with attention cards sans Local/Worktree labels", async () => {
    const desktopApi = buildDesktopApi();
    const onOpenLocalThread = vi.fn();
    render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[unreadThread("t1")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={onOpenLocalThread}
        onFocusLocalInstance={() => undefined}
      />,
    );

    expect(screen.getByRole("region", { name: "Star Map" })).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance \(Mac-Mini-M4\)/ }),
      ).toBeTruthy();
    });

    const card = screen.getByRole("button", { name: /Thread t1/ });
    expect(card.textContent).toContain("PwrSnap");
    expect(card.textContent).not.toMatch(/local/i);
    expect(card.textContent).not.toMatch(/worktree/i);

    fireEvent.click(card);
    expect(onOpenLocalThread).toHaveBeenCalledTimes(1);
  });

  it("hides cards whose categories are filtered off", async () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[unreadThread("t2")]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: /Thread t2/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unread" }));
    expect(screen.queryByRole("button", { name: /Thread t2/ })).toBeNull();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[]}
        sessionKeys={{}}
        floating={false}
        onClose={onClose}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    fireEvent.keyDown(screen.getByRole("region", { name: "Star Map" }), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
