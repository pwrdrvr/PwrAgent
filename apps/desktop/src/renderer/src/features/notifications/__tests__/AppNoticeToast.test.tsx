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
});
