import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SendThreadToMachineDialog,
  type FindThreadHandoffRepository,
  type SendThreadToMachineSource,
} from "../SendThreadToMachineDialog";
import type { ThreadHandoffTarget } from "../thread-handoff-targets";
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

function renderDialog(props: Partial<Parameters<typeof SendThreadToMachineDialog>[0]> = {}) {
  const onSend = props.onSend ?? vi.fn(async () => {});
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
      "Matched by origin github.com/pwrdrvr/pwragent. The thread starts in a new detached worktree there.",
    );
    expect(screen.getByRole("button", { name: "Copy to studio-mac" })).toBeEnabled();
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

  it("sends a Workspaces thread as history only, with no repository field", async () => {
    const { onSend } = renderDialog({
      source: { title: "Sketch the release checklist" },
    });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText(/This thread has no Git project/)).toBeInTheDocument();
    await act(async () => {
      screen.getByRole("button", { name: "Copy to build-linux" }).click();
    });
    expect(onSend).toHaveBeenCalledWith({ targetInstanceId: "pwr_linux", operation: "copy" });
  });

  it("locks the dialog while sending, Escape included", async () => {
    let finish: () => void = () => {};
    const { onClose } = renderDialog({
      source: { title: "Sketch the release checklist" },
      onSend: () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    });
    await act(async () => {
      screen.getByRole("button", { name: "Copy to build-linux" }).click();
    });
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copying…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sending to build-linux. This thread cannot take new turns until the transfer finishes.",
    );
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
  });

  it("shows the backend's error and keeps the choices for a retry", async () => {
    renderDialog({
      source: { title: "Sketch the release checklist" },
      onSend: async () => {
        throw new Error("Cancel the source thread's scheduled actions before Move, or use Copy.");
      },
    });
    act(() => screen.getByRole("radio", { name: /^Move/ }).click());
    await act(async () => {
      screen.getByRole("button", { name: "Move to build-linux" }).click();
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
