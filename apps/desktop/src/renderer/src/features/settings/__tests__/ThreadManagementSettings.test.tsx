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
        sourceProfile: "",
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: /personal/ }));

    await waitFor(() => {
      expect(listThreadMigrationSourceThreads).toHaveBeenCalledWith({
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
    const threadsResponse = migrationThreadsResponse("", "Thread without dirs");
    threadsResponse.projects[0]!.threads[0]!.linkedDirectories = undefined as never;
    const desktopApi: DesktopApi = {
      listThreadMigrationSources: vi.fn(async () => migrationSourcesResponse()),
      listThreadMigrationSourceThreads: vi.fn(async () => threadsResponse),
    };

    render(<ThreadManagementSettings desktopApi={desktopApi} />);

    expect(await screen.findByRole("button", { name: "Move 0" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy 0" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("checkbox", { name: /System default/ }));

    expect(screen.getByRole("button", { name: "Move 1" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy 1" })).toBeEnabled();
  });
});
