import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SendThreadToMachineDialog,
  type FindThreadHandoffRepository,
  type SendThreadToMachineSource,
} from "../SendThreadToMachineDialog";
import type { ThreadHandoffTarget } from "../thread-handoff-targets";
import type { ThreadHandoffProgress } from "@pwragent/shared";
import {
  reduceThreadHandoffTransfers,
  type ThreadHandoffChoice,
  type ThreadHandoffTransfer,
} from "../thread-handoff-transfer";
import { pressEscape, tabEscapes } from "../../../test/tab-walk";

afterEach(() => {
  cleanup();
});

const TARGETS: ThreadHandoffTarget[] = [
  { instanceId: "pwr_linux", label: "build-linux", availability: "available" },
  { instanceId: "pwr_old", label: "old-mbp", availability: "offline" },
  { instanceId: "pwr_studio", label: "studio-mac", availability: "available" },
  { instanceId: "pwr_win", label: "win-test", availability: "incoming-off" },
];

const GIT_SOURCE: SendThreadToMachineSource = {
  title: "Fix CRLF drift in Windows installer",
  project: {
    kind: "directory",
    label: "PwrAgent",
    path: "C:/src/PwrAgent",
    repositoryKey: "github.com/pwrdrvr/pwragent",
  },
  gitBranch: "fix/crlf-installer",
  gitWorkingState: {
    dirtyFiles: 5,
    dirtyAdditions: 40,
    dirtyDeletions: 12,
    untrackedFiles: 1,
    unpushedCommits: 2,
  },
};

const STUDIO_ONLY: FindThreadHandoffRepository = async (instanceId) =>
  instanceId === "pwr_studio"
    ? { path: "/Users/operator/src/PwrAgent", matchedBy: "origin" }
    : undefined;

const HANDOFF = "0f0e0d0c-0b0a-4908-8706-050403020100";

function progress(overrides: Partial<ThreadHandoffProgress>): ThreadHandoffProgress {
  return {
    handoffId: HANDOFF,
    sourceThreadId: "thread-1",
    phase: "package",
    link: "connected",
    cancelable: true,
    transport: "single_shot",
    ...overrides,
  };
}

/** A transfer as the window's reducer builds it from main's reports. */
function transfer(
  reports: ThreadHandoffProgress[],
  options: { choice?: ThreadHandoffChoice; failed?: string } = {},
): ThreadHandoffTransfer {
  let state = reduceThreadHandoffTransfers({}, {
    type: "started",
    at: 0,
    handoffId: HANDOFF,
    sourceThreadId: "thread-1",
    threadKey: "codex:thread-1",
    title: "Sketch the release checklist",
    targetLabel: "build-linux",
    choice: options.choice ?? { targetInstanceId: "pwr_linux", operation: "copy" },
  });
  reports.forEach((report, index) => {
    state = reduceThreadHandoffTransfers(state, { type: "progress", at: (index + 1) * 100, progress: report });
  });
  if (options.failed) {
    state = reduceThreadHandoffTransfers(state, { type: "failed", handoffId: HANDOFF, error: options.failed });
  }
  return state[HANDOFF]!;
}

function renderDialog(props: Partial<Parameters<typeof SendThreadToMachineDialog>[0]> = {}) {
  const onSend = props.onSend ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  render(
    <SendThreadToMachineDialog
      source={GIT_SOURCE}
      targets={TARGETS}
      findRepository={STUDIO_ONLY}
      {...props}
      onSend={onSend}
      onClose={onClose}
    />,
  );
  return { dialog: screen.getByRole("dialog", { name: "Send to Another Machine" }), onSend, onClose };
}

function machine(label: string): HTMLElement {
  return screen.getByRole("radio", { name: new RegExp(`^${label}`) });
}

