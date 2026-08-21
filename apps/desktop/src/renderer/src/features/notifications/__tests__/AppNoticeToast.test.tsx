import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppNoticeToast } from "../AppNoticeToast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AppNoticeToast", () => {
  const notice = {
    id: "notice-1",
    title: "Worktree kept",
    message: "Thread archived. The worktree was kept because another active thread is still using it.",
    detail: "/repo/.worktrees/shared: Worktree is still used by another active thread.",
  };

  it("renders selectable notice text with copy and dismiss controls", () => {
    const copyText = vi.fn(async () => undefined);
    const onDismiss = vi.fn();

    render(
      <AppNoticeToast
        desktopApi={{ copyText }}
        notice={notice}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText("Worktree kept")).toBeInTheDocument();
    expect(screen.getByText(notice.message)).toBeInTheDocument();
    expect(screen.getByText(notice.detail)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy notice" }));
    expect(copyText).toHaveBeenCalledWith(
      [notice.title, notice.message, notice.detail].join("\n"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("includes the visible status in the default copy value", () => {
    const copyText = vi.fn(async () => undefined);
    const repairNotice = {
      ...notice,
      status: {
        label: "Automatic repair failed: rollout belongs to another thread",
        state: "error" as const,
      },
      title: "Codex repair failed",
    };

    render(
      <AppNoticeToast
        desktopApi={{ copyText }}
        notice={repairNotice}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy notice" }));
    expect(copyText).toHaveBeenCalledWith(
      [
        repairNotice.title,
        repairNotice.status.label,
        repairNotice.message,
        repairNotice.detail,
      ].join("\n"),
    );
  });

  it("renders an originating thread as an actionable thread chip", () => {
    const onOpenThread = vi.fn();
    const threadLink = {
      backend: "codex" as const,
      threadId: "thread-1",
      title: "Fix the flaky test",
    };

    render(
      <AppNoticeToast
        notice={{
          ...notice,
          detail: threadLink.title,
          threadLink,
        }}
        onDismiss={vi.fn()}
        onOpenThread={onOpenThread}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open thread Fix the flaky test" }),
    );
    expect(onOpenThread).toHaveBeenCalledWith(threadLink);
  });

  it("opens its thread-chip context menu above the toast layer", () => {
    const threadLink = {
      backend: "codex" as const,
      threadId: "thread-1",
      title: "Fix the flaky test",
    };

    render(
      <AppNoticeToast
        notice={{
          ...notice,
          detail: threadLink.title,
          threadLink,
        }}
        onDismiss={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Open thread Fix the flaky test" }),
    );
    expect(screen.getByRole("menu")).toHaveClass(
      "app-notice-toast__thread-menu",
    );
  });

  it("marks warning notices for high-contrast styling", () => {
    render(
      <AppNoticeToast
        notice={{ ...notice, tone: "warning" }}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "warning");
  });

  it("copies an explicit handoff value without rendering it", () => {
    const copyText = vi.fn(async () => undefined);
    const handoff = [
      "PwrAgent captured a renderer CPU profile.",
      "Heap snapshot start path: /Users/test/.pwragent/diagnostics/renderer-hot-0001-start.heapsnapshot",
      "Heap snapshot stop path: /Users/test/.pwragent/diagnostics/renderer-hot-0001-stop.heapsnapshot",
    ].join("\n");

    render(
      <AppNoticeToast
        desktopApi={{ copyText }}
        notice={{
          ...notice,
          copyText: handoff,
          detail: "Session: hot-cpu-2026-06-10-2211-bd972c",
        }}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText("Session: hot-cpu-2026-06-10-2211-bd972c")).toBeInTheDocument();
    expect(screen.queryByText(/Heap snapshot start path/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy notice" }));
    expect(copyText).toHaveBeenCalledWith(handoff);
  });

  it("auto-dismisses unless the notice is hovered", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();

    render(<AppNoticeToast notice={notice} onDismiss={onDismiss} />);

    const toast = screen.getByRole("status");
    fireEvent.mouseEnter(toast);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("stays visible without a countdown when auto-dismiss is disabled", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();

    const { container } = render(
      <AppNoticeToast
        notice={{ ...notice, autoDismiss: false }}
        onDismiss={onDismiss}
      />,
    );

    expect(container.querySelector(".app-notice-toast__timer")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders ordered navigation controls for a durable notice stack", () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    render(
      <AppNoticeToast
        notice={{ ...notice, autoDismiss: false }}
        navigation={{
          current: 2,
          total: 3,
          onPrevious,
          onNext,
        }}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous notice" }));
    fireEvent.click(screen.getByRole("button", { name: "Next notice" }));
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("keeps copy and dismiss controls alongside supplied operator actions", () => {
    vi.useFakeTimers();
    const leaveDisabled = vi.fn();
    const resume = vi.fn();
    const onDismiss = vi.fn();

    const { container } = render(
      <AppNoticeToast
        notice={{
          ...notice,
          actions: [
            {
              label: "Leave disabled",
              onClick: leaveDisabled,
              tone: "secondary",
            },
            { label: "Resume", onClick: resume, tone: "primary" },
          ],
          autoDismiss: false,
        }}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Copy notice" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss notice" }))
      .toBeInTheDocument();
    expect(
      container.querySelector(".app-notice-toast__custom-actions"),
    ).toBeInTheDocument();
    expect(container.querySelector(".app-notice-toast__timer")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Leave disabled" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(leaveDisabled).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps operator actions in the existing durable-navigation row", () => {
    const onExamine = vi.fn();
    const { container } = render(
      <AppNoticeToast
        navigation={{ current: 1, total: 1 }}
        notice={{
          ...notice,
          actions: [{
            label: "Examine 20 cases",
            onClick: onExamine,
            tone: "primary",
          }],
          autoDismiss: false,
        }}
        onDismiss={vi.fn()}
      />,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Durable notices",
    });
    const actionGroup = navigation.querySelector<HTMLElement>(
      ".app-notice-toast__custom-actions",
    );
    expect(actionGroup).toBeInTheDocument();
    expect(container.querySelector(
      ".app-notice-toast > .app-notice-toast__custom-actions",
    )).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Examine 20 cases" }));
    expect(onExamine).toHaveBeenCalledTimes(1);
  });

  it("uses a notice-specific durable dismissal when supplied", () => {
    const durableDismiss = vi.fn();
    const stackDismiss = vi.fn();

    render(
      <AppNoticeToast
        notice={{ ...notice, autoDismiss: false, onDismiss: durableDismiss }}
        onDismiss={stackDismiss}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(durableDismiss).toHaveBeenCalledOnce();
    expect(stackDismiss).not.toHaveBeenCalled();
  });

  it("starts a hover-paused countdown when repair progress flips to success", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const repairingNotice = {
      ...notice,
      autoDismiss: false,
      id: "codex-invalid-id-recovery:codex:thread-1:turn-9",
      status: {
        label: "Repairing saved thread history.",
        state: "progress" as const,
      },
      title: "Known Codex issue",
      tone: "warning" as const,
    };
    const { container, rerender } = render(
      <AppNoticeToast notice={repairingNotice} onDismiss={onDismiss} />,
    );

    expect(screen.getByText("Repairing saved thread history.")).toBeInTheDocument();
    expect(container.querySelector(".app-notice-toast__timer")).toBeNull();

    rerender(
      <AppNoticeToast
        notice={{
          ...repairingNotice,
          autoDismiss: true,
          status: {
            label: "Saved history repaired. Your message was retried.",
            state: "success",
          },
          title: "Codex thread repaired",
          tone: "success",
        }}
        onDismiss={onDismiss}
      />,
    );

    const toast = screen.getByRole("status");
    expect(container.querySelector(".app-notice-toast__timer")).not.toBeNull();
    fireEvent.mouseEnter(toast);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
