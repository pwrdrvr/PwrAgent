import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useIntegratedTerminals } from "../../../lib/useIntegratedTerminals";
import {
  ThreadView as ThreadViewWithTerminals,
  type ThreadViewProps,
} from "../ThreadView";

function ThreadView(props: Omit<ThreadViewProps, "terminals">): ReactElement {
  const terminals = useIntegratedTerminals(props.desktopApi);
  return <ThreadViewWithTerminals {...props} terminals={terminals} />;
}

afterEach(() => {
  cleanup();
});

const directory = {
  key: "directory:/repo",
  kind: "directory",
  label: "Repo",
  path: "/repo",
  threadKeys: [],
  needsAttentionCount: 0,
} satisfies NavigationDirectorySummary;

const launchpad = {
  backend: "codex",
  createdAt: 1_000,
  directoryKey: directory.key,
  directoryKind: directory.kind,
  directoryLabel: directory.label,
  directoryPath: directory.path,
  executionMode: "default",
  prompt: "",
  updatedAt: 1_000,
  workMode: "local",
} satisfies NavigationLaunchpadDraft;

const desktopApi: DesktopApi = {
  listMcpConnections: async () => ({ connections: [] }),
  readPwrSnapConnectionStatus: async () => ({
    connectionId: "pwrsnap" as const,
    displayName: "PwrSnap" as const,
    availability: "running" as const,
    configured: false,
  }),
};

function launchpadView(props: Partial<ThreadViewProps>): ReactElement {
  return (
    <ThreadView
      addOptimisticUserMessage={() => "optimistic-1"}
      backends={[]}
      clearPendingRequest={() => undefined}
      composerDisabled={false}
      contextRailPinned
      desktopApi={desktopApi}
      loading={false}
      loadingMore={false}
      messageCount={0}
      selectedDirectory={directory}
      selectedLaunchpad={launchpad}
      skills={[]}
      transcriptEntries={[]}
      onLoadOlder={async () => undefined}
      removeOptimisticMessage={() => undefined}
      {...props}
    />
  );
}

function renderLaunchpad(props: Partial<ThreadViewProps>) {
  return render(launchpadView(props));
}

describe("ThreadView launchpad connections dock", () => {
  it("moves the connection cards from the launchpad to the rail", async () => {
    const onDockChange = vi.fn();
    const view = renderLaunchpad({
      launchpadConnectionsDock: "launchpad",
      onLaunchpadConnectionsDockChange: onDockChange,
    });
    const group = screen.getByRole("group", { name: "Connections" });
    expect(
      await within(group).findByRole("button", { name: "Connect to PwrSnap" }),
    ).toBeInTheDocument();
    // Only the launchpad offers the cards; the rail has no tab for them yet.
    expect(screen.queryByRole("tab", { name: "Connections" })).not.toBeInTheDocument();

    // jsdom has no Element.animate, so the move commits without the flight.
    // `detail: 1` is a pointer click.
    fireEvent.click(within(group).getByRole("button", { name: "Move to sidebar" }), { detail: 1 });
    expect(onDockChange).toHaveBeenCalledExactlyOnceWith("sidebar");

    view.rerender(launchpadView({
      launchpadConnectionsDock: "sidebar",
      onLaunchpadConnectionsDockChange: onDockChange,
    }));
    expect(screen.queryByRole("group", { name: "Connections" })).not.toBeInTheDocument();
    const tab = screen.getByRole("tab", { name: "Connections" });
    // The move selects the tab it landed in and replays its arrival ring.
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveClass("is-landing");
    // A pointer move leaves focus alone, so an unpinned rail is not revealed.
    expect(tab).not.toHaveFocus();
    // The ring plays once per move, not on every remount of the tab.
    // jsdom has no AnimationEvent constructor, so React registers the
    // legacy event name there.
    fireEvent(tab, new Event(
      "AnimationEvent" in window ? "animationend" : "webkitAnimationEnd",
      { bubbles: true },
    ));
    expect(tab).not.toHaveClass("is-landing");
    const rail = screen.getByRole("complementary", { name: "New thread context" });
    await waitFor(() => {
      expect(within(rail).getByLabelText("PwrSnap connection")).toBeInTheDocument();
    });
    // The cards keep their controls in the rail.
    expect(
      await within(rail).findByRole("button", { name: "Connect to PwrSnap" }),
    ).toBeInTheDocument();

    fireEvent.click(within(rail).getByRole("button", { name: "Show on new thread" }));
    expect(onDockChange).toHaveBeenLastCalledWith("launchpad");
  });

  it("hands keyboard focus to wherever the cards went", async () => {
    const onDockChange = vi.fn();
    const view = renderLaunchpad({
      launchpadConnectionsDock: "launchpad",
      onLaunchpadConnectionsDockChange: onDockChange,
    });
    const group = screen.getByRole("group", { name: "Connections" });
    await within(group).findByRole("button", { name: "Connect to PwrSnap" });
    // A button activated from the keyboard reports a click with detail 0.
    fireEvent.click(within(group).getByRole("button", { name: "Move to sidebar" }), { detail: 0 });
    view.rerender(launchpadView({
      launchpadConnectionsDock: "sidebar",
      onLaunchpadConnectionsDockChange: onDockChange,
    }));
    expect(screen.getByRole("tab", { name: "Connections" })).toHaveFocus();

    const rail = screen.getByRole("complementary", { name: "New thread context" });
    await within(rail).findByRole("button", { name: "Connect to PwrSnap" });
    fireEvent.click(within(rail).getByRole("button", { name: "Show on new thread" }), { detail: 0 });
    view.rerender(launchpadView({
      launchpadConnectionsDock: "launchpad",
      onLaunchpadConnectionsDockChange: onDockChange,
    }));
    expect(screen.getByRole("button", { name: "Move to sidebar" })).toHaveFocus();
    await screen.findByRole("button", { name: "Connect to PwrSnap" });
  });

  it("keeps the cards in the rail when the stored choice is the sidebar", async () => {
    renderLaunchpad({
      launchpadConnectionsDock: "sidebar",
      onLaunchpadConnectionsDockChange: vi.fn(),
    });
    expect(screen.queryByRole("group", { name: "Connections" })).not.toBeInTheDocument();
    const tab = screen.getByRole("tab", { name: "Connections" });
    // A stored dock is not a move: no arrival ring at launch.
    expect(tab).not.toHaveClass("is-landing");
    // Let the card's status read land before leaving the tab.
    expect(
      await screen.findByRole("button", { name: "Connect to PwrSnap" }),
    ).toBeInTheDocument();
    // The provider tab is still one click away.
    fireEvent.click(screen.getByRole("tab", { name: "AI provider info" }));
    expect(screen.getByRole("tab", { name: "AI provider info" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("renders the cards nowhere until the stored choice is known", () => {
    renderLaunchpad({
      launchpadConnectionsDock: "pending",
      onLaunchpadConnectionsDockChange: vi.fn(),
    });
    expect(screen.queryByRole("group", { name: "Connections" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Connections" })).not.toBeInTheDocument();
  });

  it("offers no move when nothing persists the choice", async () => {
    renderLaunchpad({});
    const group = screen.getByRole("group", { name: "Connections" });
    expect(
      await within(group).findByRole("button", { name: "Connect to PwrSnap" }),
    ).toBeInTheDocument();
    expect(
      within(group).queryByRole("button", { name: "Move to sidebar" }),
    ).not.toBeInTheDocument();
  });
});
