import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppNoticeStack } from "../AppNoticeStack";
import type { AppNoticeToastNotice } from "../AppNoticeToast";
import { buildSpendAlertNotice } from "../spend-alert-notice";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * jsdom lays nothing out, so each card's size is whatever the test reports
 * through the ResizeObserver the card watches itself with. The geometry the
 * hold exists for is measured in Chromium by `notice-stack-close.spec.ts`.
 */
function stubCardLayout() {
  const callbacks = new Map<Element, ResizeObserverCallback>();
  class FakeResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      callbacks.set(target, this.callback);
    }
    unobserve(target: Element) {
      callbacks.delete(target);
    }
    disconnect() {
      for (const [target, callback] of callbacks) {
        if (callback === this.callback) callbacks.delete(target);
      }
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return (card: Element, width: number, height: number) => {
    act(() => {
      callbacks.get(card)?.(
        [{
          target: card,
          borderBoxSize: [{ inlineSize: width, blockSize: height }],
        } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
  };
}

function DurableHarness(props: { initial: AppNoticeToastNotice[] }) {
  const [notices, setNotices] = useState(props.initial);
  return (
    <AppNoticeStack
      durableNotices={notices}
      onDismissDurable={(id) => {
        setNotices((current) => current.filter((notice) => notice.id !== id));
      }}
    />
  );
}

const SHORT_THEN_TALL: AppNoticeToastNotice[] = [
  { id: "short", title: "Short", message: "One line.", autoDismiss: false },
  {
    id: "tall",
    title: "Tall",
    message: "A message long enough to wrap onto several lines of the card.",
    detail: "And a detail line under it.",
    autoDismiss: false,
  },
  { id: "last", title: "Last", message: "Done.", autoDismiss: false },
];

describe("AppNoticeStack", () => {
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

  it("holds the card at the closed notice's size while the pointer stays on the stack", () => {
    const layOut = stubCardLayout();
    const { container } = render(<DurableHarness initial={SHORT_THEN_TALL} />);
    const stack = container.querySelector(".app-toast-stack")!;
    const card = container.querySelector<HTMLElement>(".app-notice-toast")!;
    layOut(card, 300, 92);

    fireEvent.pointerEnter(stack);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));

    // The next notice draws in the same card, at the size of the one that
    // closed, so the close button stays under the pointer.
    expect(screen.getByText("Tall")).toBeInTheDocument();
    expect(container.querySelector(".app-notice-toast")).toBe(card);
    expect(card).toHaveAttribute("data-held", "true");
    expect(card.style.width).toBe("300px");
    expect(card.style.height).toBe("92px");

    // Through a run of closes, not just the first.
    layOut(card, 300, 92);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(screen.getByText("Last")).toBeInTheDocument();
    expect(card.style.height).toBe("92px");

    // Leaving the stack lets the card fit its own notice again.
    fireEvent.pointerLeave(stack);
    expect(card).not.toHaveAttribute("data-held");
    expect(card.style.width).toBe("");
    expect(card.style.height).toBe("");
  });

  it("holds the card through paging too, and not for a pointer elsewhere", () => {
    const layOut = stubCardLayout();
    const { container } = render(<DurableHarness initial={SHORT_THEN_TALL} />);
    const stack = container.querySelector(".app-toast-stack")!;
    const card = container.querySelector<HTMLElement>(".app-notice-toast")!;
    layOut(card, 300, 92);

    // A keyboard close, with the pointer off the stack, moves nothing the
    // pointer is on, so there is nothing to hold.
    fireEvent.click(screen.getByRole("button", { name: "Next notice" }));
    expect(screen.getByText("Tall")).toBeInTheDocument();
    expect(card).not.toHaveAttribute("data-held");

    layOut(card, 320, 140);
    fireEvent.pointerEnter(stack);
    fireEvent.click(screen.getByRole("button", { name: "Previous notice" }));
    expect(screen.getByText("Short")).toBeInTheDocument();
    expect(card.style.width).toBe("320px");
    expect(card.style.height).toBe("140px");
  });
});
