import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationDirectorySummary, NavigationThreadSummary } from "@pwragent/shared";
import { useIntegratedTerminals } from "../../../lib/useIntegratedTerminals";
import { useThreadNavigation } from "../../../lib/useThreadNavigation";
import { navigationOwnerApiFixture } from "../../../test/navigation-owner-api-fixture";
import { ThreadView as ThreadViewWithTerminals, type ThreadViewProps } from "../ThreadView";

function ThreadView(props: Omit<ThreadViewProps, "terminals">): ReactElement {
  const terminals = useIntegratedTerminals(props.desktopApi);
  return <ThreadViewWithTerminals {...props} terminals={terminals} />;
}

const baseProps: Omit<ThreadViewProps, "terminals"> = {
  addOptimisticUserMessage: () => "optimistic-1",
  backends: [],
  clearPendingRequest: () => undefined,
  composerDisabled: true,
  loading: false,
  loadingMore: false,
  messageCount: 0,
  onLoadOlder: async () => undefined,
  removeOptimisticMessage: () => undefined,
  skills: [],
  transcriptEntries: [],
};

function thread(id: string, label: string): NavigationThreadSummary {
  return {
    id, source: "codex", title: `Thread ${id}`, titleSource: "explicit",
    updatedAt: id === "first" ? 2 : 1,
    linkedDirectories: [{ id: `project-${label}`, kind: "local", label, path: `/repo/${label}` }],
    inbox: { inInbox: true },
  };
}

function directory(label: string): NavigationDirectorySummary {
  return {
    key: `directory:/repo/${label}`, kind: "directory", label, path: `/repo/${label}`,
    threadKeys: [], needsAttentionCount: 0,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThreadView project breadcrumb", () => {
  it.each(["Catalog", "Inventory"])("shows %s immediately while the next thread's owner detail is pending", async (nextLabel) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const first = thread("first", "Catalog");
    const second = thread("second", nextLabel);
    const ownerApi = navigationOwnerApiFixture({
      readPopulation: async () => ({
        backend: "all", fetchedAt: 1, unchanged: false, threads: [first, second],
        directories: nextLabel === "Catalog" ? [directory("Catalog")] : [directory("Catalog"), directory(nextLabel)],
        inboxThreadKeys: ["codex:first", "codex:second"],
        launchpadDefaults: { backend: "codex", executionMode: "default" },
      }),
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const readDetail = vi.fn<NonNullable<typeof ownerApi.getNavigationSelectedDetail>>(async (request, consumer) => {
      if (request.ref.threadId === second.id) await pending;
      return ownerApi.getNavigationSelectedDetail!(request, consumer);
    });
    const api = { ...ownerApi, getNavigationSelectedDetail: readDetail };
    function Harness() {
      const navigation = useThreadNavigation(api);
      return (
        <>
          <button onClick={() => navigation.selectThread(second)}>Select second</button>
          <output aria-label="Configuration ready">{String(navigation.selectedThreadConfigurationReady)}</output>
          <ThreadView
            {...baseProps}
            selectedDirectory={navigation.selectedDirectory}
            selectedThread={navigation.selectedThread}
          />
        </>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText("Configuration ready")).toHaveTextContent("true"));
    expect(within(screen.getByRole("banner")).getByText("Catalog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select second" }));
    try {
      expect(screen.getByRole("heading", { name: second.title })).toBeInTheDocument();
      expect(screen.getByLabelText("Configuration ready")).toHaveTextContent("false");
      // No waitFor: the breadcrumb must be present before owner detail resolves.
      expect(within(screen.getByRole("banner")).getByText(nextLabel)).toBeInTheDocument();
      if (nextLabel !== "Catalog") {
        expect(within(screen.getByRole("banner")).queryByText("Catalog")).not.toBeInTheDocument();
      }
    } finally {
      await act(async () => { release(); await pending; });
    }
    await waitFor(() => expect(screen.getByLabelText("Configuration ready")).toHaveTextContent("true"));
    expect(within(screen.getByRole("banner")).getByText(nextLabel)).toBeInTheDocument();
  });

  it.each(["local", "remote"])("shows the primary linked project on the first %s render without a directory summary", (scope) => {
    const selectedThread = thread("first", "Catalog");
    if (scope === "remote") {
      selectedThread.federation = {
        ref: { backend: "codex", threadId: selectedThread.id, target: { scope: "remote", instanceId: "fixture-peer" } },
        instanceLabel: "Fixture peer",
      };
    }
    selectedThread.linkedDirectories.push(...thread("secondary", "Inventory").linkedDirectories);
    render(<ThreadView {...baseProps} selectedThread={selectedThread} />);
    const header = within(screen.getByRole("banner"));
    expect(header.getByText("Catalog")).toBeInTheDocument();
    expect(header.queryByText("Inventory")).not.toBeInTheDocument();
  });

  it("uses the directory summary label when it arrives", () => {
    const selectedThread = thread("first", "Catalog");
    const view = render(<ThreadView {...baseProps} selectedThread={selectedThread} />);
    view.rerender(
      <ThreadView {...baseProps} selectedThread={selectedThread} selectedDirectory={{ ...directory("Catalog"), label: "Catalog service" }} />,
    );
    const header = within(screen.getByRole("banner"));
    expect(header.getByText("Catalog service")).toBeInTheDocument();
    expect(header.queryByText("Catalog")).not.toBeInTheDocument();
  });

  it("clears the project when switching to a directory-less thread", () => {
    const view = render(<ThreadView {...baseProps} selectedThread={thread("first", "Catalog")} selectedDirectory={directory("Catalog")} />);
    view.rerender(<ThreadView {...baseProps} selectedThread={{ ...thread("second", "Inventory"), linkedDirectories: [] }} />);
    expect(screen.getByRole("heading", { name: "Thread second" })).toBeInTheDocument();
    expect(within(screen.getByRole("banner")).queryByText("Catalog")).not.toBeInTheDocument();
    expect(within(screen.getByRole("banner")).queryByText("Inventory")).not.toBeInTheDocument();
  });
});
