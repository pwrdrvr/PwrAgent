import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOTE_NATIVE_PICKER_TOOLTIP } from "../../../composer/native-picker-boundary";
import { LinkedProjectsPanel } from "../LinkedProjectsPanel";

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

describe("LinkedProjectsPanel", () => {
  it("detaches the first row when the current checkout is listed second", async () => {
    const detachDirectoryFromThread = vi.fn(async () => ({
      ok: true as const, backend: "codex" as const, threadId: childThread.id, directories: [sharedCheckout],
    }));
    const onRefreshNavigation = vi.fn(async () => {
      panel.rerender(view({ ...childThread, linkedDirectories: [sharedCheckout] }));
    });
    const view = (thread: NavigationThreadSummary) => <LinkedProjectsPanel
      desktopApi={{ detachDirectoryFromThread }} onRefreshNavigation={onRefreshNavigation}
      thread={thread} hideTooltip={() => undefined} showTooltip={() => undefined}
    />;
    const panel = render(view(childThread));

    fireEvent.click(within(screen.getAllByRole("listitem")[0]!).getByRole("button", { name: "Detach" }));
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
    render(<LinkedProjectsPanel
      desktopApi={{ detachDirectoryFromThread }} onRefreshNavigation={onRefreshNavigation}
      thread={{ ...childThread, linkedDirectories: [sharedCheckout, attachedCheckout] }}
      hideTooltip={() => undefined} showTooltip={() => undefined}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Detach" })).toBeEnabled();
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
      <LinkedProjectsPanel
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
    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(onRefreshNavigation).toHaveBeenCalledOnce());
    expect(detachDirectoryFromThread).toHaveBeenCalledWith({
      backend: "codex", federationTarget: target, threadId: "source-thread", directory,
    });
  });

  it("disables the native directory picker for a remote thread", () => {
    const pickDirectoryFromDisk = vi.fn();
    const attachDirectoryToThread = vi.fn();
    render(
      <LinkedProjectsPanel
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

    const addDirectory = screen.getByRole("button", { name: "Add directory" });
    expect(addDirectory).toBeDisabled();
    expect(addDirectory).toHaveAttribute(
      "data-tooltip",
      REMOTE_NATIVE_PICKER_TOOLTIP,
    );
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
    const view = (desktopApi: ReturnType<typeof storageApi>, shown = thread) => <LinkedProjectsPanel
      desktopApi={desktopApi} thread={shown} hideTooltip={() => undefined} showTooltip={() => undefined}
    />;

    it("is offered for a worktree only after the selected Git's help lists the command", async () => {
      const api = storageApi({ reflink: true, verifyFilters: false });
      render(view(api));
      // Nothing is offered while the probe is out.
      expect(screen.queryByRole("button", { name: /Share storage/ })).not.toBeInTheDocument();
      const action = await screen.findByRole("button", { name: "Share storage for Project" });
      // The main checkout has no source to share with.
      expect(screen.getAllByRole("button", { name: /Share storage/ })).toEqual([action]);
      expect(api.readWorktreeReflinkCapabilities).toHaveBeenCalledWith({
        backend: "codex", threadId: thread.id, worktreePath: worktree.worktreePath,
      });

      fireEvent.click(action);
      expect(await screen.findByRole("dialog", { name: "Share worktree storage" })).toBeVisible();
    });

    it("does not reopen for a thread when the panel comes back from another one", async () => {
      const api = storageApi({ reflink: true, verifyFilters: false });
      const panel = render(view(api));
      fireEvent.click(await screen.findByRole("button", { name: "Share storage for Project" }));
      expect(await screen.findByRole("dialog", { name: "Share worktree storage" })).toBeVisible();

      const other: NavigationThreadSummary = { ...thread, id: "other" };
      panel.rerender(view(api, other));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      // The other thread links the same directory, and did not ask for the dialog.
      expect(await screen.findByRole("button", { name: "Share storage for Project" })).toBeVisible();
      panel.rerender(view(api));
      await screen.findByRole("button", { name: "Share storage for Project" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("does not restart its probe when the api object is rebuilt on a render", async () => {
      const api = storageApi({ reflink: true, verifyFilters: false });
      const panel = render(view(api));
      await screen.findByRole("button", { name: "Share storage for Project" });
      panel.rerender(view({ ...api }));
      panel.rerender(view({ ...api }));
      expect(screen.getByRole("button", { name: "Share storage for Project" })).toBeVisible();
      expect(api.readWorktreeReflinkCapabilities).toHaveBeenCalledTimes(1);
    });

    it("is not offered when the selected Git has no such command", async () => {
      const api = storageApi({ reflink: false, verifyFilters: false });
      render(view(api));
      await waitFor(() => expect(api.readWorktreeReflinkCapabilities).toHaveBeenCalled());
      await Promise.resolve();
      expect(screen.queryByRole("button", { name: /Share storage/ })).not.toBeInTheDocument();
    });

    it("is not offered, or probed, for a thread another machine owns", async () => {
      const api = storageApi({ reflink: true, verifyFilters: true });
      render(view(api, {
        ...thread,
        federation: { ref: { target: { instanceId: "peer" } } } as NavigationThreadSummary["federation"],
      }));
      await Promise.resolve();
      expect(api.readWorktreeReflinkCapabilities).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /Share storage/ })).not.toBeInTheDocument();
    });
  });
});
