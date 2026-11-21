import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ReadWorktreeReflinkCapabilitiesResponse,
  RunWorktreeReflinkRequest,
  RunWorktreeReflinkResponse,
  WorktreeReflinkCapabilities,
} from "@pwragent/shared/contracts/worktree-reflink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pressEscape, tabEscapes } from "../../../test/tab-walk";
import { WorktreeStorageDialog, type WorktreeStorageApi } from "../WorktreeStorageDialog";

afterEach(cleanup);

type Version = "pwrgit.1" | "pwrgit.2" | "stock";
const TRUTH: Record<Version, WorktreeReflinkCapabilities> = {
  "pwrgit.1": { reflink: true, verifyFilters: false },
  "pwrgit.2": { reflink: true, verifyFilters: true },
  "stock": { reflink: false, verifyFilters: false },
};
const TARGET = { backend: "codex" as const, threadId: "thread", worktreePath: "/fixture/worktrees/atlas" };

/** The main process as the dialog sees it, answering for the Git selected now. */
function fakeMain(initial: Version) {
  const state = { selected: initial };
  const runs: RunWorktreeReflinkRequest[] = [];
  let announce: (() => void) | undefined;
  const api = {
    onSettingsRuntimeChanged: (callback: () => void) => {
      announce = callback;
      return () => { announce = undefined; };
    },
    readWorktreeReflinkCapabilities: vi.fn(async (): Promise<ReadWorktreeReflinkCapabilitiesResponse> => ({
      status: "ready", capabilities: TRUTH[state.selected], runtimeKey: state.selected,
    })),
    runWorktreeReflink: vi.fn(async (request: RunWorktreeReflinkRequest): Promise<RunWorktreeReflinkResponse> => {
      runs.push(request);
      const runtime = { capabilities: TRUTH[state.selected], runtimeKey: state.selected };
      if (request.mode === "share" && request.runtimeKey !== state.selected) {
        return { status: "runtime-changed", ...runtime };
      }
      const share = request.mode === "share";
      return {
        status: "completed", mode: request.mode, supported: true,
        verifiedFilters: share && request.verifyFilters === true,
        summary: {
          scanned: 3310, eligible: share ? 0 : 1204, alreadyShared: share ? 3306 : 2102,
          reshared: share ? 1204 : 0, skipped: 4, failed: 0,
          observedPrivateReduction: share ? 412 * 1024 * 1024 : 0,
          potentialPrivateReduction: share ? 0 : 412 * 1024 * 1024, allocationUnknown: 0,
        },
        ...runtime,
      };
    }),
  } satisfies WorktreeStorageApi;
  return {
    api,
    runs,
    select: (version: Version) => {
      state.selected = version;
      act(() => announce?.());
    },
    selectSilently: (version: Version) => { state.selected = version; },
  };
}

function renderDialog(main: ReturnType<typeof fakeMain>, turnActive = false) {
  const onClose = vi.fn();
  render(<WorktreeStorageDialog
    api={main.api} label="atlas" target={TARGET} turnActive={turnActive} onClose={onClose}
  />);
  return { onClose, dialog: screen.getByRole("dialog", { name: "Share worktree storage" }) };
}

const verifyBox = () => screen.queryByRole("checkbox", { name: /Verify filtered files/ });
const shareButton = () => screen.getByRole("button", { name: "Share storage" });
const estimated = () => screen.findByText(/1,204 of 3,310 files can be shared, freeing about 412 MB\./);