describe("SendThreadToMachineDialog", () => {
  it("lists every machine and disables the ones that cannot receive, with the reason", async () => {
    renderDialog();
    expect(machine("old-mbp")).toBeDisabled();
    expect(machine("old-mbp")).toHaveTextContent("Offline");
    expect(machine("win-test")).toBeDisabled();
    expect(machine("win-test")).toHaveTextContent("Incoming files off");
    expect(machine("win-test")).toHaveAttribute(
      "title",
      "Turn on Allow file push in Settings › Federation on win-test",
    );
    await waitFor(() => {
      expect(machine("studio-mac")).toHaveTextContent("PwrAgent");
    });
    expect(machine("build-linux")).toHaveTextContent("No matching project");
  });

  it("defaults to Copy on the first available machine", async () => {
    renderDialog();
    await waitFor(() => expect(machine("studio-mac")).toHaveTextContent("PwrAgent"));
    expect(machine("build-linux")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /^Copy/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /^Move/ })).toHaveAttribute("aria-checked", "false");
  });

  it("prefills the receiver's repository from its project index and names the match", async () => {
    renderDialog();
    act(() => machine("studio-mac").click());
    // The hint describes the field; it is not part of the field's name.
    const input = screen.getByRole("textbox", { name: "Repository on studio-mac" });
    await waitFor(() => expect(input).toHaveValue("/Users/operator/src/PwrAgent"));
    expect(input).toHaveAccessibleDescription(
      "Matched by origin github.com/pwrdrvr/pwragent. A new worktree uses the source branch when available, or starts detached at the source commit.",
    );
    expect(screen.getByRole("button", { name: "Copy to studio-mac" })).toBeEnabled();
  });

  it("passes configured remotes to the lookup and describes a shared remote match", async () => {
    const project = { ...GIT_SOURCE.project!, repositoryKeys: ["github.com/pwrdrvr/pwragent", "github.com/upstream/pwragent"] };
    const findRepository = vi.fn<FindThreadHandoffRepository>(async () => ({
      path: "/home/fixture/PwrAgent", matchedBy: "remote",
    }));
    renderDialog({ source: { ...GIT_SOURCE, project }, findRepository });
    const input = screen.getByRole("textbox", { name: "Repository on build-linux" });
    await waitFor(() => expect(input).toHaveValue("/home/fixture/PwrAgent"));
    expect(findRepository).toHaveBeenCalledWith("pwr_linux", project);
    expect(input).toHaveAccessibleDescription(
      "Matched by a configured Git remote. A new worktree uses the source branch when available, or starts detached at the source commit.",
    );
  });

  it("holds Send until a machine with no matching project has a typed path", async () => {
    renderDialog();
    await waitFor(() => expect(machine("build-linux")).toHaveTextContent("No matching project"));
    const send = screen.getByRole("button", { name: "Copy to build-linux" });
    expect(send).toBeDisabled();
    expect(screen.getByText(/build-linux has no project with this origin/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /Repository on build-linux/ }), {
      target: { value: "/srv/src/PwrAgent" },
    });
    expect(send).toBeEnabled();
  });

  it("keeps a typed path when the lookup answers after it", async () => {
    let answer: (value: Awaited<ReturnType<FindThreadHandoffRepository>>) => void = () => {};
    renderDialog({
      findRepository: () => new Promise((resolve) => {
        answer = resolve;
      }),
    });
    const input = screen.getByRole("textbox", { name: /Repository on build-linux/ });
    fireEvent.change(input, { target: { value: "/srv/src/PwrAgent" } });
    await act(async () => {
      answer({ path: "/home/ops/PwrAgent", matchedBy: "name" });
    });
    expect(input).toHaveValue("/srv/src/PwrAgent");
  });

  it("sends the machine, operation and receiver path the operator chose", async () => {
    const { onSend } = renderDialog();
    act(() => machine("studio-mac").click());
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /Repository on studio-mac/ }))
        .toHaveValue("/Users/operator/src/PwrAgent"));
    act(() => screen.getByRole("radio", { name: /^Move/ }).click());
    await act(async () => {
      screen.getByRole("button", { name: "Move to studio-mac" }).click();
    });
    expect(onSend).toHaveBeenCalledWith({
      targetInstanceId: "pwr_studio",
      operation: "move",
      targetRepositoryPath: "/Users/operator/src/PwrAgent",
    });
  });

  it("summarizes what is sent from the row's last Git probe", async () => {
    renderDialog();
    await waitFor(() => expect(machine("studio-mac")).toHaveTextContent("PwrAgent"));
    expect(screen.getByText(
      "History, 2 unpushed commits, 5 changed files and 1 untracked file on fix/crlf-installer",
    )).toBeInTheDocument();
    expect(screen.getByText("Pull request link, schedules, messaging bindings, ignored files"))
      .toBeInTheDocument();
  });

  it("discloses non-Git workspace copying before sending, with no repository field", async () => {
    const { onSend } = renderDialog({
      source: { title: "Sketch the release checklist" },
    });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText(/This thread has no Git project/)).toBeInTheDocument();
    expect(screen.getByText(/including hidden files/)).toBeInTheDocument();
    expect(screen.getByText(/Remove sensitive files before sending/)).toBeInTheDocument();
    expect(screen.getByText(/Symlinks pointing outside the workspace/)).toBeInTheDocument();
    expect(screen.queryByText(/Files in this workspace are not copied/)).not.toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      screen.getByRole("button", { name: "Copy to build-linux" }).click();
    });
    expect(onSend).toHaveBeenCalledWith({ targetInstanceId: "pwr_linux", operation: "copy" });
  });

  it("lists the steps while sending, and Escape minimises instead of closing", () => {
    const onMinimise = vi.fn();
    const { onClose } = renderDialog({
      source: { title: "Sketch the release checklist" },
      transfer: transfer([progress({ phase: "send", bytesCommitted: 610, bytesTotal: 1000 })]),
      onMinimise,
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("heading", { name: "Copying to build-linux" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Send to build-linux" })).toHaveAttribute("aria-valuenow", "61");
    expect(screen.getByRole("button", { name: "Cancel Copy" })).toBeEnabled();
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    expect(onMinimise).toHaveBeenCalledTimes(1);
    act(() => screen.getByRole("button", { name: "Run in Background" }).click());
    expect(onMinimise).toHaveBeenCalledTimes(2);
  });

  it("withholds Cancel once the receiver may be creating the thread", () => {
    const onCancelTransfer = vi.fn();
    renderDialog({
      source: { title: "Sketch the release checklist" },
      transfer: transfer([
        progress({ phase: "send", bytesCommitted: 1000, bytesTotal: 1000 }),
        progress({ phase: "import", cancelable: false }),
      ]),
      onCancelTransfer,
    });
    const cancel = screen.getByRole("button", { name: "Cancel Copy" });
    expect(cancel).toBeDisabled();
    expect(cancel).toHaveAttribute("data-tooltip", expect.stringContaining("build-linux is creating the thread"));
  });

  it("offers Retry Now while a dropped link holds the send", () => {
    const onRetryNow = vi.fn();
    renderDialog({
      source: { title: "Sketch the release checklist" },
      transfer: transfer([progress({ phase: "send", bytesCommitted: 400, bytesTotal: 1000, link: "waiting", transport: "resumable" })]),
      onRetryNow,
    });
    expect(screen.getByText(/The connection to build-linux dropped/)).toBeInTheDocument();
    act(() => screen.getByRole("button", { name: "Retry Now" }).click());
    expect(onRetryNow).toHaveBeenCalledTimes(1);
  });

  it("shows the backend's error and keeps the choices for a retry", () => {
    renderDialog({
      source: { title: "Sketch the release checklist" },
      transfer: transfer([], {
        choice: { targetInstanceId: "pwr_linux", operation: "move" },
        failed: "Cancel the source thread's scheduled actions before Move, or use Copy.",
      }),
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Cancel the source thread's scheduled actions before Move, or use Copy.",
    );
    expect(screen.getByRole("radio", { name: /^Move/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Move to build-linux" })).toBeEnabled();
  });

  it("waits for a running turn to finish before it can send", () => {
    renderDialog({ source: { title: "Sketch the release checklist", busy: true } });
    expect(screen.getByRole("button", { name: "Copy to build-linux" })).toBeDisabled();
    expect(screen.getByText(/This thread is running/)).toBeInTheDocument();
  });

  it("closes on Escape when idle and keeps Tab inside", async () => {
    const { dialog, onClose } = renderDialog();
    await waitFor(() => expect(machine("studio-mac")).toHaveTextContent("PwrAgent"));
    expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
