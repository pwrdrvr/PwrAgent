import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppNoticeStack } from "../AppNoticeStack";
import type { AppNoticeToastNotice } from "../AppNoticeToast";
import { placeToastStack } from "../toast-stack-placement";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The stack as measured at the 960x640 minimum window: 16px in from the
// edges, 208px tall, under a 40px chrome band.
const STACK = { left: 16, right: 436, height: 208 };
const GEOMETRY = { stack: STACK, viewportHeight: 640, edge: 16, chromeBand: 40 };

describe("placeToastStack", () => {
  it("moves to the top when the bottom covers the focused control", () => {
    // The composer's Workspace mode button.
    const focused = { left: 376, top: 558, right: 455, bottom: 584 };
    expect(placeToastStack({ ...GEOMETRY, current: "bottom", focused })).toBe("top");
  });

  it("goes back down when the top covers the focused control", () => {
    // The sidebar's first thread row.
    const focused = { left: 16, top: 120, right: 350, bottom: 170 };
    expect(placeToastStack({ ...GEOMETRY, current: "top", focused })).toBe("bottom");
  });

  it("stays put when neither edge covers the focused control", () => {
    const focused = { left: 600, top: 558, right: 680, bottom: 584 };
    expect(placeToastStack({ ...GEOMETRY, current: "top", focused })).toBe("top");
    expect(placeToastStack({ ...GEOMETRY, current: "bottom", focused })).toBe("bottom");
  });

  it("takes the edge that covers less of a control both edges reach", () => {
    // The transcript scroller runs the pane's full height; the bottom
    // position clips its corner, the top position a far larger piece.
    const focused = { left: 360, top: 40, right: 672, bottom: 454 };
    expect(placeToastStack({ ...GEOMETRY, current: "bottom", focused })).toBe("bottom");
    expect(placeToastStack({ ...GEOMETRY, current: "top", focused })).toBe("bottom");
  });
});

function place(
  element: Element,
  box: { left: number; top: number; right: number; bottom: number },
): void {
  element.getBoundingClientRect = () =>
    ({
      ...box,
      x: box.left,
      y: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
      toJSON: () => box,
    }) as DOMRect;
}

const NOTICE: AppNoticeToastNotice = {
  id: "thread-action-error:create-thread",
  title: "Could not start thread",
  message: "The launchpad did not open.",
  autoDismiss: false,
};

// jsdom lays nothing out, so each control gets the rect it has at 960x768,
// and the stack a fixed 208px box. Only its height and horizontal extent
// feed the decision, so the box does not have to follow the placement.
function Shell(props: { notices: readonly AppNoticeToastNotice[] }) {
  return (
    <>
      <button type="button">Workspace mode</button>
      <AppNoticeStack durableNotices={props.notices} onDismissDurable={() => {}} />
      <button type="button">Send</button>
      <button type="button">First thread</button>
    </>
  );
}

function renderShell(notices: readonly AppNoticeToastNotice[]) {
  const view = render(<Shell notices={notices} />);
  const stack = document.querySelector<HTMLElement>(".app-toast-stack");
  if (!stack) throw new Error("no toast stack");
  stack.style.setProperty("--app-toast-stack-edge", "16px");
  stack.style.setProperty("--chrome-band-h", "40px");
  place(stack, { left: 16, top: 544, right: 436, bottom: 752 });
  place(screen.getByRole("button", { name: "Workspace mode" }), {
    left: 376, top: 686, right: 455, bottom: 712,
  });
  place(screen.getByRole("button", { name: "Send" }), {
    left: 860, top: 686, right: 930, bottom: 712,
  });
  place(screen.getByRole("button", { name: "First thread" }), {
    left: 16, top: 120, right: 350, bottom: 170,
  });
  return { ...view, stack };
}

// jsdom emulates `:focus-visible` from the last event it saw, and in a run of
// Tabs it marks only the first arrival. Chromium keeps the flag with the
// focus. Report the modality each test drives instead.
function focusVisibleWhile(keyboard: () => boolean): void {
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    if (selector === ":focus-visible") {
      return keyboard() && this === document.activeElement;
    }
    return matches.call(this, selector);
  });
}

// The hook measures a frame after focus moves, where Tab's scroll has settled.
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

describe("AppNoticeStack placement", () => {
  it("steps aside for keyboard focus it covers, and only then", async () => {
    focusVisibleWhile(() => true);
    const user = userEvent.setup();
    const { stack } = renderShell([NOTICE]);
    expect(stack).toHaveAttribute("data-placement", "bottom");

    await user.tab();
    expect(screen.getByRole("button", { name: "Workspace mode" })).toHaveFocus();
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "top");

    // Into the notice's own buttons: it does not move out from under them,
    // though the top edge now covers them.
    place(screen.getByRole("button", { name: "Copy notice" }), {
      left: 360, top: 80, right: 390, bottom: 110,
    });
    await user.tab();
    expect(stack).toContainElement(document.activeElement as HTMLElement);
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "top");

    // On past it to a control neither edge covers: it stays, so Tab along a
    // row of controls does not bounce it.
    const send = screen.getByRole("button", { name: "Send" });
    for (let step = 0; step < 10 && document.activeElement !== send; step += 1) {
      await user.tab();
    }
    expect(send).toHaveFocus();
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "top");

    // A control the top covers sends it home.
    await user.tab();
    expect(screen.getByRole("button", { name: "First thread" })).toHaveFocus();
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "bottom");
  });

  it("does not move for a click", async () => {
    focusVisibleWhile(() => false);
    const user = userEvent.setup();
    const { stack } = renderShell([NOTICE]);
    await user.click(screen.getByRole("button", { name: "Workspace mode" }));
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "bottom");
  });

  it("goes home once the last notice closes", async () => {
    focusVisibleWhile(() => true);
    const user = userEvent.setup();
    const { stack, rerender } = renderShell([NOTICE]);
    await user.tab();
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "top");

    rerender(<Shell notices={[]} />);
    place(stack, { left: 16, top: 752, right: 436, bottom: 752 });
    await user.tab();
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "bottom");
  });
});
