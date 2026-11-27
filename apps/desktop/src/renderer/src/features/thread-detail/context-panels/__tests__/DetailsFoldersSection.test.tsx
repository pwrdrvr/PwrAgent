import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOTE_NATIVE_PICKER_TOOLTIP } from "../../../composer/native-picker-boundary";
import { DetailsFoldersSection } from "../DetailsFoldersSection";

afterEach(cleanup);

const sharedCheckout = {
  id: "/fixture/worktrees/parent", kind: "worktree" as const, label: "Project",
  path: "/fixture/Project", worktreePath: "/fixture/worktrees/parent",
};
const attachedCheckout = {
  ...sharedCheckout, id: sharedCheckout.path, worktreePath: "/fixture/worktrees/child",
};
const childThread: NavigationThreadSummary = {
  id: "child", title: "Child thread", titleSource: "explicit", source: "codex",
  projectKey: sharedCheckout.worktreePath,
  linkedDirectories: [attachedCheckout, sharedCheckout],
  inbox: { inInbox: false },
};

/** Opens the ⋯ menu of an attached folder and chooses one of its items. */
function chooseAttached(label: string, item: string): void {
  const attached = screen.getByRole("list", { name: "Attached folders" });
  fireEvent.click(within(attached).getByRole("button", { name: `Folder actions for ${label}` }));
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: item }));
}

function folderMenu(label: string): HTMLElement {
  fireEvent.click(within(screen.getByRole("list", { name: "Primary folder" }))
    .getByRole("button", { name: `Folder actions for ${label}` }));
  return screen.getByRole("menu");
}

