import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragnt/shared";
import { Sidebar } from "../Sidebar";

const backends: BackendSummary[] = [
  {
    kind: "codex",
    label: "Codex app server",
    available: true,
    methods: ["thread/start"],
    capabilities: {
      listThreads: true,
      createThread: true,
      resumeThread: true,
      readThread: true,
      startTurn: true,
      interruptTurn: true,
      steerTurn: true,
      transcriptPagination: true,
      toolUse: false,
      approvalRequests: false,
      multiDirectoryThreads: true,
    },
    executionModes: [
      {
        mode: "default",
        label: "Default Access",
        available: true,
        isDefault: true,
      },
      {
        mode: "full-access",
        label: "Full Access",
        available: true,
      },
    ],
  },
  {
    kind: "grok",
    label: "Grok app server",
    available: false,
    methods: [],
    capabilities: {
      listThreads: false,
      createThread: false,
      resumeThread: false,
      readThread: false,
      startTurn: false,
      interruptTurn: false,
      steerTurn: false,
      transcriptPagination: false,
      toolUse: false,
      approvalRequests: false,
      multiDirectoryThreads: false,
    },
    executionModes: [
      {
        mode: "default",
        label: "Default Access",
        available: false,
        isDefault: true,
        unavailableReason: "XAI_API_KEY is not set",
      },
    ],
    unavailableReason: "XAI_API_KEY is not set",
  },
];

const sharedThread = {
  id: "thread-1",
  title: "Cross-project cleanup",
  summary: "Line up the desktop shell with the app server",
  source: "codex" as const,
  gitBranch: "codex/thread-centric-ui",
  updatedAt: Date.now(),
  inbox: {
    inInbox: true,
    reason: "new-thread" as const
  },
  linkedDirectories: [
    {
      id: "dir-a",
      label: "PwrAgnt",
      path: "/Users/huntharo/pwrdrvr/PwrAgnt",
      worktreePath: "/Users/huntharo/.codex/worktrees/0f38/PwrAgnt",
      kind: "local" as const
    },
    {
      id: "dir-b",
      label: "openclaw-codex-app-server",
      path: "/Users/huntharo/pwrdrvr/openclaw-codex-app-server",
      kind: "worktree" as const
    }
  ]
};

describe("Sidebar", () => {
  it("keeps Inbox first and groups a thread under each linked directory lens", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        fetchedAt={Date.now()}
        inboxThreads={[sharedThread]}
        loading={false}
        creatingThread={undefined}
        refreshing={false}
        selectedThreadKey="codex:thread-1"
        threads={[
          sharedThread,
          {
            id: "thread-2",
            title: "Unlinked planning thread",
            summary: undefined,
            source: "codex",
            updatedAt: Date.now(),
            inbox: {
              inInbox: false
            },
            linkedDirectories: []
          }
        ]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onRefresh={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["Inbox", "Browse"]);
    expect(screen.getByRole("button", { name: "directories" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("heading", { level: 3, name: "PwrAgnt" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 3, name: "openclaw-codex-app-server" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 3, name: "No linked directory" })
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("heading", { level: 3, name: "PwrAgnt" })).getByText("📁")
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Cross-project cleanup/i }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
  });

  it("copies a linked directory path from the recents chip", () => {
    const copyText = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        copyText
      }
    });

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        fetchedAt={Date.now()}
        inboxThreads={[sharedThread]}
        loading={false}
        creatingThread={undefined}
        refreshing={false}
        selectedThreadKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onRefresh={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy path for PwrAgnt" }));

    expect(copyText).toHaveBeenCalledWith("/Users/huntharo/pwrdrvr/PwrAgnt");
  });

  it("opens a new-thread picker with enabled and disabled backend options", async () => {
    const onCreateThread = vi.fn(async () => undefined);

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        fetchedAt={Date.now()}
        inboxThreads={[sharedThread]}
        loading={false}
        creatingThread={undefined}
        refreshing={false}
        selectedThreadKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={onCreateThread}
        onRefresh={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    expect(screen.getByRole("menu", { name: "New thread backend" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", {
        name: "Create thread with Codex in Default Access",
      })
    ).toBeEnabled();
    expect(
      screen.getByRole("menuitem", {
        name: "Create thread with Codex in Full Access",
      })
    ).toBeEnabled();
    expect(
      screen.getByRole("menuitem", {
        name: "Create thread with Grok in Default Access",
      })
    ).toBeDisabled();

    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Create thread with Codex in Default Access",
      })
    );

    expect(onCreateThread).toHaveBeenCalledWith("codex", "default");
  });
});
