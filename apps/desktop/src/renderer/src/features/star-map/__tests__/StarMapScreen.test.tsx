import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
        localLabel: "Harold-MBP-M5-Max",
        localProfileName: "default",
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
    // Scope to the chip row: thread cards also expose an "Unread" status.
    const filterRow = screen.getByRole("group", { name: "Attention filters" });
    fireEvent.click(within(filterRow).getByRole("button", { name: /^Unread/ }));
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

  it("refocuses the layer when the floating thread closes so Escape works again", () => {
    const props = {
      desktopApi: buildDesktopApi(),
      localThreads: [],
      sessionKeys: {},
      onClose: () => undefined,
      onOpenLocalThread: () => undefined,
      onFocusLocalInstance: () => undefined,
    };
    const { rerender } = render(<StarMapScreen {...props} floating />);
    const region = screen.getByRole("region", { name: "Star Map" });
    // While the float is up, focus lives in the thread view — simulate it
    // being elsewhere, then close the float.
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(document.activeElement).not.toBe(region);
    rerender(<StarMapScreen {...props} floating={false} />);
    expect(document.activeElement).toBe(region);
  });

  it("offers a visible exit because the map covers the header toggle", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Close Star Map" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disambiguates two profiles on one machine, local included", async () => {
    const desktopApi: DesktopApi = {
      readFederationHealth: vi.fn(async () => ({
        health: {
          enabled: true,
          role: "gateway" as const,
          status: "listening" as const,
          instanceId: "pwr_local",
          localLabel: "Harold-MBP-M5-Max",
          localProfileName: "default",
          peers: [
            {
              id: "pwr_dev",
              // Same machine, different profile: raw labels collide.
              label: "Harold-MBP-M5-Max",
              profileName: "dev",
              role: "client" as const,
              status: "disconnected" as const,
              capabilities: [],
            },
          ],
        },
      })) as unknown as DesktopApi["readFederationHealth"],
      onAgentEvent: vi.fn(() => () => undefined),
    };
    render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: /Open this instance \(Harold-MBP-M5-Max \/ default\)/,
        }),
      ).toBeTruthy();
    });
    expect(
      screen.getByRole("button", {
        name: /Open remote viewer for Harold-MBP-M5-Max \/ dev/,
      }),
    ).toBeTruthy();
    // The generic placeholder must never stand in for a real instance.
    expect(screen.queryByText("This instance")).toBeNull();
  });

  it("drops the machine-name chip from cards - the lane already says which instance", async () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[
          {
            ...unreadThread("t9"),
            federation: {
              ref: {
                backend: "codex",
                target: { scope: "remote", instanceId: "pwr_peer" },
                threadId: "t9",
              },
              instanceLabel: "Harold-MBP-M2-Max",
            },
          } as unknown as NavigationThreadSummary,
        ]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Star Map" })).toBeTruthy();
    });
    expect(screen.queryByText("Harold-MBP-M2-Max")).toBeNull();
  });
});