describe("DetailsFoldersSection", () => {
  it("detaches the first row when the current checkout is listed second", async () => {
    const detachDirectoryFromThread = vi.fn(async () => ({
      ok: true as const, backend: "codex" as const, threadId: childThread.id, directories: [sharedCheckout],
    }));
    const onRefreshNavigation = vi.fn(async () => {
      panel.rerender(view({ ...childThread, linkedDirectories: [sharedCheckout] }));
    });
    const view = (thread: NavigationThreadSummary) => <DetailsFoldersSection
      desktopApi={{ detachDirectoryFromThread }} onRefreshNavigation={onRefreshNavigation}
      thread={thread} hideTooltip={() => undefined} showTooltip={() => undefined}
    />;
    const panel = render(view(childThread));

    // The cwd's checkout is listed second; the first is the attached one.
    chooseAttached("Project", "Detach");
    await waitFor(() => expect(screen.queryByText(attachedCheckout.worktreePath)).not.toBeInTheDocument());
    expect(screen.getByText(sharedCheckout.worktreePath)).toBeVisible();
    expect(detachDirectoryFromThread).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      threadId: childThread.id, directory: attachedCheckout,
    }));
  });

  it.each(["owner refusal", "IPC rejection"])("announces a detach failure from %s and permits retry", async (failure) => {
    const message = "The owning instance is unavailable.";
    const detachDirectoryFromThread = vi.fn(async () => {
      if (failure === "IPC rejection") throw new Error(message);
      return { ok: false as const, backend: "codex" as const, threadId: childThread.id,
        reason: "not-found" as const, message };
    });
    const onRefreshNavigation = vi.fn(async () => undefined);
    render(<DetailsFoldersSection
      desktopApi={{ detachDirectoryFromThread }} onRefreshNavigation={onRefreshNavigation}
      thread={{ ...childThread, linkedDirectories: [sharedCheckout, attachedCheckout] }}
      hideTooltip={() => undefined} showTooltip={() => undefined}
    />);

    chooseAttached("Project", "Detach");
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    const attached = screen.getByRole("list", { name: "Attached folders" });
    fireEvent.click(within(attached).getByRole("button", { name: "Folder actions for Project" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Detach" }))
      .not.toHaveAttribute("aria-disabled");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByText(attachedCheckout.worktreePath)).toBeVisible();
    expect(onRefreshNavigation).not.toHaveBeenCalled();
  });

  it("routes secondary directory detachment to the remote owner and source thread", async () => {
    const target = { scope: "remote" as const, instanceId: "owner-one" };
    const directory = { id: "/owner/PwrGit", kind: "local" as const,
      label: "PwrGit", path: "/owner/PwrGit" };
    const detachDirectoryFromThread = vi.fn(async () => ({
      ok: true as const, backend: "codex" as const, threadId: "source-thread", directories: [],
    }));
    const onRefreshNavigation = vi.fn(async () => undefined);
    render(
      <DetailsFoldersSection
        desktopApi={{ detachDirectoryFromThread }}
        onRefreshNavigation={onRefreshNavigation}
        hideTooltip={() => undefined}
        showTooltip={() => undefined}
        thread={{
          id: "mounted-thread", title: "PwrSnap", titleSource: "explicit", source: "codex",
          projectKey: "/owner/PwrSnap",
          federation: { ref: { backend: "codex", target, threadId: "source-thread" },
            instanceLabel: "Owner", peerStatus: "connected" },
          linkedDirectories: [
            { id: "/owner/PwrSnap", kind: "local", label: "PwrSnap", path: "/owner/PwrSnap" },
            directory,
          ],
          inbox: { inInbox: false },
        }}
      />,
    );
    chooseAttached("PwrGit", "Detach");
    await waitFor(() => expect(onRefreshNavigation).toHaveBeenCalledOnce());
    expect(detachDirectoryFromThread).toHaveBeenCalledWith({
      backend: "codex", federationTarget: target, threadId: "source-thread", directory,
    });
  });

  it("disables the native directory picker for a remote thread", () => {
    const pickDirectoryFromDisk = vi.fn();
    const attachDirectoryToThread = vi.fn();
    render(
      <DetailsFoldersSection
        desktopApi={{
          attachDirectoryToThread,
          detachDirectoryFromThread: vi.fn(),
          pickDirectoryFromDisk,
        }}
        hideTooltip={() => undefined}
        showTooltip={() => undefined}
        thread={{
          id: "thread-1",
          title: "Remote thread",
          titleSource: "explicit",
          source: "codex",
          federation: {
            ref: {
              backend: "codex",
              target: {
                scope: "remote",
                instanceId: "owner-one",
              },
              threadId: "thread-1",
            },
            instanceLabel: "Owner",
            peerStatus: "connected",
          },
          linkedDirectories: [{
            id: "/owner/project",
            kind: "local",
            label: "Owner project",
            path: "/owner/project",
          }],
          inbox: { inInbox: false },
        }}
      />,
    );

    const addDirectory = screen.getByRole("button", { name: "Attach folder" });
    expect(addDirectory).toBeDisabled();
    expect(addDirectory).toHaveAttribute(
      "data-tooltip",
      REMOTE_NATIVE_PICKER_TOOLTIP,
    );
  });

  describe("Attach folder", () => {
    const tracked = [
      { key: "widgets", kind: "directory" as const, label: "Widgets", path: "/fixture/Widgets" },
      // Already the thread's source checkout: not offered again.
      { key: "project", kind: "directory" as const, label: "Project", path: sharedCheckout.path },
      // Already the thread's worktree: not offered again.
      { key: "child", kind: "directory" as const, label: "Child", path: attachedCheckout.worktreePath },
    ];
    const attachApi = () => ({
      attachDirectoryToThread: vi.fn(async (request: { path: string }) => ({
        ok: true as const, backend: "codex" as const, threadId: childThread.id,
        directory: { id: request.path, kind: "local" as const, label: request.path, path: request.path },
      })),
      detachDirectoryFromThread: vi.fn(),
      pickDirectoryFromDisk: vi.fn(async () => ({ canceled: false as const, path: "/fixture/Picked" })),
    });
    const view = (desktopApi: ReturnType<typeof attachApi>) => <DetailsFoldersSection
      desktopApi={desktopApi} thread={childThread} trackedDirectories={tracked}
      onRefreshNavigation={async () => undefined}
      hideTooltip={() => undefined} showTooltip={() => undefined}
    />;

    it("opens the project picker, offering only tracked projects the thread has not linked", () => {
      const api = attachApi();
      render(view(api));
      fireEvent.click(screen.getByRole("button", { name: "Attach folder" }));
      const picker = screen.getByRole("dialog", { name: "Project picker" });
      const options = within(picker).getAllByRole("option").map((option) => option.textContent);
      expect(options).toEqual([expect.stringContaining("Widgets")]);
      // Opening the picker is not picking from disk.
      expect(api.pickDirectoryFromDisk).not.toHaveBeenCalled();
    });

    it("attaches a tracked project without the disk picker", async () => {
      const api = attachApi();
      render(view(api));
      fireEvent.click(screen.getByRole("button", { name: "Attach folder" }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "Project picker" }))
        .getByRole("option", { name: /Widgets/ }));
      await waitFor(() => expect(api.attachDirectoryToThread).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ threadId: childThread.id, path: "/fixture/Widgets" }),
      ));
      expect(api.pickDirectoryFromDisk).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Project picker" })).toBeNull();
    });

    it("picks an untracked folder from disk through Add directory", async () => {
      const api = attachApi();
      render(view(api));
      fireEvent.click(screen.getByRole("button", { name: "Attach folder" }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "Project picker" }))
        .getByRole("button", { name: /Add directory/ }));
      await waitFor(() => expect(api.attachDirectoryToThread).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ threadId: childThread.id, path: "/fixture/Picked" }),
      ));
      expect(api.pickDirectoryFromDisk).toHaveBeenCalledTimes(1);
    });
  });

  describe("Share storage", () => {
    const worktree = sharedCheckout;
    const mainCheckout = { id: "/fixture/Project", kind: "local" as const, label: "Project main", path: "/fixture/Project" };
    const thread: NavigationThreadSummary = { ...childThread, linkedDirectories: [worktree, mainCheckout] };
    const storageApi = (capabilities: { reflink: boolean; verifyFilters: boolean }) => ({
      readWorktreeReflinkCapabilities: vi.fn(async () => ({
        status: "ready" as const, capabilities, runtimeKey: "git",
      })),
      runWorktreeReflink: vi.fn(async () => ({ status: "failed" as const, reason: "not run in this test" })),
    });
    const view = (desktopApi: ReturnType<typeof storageApi>, shown = thread) => <DetailsFoldersSection
      desktopApi={desktopApi} thread={shown} hideTooltip={() => undefined} showTooltip={() => undefined}
    />;

    /** Whether the worktree's menu offers Share storage; leaves the menu closed. */
    const shareStorageOffered = (): boolean => {
      const menu = folderMenu("Project");
      const offered = within(menu).queryByRole("menuitem", { name: "Share storage" }) !== null;
      fireEvent.keyDown(menu, { key: "Escape" });
      return offered;
    };
    const chooseShareStorage = (): void => {
      fireEvent.click(within(folderMenu("Project")).getByRole("menuitem", { name: "Share storage" }));
    };

    it("is offered for a worktree only after the selected Git's help lists the command", async () => {
      const api = storageApi({ reflink: true, verifyFilters: false });
      render(view(api));
      // Nothing is offered while the probe is out.
      expect(shareStorageOffered()).toBe(false);
      await waitFor(() => expect(shareStorageOffered()).toBe(true));
      expect(api.readWorktreeReflinkCapabilities).toHaveBeenCalledWith({
        backend: "codex", threadId: thread.id, worktreePath: worktree.worktreePath,
      });
      // The main checkout has no source to share with.
      const attached = screen.getByRole("list", { name: "Attached folders" });
      fireEvent.click(within(attached).getByRole("button", { name: "Folder actions for Project main" }));
      expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Share storage" })).toBeNull();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

      chooseShareStorage();
      expect(await screen.findByRole("dialog", { name: "Share worktree storage" })).toBeVisible();
    });

    it("does not reopen for a thread when the panel comes back from another one", async () => {
      const api = storageApi({ reflink: true, verifyFilters: false });
      const panel = render(view(api));
      await waitFor(() => expect(shareStorageOffered()).toBe(true));
      chooseShareStorage();
      expect(await screen.findByRole("dialog", { name: "Share worktree storage" })).toBeVisible();

      const other: NavigationThreadSummary = { ...thread, id: "other" };
      panel.rerender(view(api, other));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      // The other thread links the same directory, and did not ask for the dialog.
      await waitFor(() => expect(shareStorageOffered()).toBe(true));
      panel.rerender(view(api));
      await waitFor(() => expect(shareStorageOffered()).toBe(true));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("does not restart its probe when the api object is rebuilt on a render", async () => {
      const api = storageApi({ reflink: true, verifyFilters: false });
      const panel = render(view(api));
      await waitFor(() => expect(shareStorageOffered()).toBe(true));
      panel.rerender(view({ ...api }));
      panel.rerender(view({ ...api }));
      expect(shareStorageOffered()).toBe(true);
      expect(api.readWorktreeReflinkCapabilities).toHaveBeenCalledTimes(1);
    });

    it("is not offered when the selected Git has no such command", async () => {
      const api = storageApi({ reflink: false, verifyFilters: false });
      render(view(api));
      await waitFor(() => expect(api.readWorktreeReflinkCapabilities).toHaveBeenCalled());
      await Promise.resolve();
      expect(shareStorageOffered()).toBe(false);
    });

    it("is not offered, or probed, for a thread another machine owns", async () => {
      const api = storageApi({ reflink: true, verifyFilters: true });
      render(view(api, {
        ...thread,
        federation: { ref: { target: { instanceId: "peer" } } } as NavigationThreadSummary["federation"],
      }));
      await Promise.resolve();
      expect(api.readWorktreeReflinkCapabilities).not.toHaveBeenCalled();
      expect(shareStorageOffered()).toBe(false);
    });
  });
});
