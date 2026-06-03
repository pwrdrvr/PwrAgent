import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ListThreadMigrationSourceThreadsResponse,
  ListThreadMigrationSourcesResponse,
  StartThreadMigrationResponse,
  ThreadMigrationSourceProjectGroup,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ThreadManagementSettings } from "../ThreadManagementSettings";

afterEach(() => {
  cleanup();
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function migrationThreadsResponse(
  sourceProfile: string,
  threadTitle: string,
): ListThreadMigrationSourceThreadsResponse {
  const project: ThreadMigrationSourceProjectGroup = {
    key: `directory:/repo/${sourceProfile || "default"}`,
    label: sourceProfile || "System default",
    path: `/repo/${sourceProfile || "default"}`,
    threads: [
      {
        sourceProfile,
        threadId: `${sourceProfile || "default"}-thread`,
        title: threadTitle,
        projectKey: `/repo/${sourceProfile || "default"}`,
        linkedDirectories: [
          {
            id: `local:/repo/${sourceProfile || "default"}`,
            label: sourceProfile || "System default",
            path: `/repo/${sourceProfile || "default"}`,
            kind: "local",
          },
        ],
      },
    ],
  };
  return {
    sourceProfile,
    fetchedAt: Date.now(),
    projects: [project],
  };
}

function migrationSourcesResponse(): ListThreadMigrationSourcesResponse {
  return {
    activeCodexProfile: "work",
    profiles: [
      {
        profile: "",
        displayName: "System default",
        codexHome: "/Users/alice/.codex",
        source: "default",
        exists: true,
        selected: false,
        available: true,
      },
      {
        profile: "personal",
        displayName: "personal",
        codexHome: "/Users/alice/.codex/profiles/personal",
        source: "directory",
        exists: true,
        selected: false,
        available: true,
      },
    ],
  };
}

describe("ThreadManagementSettings", () => {
  it("ignores stale source thread responses after switching profiles", async () => {
    const defaultThreads = createDeferred<ListThreadMigrationSourceThreadsResponse>();
    const personalThreads = createDeferred<ListThreadMigrationSourceThreadsResponse>();
    const listThreadMigrationSourceThreads = vi.fn<
      NonNullable<DesktopApi["listThreadMigrationSourceThreads"]>
    >((request) =>
      request.sourceProfile === "personal"
        ? personalThreads.promise
        : defaultThreads.promise,
    );
    const desktopApi: DesktopApi = {
      listThreadMigrationSources: vi.fn(async () => migrationSourcesResponse()),
      listThreadMigrationSourceThreads,
    };

    render(<ThreadManagementSettings desktopApi={desktopApi} />);

    await waitFor(() => {
      expect(listThreadMigrationSourceThreads).toHaveBeenCalledWith({
        archived: false,
        sourceProfile: "",
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: /personal/ }));

    await waitFor(() => {
      expect(listThreadMigrationSourceThreads).toHaveBeenCalledWith({
        archived: false,
        sourceProfile: "personal",
      });
    });

    await act(async () => {
      personalThreads.resolve(
        migrationThreadsResponse("personal", "Personal profile thread"),
      );
    });

    expect(await screen.findByText("Personal profile thread")).toBeInTheDocument();

    await act(async () => {
      defaultThreads.resolve(
        migrationThreadsResponse("", "Stale default profile thread"),
      );
    });

    expect(screen.getByText("Personal profile thread")).toBeInTheDocument();
    expect(screen.queryByText("Stale default profile thread")).not.toBeInTheDocument();
  });

  it("uses direct action buttons and tolerates threads without linked directories", async () => {
    const threadsResponse = migrationThreadsResponse("", "GIFusion thread");
    threadsResponse.projects[0]!.label = "GIFusion";
    threadsResponse.projects[0]!.path = "/Users/alice/GIPHY/GIFusion";
    threadsResponse.projects[0]!.threads[0]!.linkedDirectories = [null] as never;
    const logRendererDiagnostic = vi.fn(async () => undefined);
    const desktopApi: DesktopApi = {
      listThreadMigrationSources: vi.fn(async () => migrationSourcesResponse()),
      listThreadMigrationSourceThreads: vi.fn(async () => threadsResponse),
      logRendererDiagnostic,
    };

    render(<ThreadManagementSettings desktopApi={desktopApi} />);

    expect(await screen.findByRole("button", { name: "Move 0" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy 0" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();

    fireEvent.click((await screen.findAllByRole("checkbox", { name: /GIFusion/ }))[0]!);

    expect(screen.getByRole("button", { name: "Move 1" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy 1" })).toBeEnabled();
    expect(logRendererDiagnostic).toHaveBeenCalledWith({
      level: "warn",
      message: "Thread migration source project has malformed linked directories.",
      details: {
        malformedThreadCount: 1,
        projectKey: "directory:/repo/default",
        projectLabel: "GIFusion",
        threadCount: 1,
      },
    });
  });

  it("hides archived source threads by default and reloads when enabled", async () => {
    const listThreadMigrationSourceThreads = vi.fn<
      NonNullable<DesktopApi["listThreadMigrationSourceThreads"]>
    >(async (request) =>
      migrationThreadsResponse(
        request.sourceProfile,
        request.archived ? "Archived thread" : "Active thread",
      ),
    );
    const desktopApi: DesktopApi = {
      listThreadMigrationSources: vi.fn(async () => migrationSourcesResponse()),
      listThreadMigrationSourceThreads,
    };

    render(<ThreadManagementSettings desktopApi={desktopApi} />);

    expect(await screen.findByText("Active thread")).toBeInTheDocument();
    expect(screen.queryByText("Archived thread")).not.toBeInTheDocument();
    expect(listThreadMigrationSourceThreads).toHaveBeenLastCalledWith({
      archived: false,
      sourceProfile: "",
    });

    fireEvent.click(screen.getByLabelText("Show archived"));

    expect(await screen.findByText("Archived thread")).toBeInTheDocument();
    expect(listThreadMigrationSourceThreads).toHaveBeenLastCalledWith({
      archived: true,
      sourceProfile: "",
    });
  });

  it("keeps Move and detached Copy available for selected managed worktrees", async () => {
    const threadsResponse = migrationThreadsResponse("", "Managed worktree thread");
    threadsResponse.projects[0]!.threads[0]!.linkedDirectories = [
      {
        id: "worktree:/Users/alice/.codex/worktrees/mpabc/app",
        label: "app",
        path: "/repo/app",
        worktreePath: "/Users/alice/.codex/worktrees/mpabc/app",
        kind: "worktree",
      },
    ];
    const desktopApi: DesktopApi = {
      listThreadMigrationSources: vi.fn(async () => migrationSourcesResponse()),
      listThreadMigrationSourceThreads: vi.fn(async () => threadsResponse),
    };

    const { container } = render(
      <ThreadManagementSettings desktopApi={desktopApi} />,
    );

    fireEvent.click(
      (await screen.findAllByRole("checkbox", { name: /System default/ }))[0]!,
    );

    expect(screen.getByRole("button", { name: "Move 1" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy 1" })).toBeEnabled();
    expect(
      screen.getByRole("combobox", { name: "Copy strategy" }),
    ).toHaveValue("detached-destination");
    expect(
      screen.getByText(
        "Move transfers branches to destination worktrees before archiving the source. Copy leaves source branches active and uses the selected strategy.",
      ),
    ).toBeInTheDocument();

    const actionbar = container.querySelector(
      ".settings-thread-management__actionbar",
    );
    const projectsList = container.querySelector(
      ".settings-thread-management__projects-list",
    );
    expect(actionbar).not.toBeNull();
    expect(projectsList).not.toBeNull();
    expect(
      actionbar!.compareDocumentPosition(projectsList!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows migration diagnostics and warnings returned by the run", async () => {
    const threadsResponse = migrationThreadsResponse("", "GIFusion thread");
    const migrationResponse: StartThreadMigrationResponse = {
      runId: "run-1",
      operation: "move",
      startedAt: 1234,
      items: [
        {
          sourceProfile: "",
          sourceThreadId: "default-thread",
          destinationThreadId: "destination-thread",
          status: "completed",
          diagnostics: {
            requestedWorkMode: "worktree",
            destinationDirectoryPath: "/repo/default",
            destinationWorkMode: "local",
          },
          warnings: [
            "Destination returned local even though migration requested a worktree.",
          ],
        },
      ],
    };
    const desktopApi: DesktopApi = {
      listThreadMigrationSources: vi.fn(async () => migrationSourcesResponse()),
      listThreadMigrationSourceThreads: vi.fn(async () => threadsResponse),
      startThreadMigration: vi.fn(async () => migrationResponse),
    };

    render(<ThreadManagementSettings desktopApi={desktopApi} />);

    fireEvent.click(
      await screen.findByRole("checkbox", { name: /GIFusion thread/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move 1" }));

    expect(
      await screen.findByText("Destination local /repo/default"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Destination returned local even though migration requested a worktree.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("completed with warning")).toBeInTheDocument();
    expect(screen.getByText("Run run-1: 1 of 1 completed, 1 with a warning."))
      .toBeInTheDocument();
  });
});