describe("WorktreeStorageDialog", () => {
  it("offers filter verification only when the selected Git lists it, and leaves it off", async () => {
    const withIt = fakeMain("pwrgit.2");
    renderDialog(withIt);
    await estimated();
    expect(verifyBox()).not.toBeChecked();
    cleanup();

    renderDialog(fakeMain("pwrgit.1"));
    await estimated();
    expect(verifyBox()).not.toBeInTheDocument();
    expect(shareButton()).toBeEnabled();
  });

  it("estimates on open without filters, and shares without them unless the box is ticked", async () => {
    const main = fakeMain("pwrgit.2");
    renderDialog(main);
    await estimated();
    expect(main.runs).toEqual([{ ...TARGET, mode: "estimate", runtimeKey: "pwrgit.2" }]);

    fireEvent.click(shareButton());
    expect(await screen.findByText(/Shared 1,204 files, freeing 412 MB\. 4 files skipped\./)).toBeVisible();
    expect(main.runs[1]).toEqual({ ...TARGET, mode: "share", runtimeKey: "pwrgit.2" });
    expect(screen.queryByText(/Filtered files were verified/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
  });

  it("passes the opt-in only on the share, never on an estimate", async () => {
    const main = fakeMain("pwrgit.2");
    renderDialog(main);
    await estimated();
    fireEvent.click(verifyBox()!);
    expect(verifyBox()).toBeChecked();
    fireEvent.click(shareButton());
    expect(await screen.findByText(/Filtered files were verified\./)).toBeVisible();
    expect(main.runs.map((run) => [run.mode, run.verifyFilters])).toEqual([
      ["estimate", undefined],
      ["share", true],
    ]);
  });

  it("withdraws a ticked option when .1 replaces .2, and does not tick it again when .2 returns", async () => {
    const main = fakeMain("pwrgit.2");
    renderDialog(main);
    await estimated();
    fireEvent.click(verifyBox()!);

    main.select("pwrgit.1");
    await waitFor(() => expect(verifyBox()).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("The selected Git changed.");
    // The new Git gets its own filter-free estimate.
    await waitFor(() => expect(main.runs).toHaveLength(2));
    expect(main.runs[1]).toEqual({ ...TARGET, mode: "estimate", runtimeKey: "pwrgit.1" });

    main.select("pwrgit.2");
    await waitFor(() => expect(verifyBox()).toBeInTheDocument());
    expect(verifyBox()).not.toBeChecked();
    await waitFor(() => expect(main.runs).toHaveLength(3));
    await estimated();
    fireEvent.click(shareButton());
    await screen.findByText(/Shared 1,204 files/);
    expect(main.runs[3]).toEqual({ ...TARGET, mode: "share", runtimeKey: "pwrgit.2" });
  });

  it("does not share when the Git changed without notice, and asks again", async () => {
    const main = fakeMain("pwrgit.2");
    renderDialog(main);
    await estimated();
    fireEvent.click(verifyBox()!);
    main.selectSilently("pwrgit.1");

    fireEvent.click(shareButton());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The selected Git changed."));
    expect(verifyBox()).not.toBeInTheDocument();
    expect(screen.queryByText(/Shared/)).not.toBeInTheDocument();
    // The refused share named .2; nothing was shared for .1 on its behalf.
    expect(main.runs.filter((run) => run.mode === "share")).toEqual([
      { ...TARGET, mode: "share", runtimeKey: "pwrgit.2", verifyFilters: true },
    ]);
    await estimated();
    expect(shareButton()).toBeEnabled();
  });

  it("keeps the newer Git's answer when an older capability probe finishes last", async () => {
    const answers: Array<(response: ReadWorktreeReflinkCapabilitiesResponse) => void> = [];
    const main = fakeMain("pwrgit.1");
    main.api.readWorktreeReflinkCapabilities.mockImplementation(
      () => new Promise((resolve) => { answers.push(resolve); }),
    );
    renderDialog(main);
    await waitFor(() => expect(answers).toHaveLength(1));
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(answers).toHaveLength(2));

    await act(async () => {
      answers[1]({ status: "ready", capabilities: TRUTH["pwrgit.1"], runtimeKey: "pwrgit.1" });
    });
    await estimated();
    await act(async () => {
      answers[0]({ status: "ready", capabilities: TRUTH["pwrgit.2"], runtimeKey: "pwrgit.2" });
    });
    expect(verifyBox()).not.toBeInTheDocument();
    expect(main.runs).toEqual([{ ...TARGET, mode: "estimate", runtimeKey: "pwrgit.1" }]);
  });

  it("offers nothing to run when the selected Git has no worktree sharing", async () => {
    const main = fakeMain("stock");
    renderDialog(main);
    expect(await screen.findByText("The selected Git cannot share worktree storage.")).toBeVisible();
    expect(shareButton()).toBeDisabled();
    expect(verifyBox()).not.toBeInTheDocument();
    expect(main.runs).toEqual([]);
  });

  it("still estimates during a turn, and says why sharing waits", async () => {
    const main = fakeMain("pwrgit.2");
    renderDialog(main, true);
    await estimated();
    expect(shareButton()).toBeDisabled();
    expect(screen.getByText("Sharing is available when the current turn finishes.")).toBeVisible();
  });

  it("traps Tab, closes on Escape, and stays open while sharing", async () => {
    const main = fakeMain("pwrgit.2");
    const { dialog, onClose } = renderDialog(main);
    await estimated();
    expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });

    let finish: ((response: RunWorktreeReflinkResponse) => void) | undefined;
    main.api.runWorktreeReflink.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(shareButton());
    await screen.findByText("Sharing storage...");
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { finish!({ status: "failed", reason: "index file corrupt" }); });
    expect(screen.getByRole("alert")).toHaveTextContent("index file corrupt");
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
