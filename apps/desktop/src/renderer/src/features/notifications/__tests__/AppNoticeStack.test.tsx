import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppNoticeStack } from "../AppNoticeStack";
import type { AppNoticeToastNotice } from "../AppNoticeToast";
import { buildHotCpuCaptureNotice, buildHotCpuPostCapNotice } from "../hot-cpu-profile-notice";
import { buildSpendAlertNotice } from "../spend-alert-notice";

afterEach(cleanup);

describe("AppNoticeStack", () => {
  it("keeps a focused Rearm button on its original process until focus leaves the notice", () => {
    const rearmMain = vi.fn();
    const rearmRenderer = vi.fn();
    const main = {
      id: "main", title: "Main CPU profile captured", message: "Capture limit reached",
      revealOnArrival: true, actions: [{ label: "Rearm", onClick: rearmMain }],
    };
    const renderer = {
      ...main, id: "renderer", title: "Renderer CPU profile captured",
      actions: [{ label: "Rearm", onClick: rearmRenderer }],
    };
    const onDismissDurable = () => {};
    const { rerender } = render(<AppNoticeStack durableNotices={[main]} onDismissDurable={onDismissDurable} />);
    const button = screen.getByRole("button", { name: "Rearm" });
    act(() => button.focus());
    rerender(<AppNoticeStack durableNotices={[main, renderer]} onDismissDurable={onDismissDurable} />);

    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(rearmMain).toHaveBeenCalledOnce();
    expect(rearmRenderer).not.toHaveBeenCalled();
    expect(screen.getByText(main.title)).toBeInTheDocument();

    const copy = screen.getByRole("button", { name: "Copy notice" });
    act(() => copy.focus());
    expect(screen.getByText(main.title)).toBeInTheDocument();
    act(() => copy.blur());
    expect(screen.getByText(renderer.title)).toBeInTheDocument();
  });

  it("shows a post-cap CPU notice on arrival and leaves subsequent navigation in the operator's control", () => {
    const capture = { id: "capture", title: "CPU profile captured", message: "Saved", autoDismiss: false };
    const postCap = buildHotCpuPostCapNotice({
      captureCount: 5,
      capturedAt: "2026-11-25T18:00:00.000Z",
      sessionId: "test-session",
      target: "main",
    });
    const onDismissDurable = () => {};
    const { rerender } = render(
      <AppNoticeStack durableNotices={[capture]} onDismissDurable={onDismissDurable} />,
    );
    expect(screen.getByText(capture.title)).toBeInTheDocument();

    rerender(<AppNoticeStack durableNotices={[capture, postCap]} onDismissDurable={onDismissDurable} />);
    expect(screen.getByText("Main process high CPU detected after capture limit")).toBeInTheDocument();
    expect(screen.getByText("Detected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous notice" }));
    rerender(<AppNoticeStack durableNotices={[capture, { ...postCap }]} onDismissDurable={onDismissDurable} />);
    expect(screen.getByText(capture.title)).toBeInTheDocument();
  });

  it("offers Rearm on the final capture and confirms the new capture budget", async () => {
    const event = {
      capturedAt: "2026-11-25T18:00:00.000Z",
      profileFilename: "main-hot-0005.cpuprofile",
      profilePath: "/example/main-hot-0005.cpuprofile",
      sessionDirectory: "/example",
      sessionDirectoryName: "hot-cpu-example",
      target: "main" as const,
      triggerConsecutiveSamples: 3,
      triggerCpuPercent: 68,
      triggerMode: "sustained" as const,
      triggerThresholdPercent: 50,
    };
    const request = Promise.withResolvers<boolean>();
    const rearm = vi.fn(() => request.promise);

    function Harness() {
      const [notice, setNotice] = useState(() => buildHotCpuCaptureNotice(
        { ...event, captureLimit: 5 }, rearm, (updated) => setNotice(updated),
      ));
      return <AppNoticeStack durableNotices={[notice]} onDismissDurable={() => {}} />;
    }

    expect(buildHotCpuCaptureNotice(event, rearm, vi.fn()).actions).toBeUndefined();
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Rearm" }));
    expect(rearm).toHaveBeenCalledExactlyOnceWith({
      sessionDirectoryName: event.sessionDirectoryName,
      profileFilename: event.profileFilename,
    });
    expect(screen.getByText("Rearming CPU profiling…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rearm" })).not.toBeInTheDocument();
    request.resolve(true);
    expect(await screen.findByText("Rearmed for up to 5 more captures.")).toBeInTheDocument();
  });

  it("navigates durable notices in order and dismisses each one independently", async () => {
    const initial: AppNoticeToastNotice[] = [
      { id: "first", title: "First", message: "One", autoDismiss: false },
      { id: "second", title: "Second", message: "Two", autoDismiss: false },
      { id: "third", title: "Third", message: "Three", autoDismiss: false },
    ];

    function Harness() {
      const [notices, setNotices] = useState(initial);
      return (
        <AppNoticeStack
          durableNotices={notices}
          onDismissDurable={(id) => {
            setNotices((current) => current.filter((notice) => notice.id !== id));
          }}
        />
      );
    }

    render(<Harness />);

    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.queryByText("Second")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous notice" }))
      .toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next notice" }));
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(screen.getByText("2 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(await screen.findByText("Third")).toBeInTheDocument();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous notice" }));
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.queryByText("Second")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(await screen.findByText("Third")).toBeInTheDocument();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous notice" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "Next notice" }))
      .toBeDisabled();
  });

  it("dismisses every notice in the active notice group", async () => {
    const costGroup = {
      key: "thread-cost",
      label: "cost notices",
    };
    const initial = [
      {
        autoDismiss: false,
        dismissGroup: costGroup,
        id: "cost-a",
        message: "One",
        title: "Cost A",
      },
      {
        autoDismiss: false,
        dismissGroup: costGroup,
        id: "cost-b",
        message: "Two",
        title: "Cost B",
      },
      {
        autoDismiss: false,
        id: "failure",
        message: "Three",
        title: "Turn failed",
      },
    ] as AppNoticeToastNotice[];

    function Harness() {
      const [notices, setNotices] = useState(initial);
      return (
        <AppNoticeStack
          durableNotices={notices}
          onDismissDurable={(id) => {
            setNotices((current) => current.filter((notice) => notice.id !== id));
          }}
        />
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByRole("button", {
      name: "Dismiss all cost notices",
    }));

    expect(await screen.findByText("Turn failed")).toBeInTheDocument();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
    expect(screen.queryByText("Cost A")).not.toBeInTheDocument();
    expect(screen.queryByText("Cost B")).not.toBeInTheDocument();
  });

  it("navigates and dismisses matching thread ids from separate peers independently", async () => {
    const alert = {
      alertId: "spend-alert:thread:codex:thread-a:25000000",
      createdAt: 1_800_000_000_000,
      currency: "USD" as const,
      kind: "thread-spend" as const,
      spendMicros: 31_000_000,
      threadId: "thread-a",
      thresholdMicros: 25_000_000,
    };
    const initial = [
      {
        ...buildSpendAlertNotice({
          alert,
          backend: "codex",
          instanceId: "peer-a",
        }),
        title: "Peer A spend",
      },
      {
        ...buildSpendAlertNotice({
          alert,
          backend: "codex",
          instanceId: "peer-b",
        }),
        title: "Peer B spend",
      },
    ];
    expect(initial[0]?.id).not.toBe(initial[1]?.id);

    function Harness() {
      const [notices, setNotices] = useState(initial);
      return (
        <AppNoticeStack
          durableNotices={notices}
          onDismissDurable={(id) => {
            setNotices((current) => current.filter((notice) => notice.id !== id));
          }}
        />
      );
    }

    render(<Harness />);

    expect(screen.getByText("Peer A spend")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next notice" }));
    expect(screen.getByText("Peer B spend")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(await screen.findByText("Peer A spend")).toBeInTheDocument();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });
});
