import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppNoticeStack } from "../AppNoticeStack";
import type { AppNoticeToastNotice } from "../AppNoticeToast";
import { buildSpendAlertNotice } from "../spend-alert-notice";

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe("AppNoticeStack", () => {
  it("records queued cards separately from the displayed and dismissed ones", () => {
    const recordToastHistory = vi.fn();
    vi.stubGlobal("pwragent", { recordToastHistory });
    const approval = { id: "operator-approval:fixture-id", title: "Approval", message: "Fixture prompt", autoDismiss: false };
    const warning = { id: "config-file-invalid", title: "Settings", message: "Fixture error", autoDismiss: false };
    const dismiss = vi.fn();
    render(<AppNoticeStack durableNotices={[approval, warning]} onDismissDurable={dismiss} />);
    const observations = () => recordToastHistory.mock.calls.map(([{ category, phase }]) => [category, phase]);

    expect(observations()).toEqual([
      ["approval", "queued"], ["configuration", "queued"], ["approval", "displayed"],
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Next notice" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(observations().slice(3)).toEqual([
      ["configuration", "displayed"], ["configuration", "dismissed"],
    ]);
    expect(dismiss).toHaveBeenCalledWith(warning.id);
    expect(JSON.stringify(recordToastHistory.mock.calls)).not.toContain("Fixture error");
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
