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
  it("moves to the top when the bottom hides the focused control", () => {
    // The last sidebar row's pin button.
    const focused = { left: 300, top: 560, right: 324, bottom: 584 };
    expect(placeToastStack({ ...GEOMETRY, current: "bottom", focused })).toBe("top");
  });

  it("stays for a control the bottom only partly covers", () => {
    // The composer's Workspace mode button, 19px of it still showing.
    const focused = { left: 376, top: 558, right: 455, bottom: 584 };
    expect(placeToastStack({ ...GEOMETRY, current: "bottom", focused })).toBe("bottom");
    // A sidebar row whose right end shows past the stack.
    const row = { left: 16, top: 560, right: 460, bottom: 610 };
    expect(placeToastStack({ ...GEOMETRY, current: "bottom", focused: row })).toBe("bottom");
  });

  it("goes back down when the top hides the focused control", () => {
    // The sidebar's first thread row.
    const focused = { left: 16, top: 120, right: 350, bottom: 170 };
    expect(placeToastStack({ ...GEOMETRY, current: "top", focused })).toBe("bottom");
  });

  it("stays put when neither edge hides the focused control", () => {
    const focused = { left: 600, top: 558, right: 680, bottom: 584 };
    expect(placeToastStack({ ...GEOMETRY, current: "top", focused })).toBe("top");
    expect(placeToastStack({ ...GEOMETRY, current: "bottom", focused })).toBe("bottom");
    // The transcript scroller runs the pane's full height; either edge clips
    // a piece of it, and neither hides it.
    const scroller = { left: 360, top: 40, right: 672, bottom: 454 };
    expect(placeToastStack({ ...GEOMETRY, current: "bottom", focused: scroller })).toBe("bottom");
    expect(placeToastStack({ ...GEOMETRY, current: "top", focused: scroller })).toBe("top");
  });

  it("counts a sub-pixel sliver as hidden", () => {
    const focused = { left: 15.5, top: 560, right: 40, bottom: 584.5 };
    expect(placeToastStack({ ...GEOMETRY, current: "bottom", focused })).toBe("top");
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
      <button type="button">Pin thread</button>
      <AppNoticeStack durableNotices={props.notices} onDismissDurable={() => {}} />
      <button type="button">Send</button>
      <button type="button">First thread</button>
      <input aria-label="Search threads" />
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
  // Partly under the stack at the bottom.
  place(screen.getByRole("button", { name: "Workspace mode" }), {
    left: 376, top: 686, right: 455, bottom: 712,
  });
  // Entirely under the stack at the bottom.
  place(screen.getByRole("button", { name: "Pin thread" }), {
    left: 300, top: 690, right: 324, bottom: 714,
  });
  place(screen.getByRole("textbox", { name: "Search threads" }), {
    left: 40, top: 600, right: 300, bottom: 624,
  });
  place(screen.getByRole("button", { name: "Send" }), {
    left: 860, top: 686, right: 930, bottom: 712,
  });
  // Entirely under the stack at the top.
  place(screen.getByRole("button", { name: "First thread" }), {
    left: 16, top: 120, right: 350, bottom: 170,
  });
  return { ...view, stack };
}

// jsdom emulates `:focus-visible` from the last event it saw, and in a run of
// Tabs it marks only the first arrival. Chromium keeps the flag with the
// focus, and matches it for a text field on click. Report the modality each
// test drives instead, and whether the pointer rests on the stack.
function matchWhile(state: { focusVisible: () => boolean; stackHovered?: () => boolean }): void {
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    if (selector === ":focus-visible") {
      return state.focusVisible() && this === document.activeElement;
    }
    if (selector === ":hover" && this.classList.contains("app-toast-stack")) {
      return state.stackHovered?.() ?? false;
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
  it("steps aside only for keyboard focus it hides entirely", async () => {
    matchWhile({ focusVisible: () => true });
    const user = userEvent.setup();
    const { stack } = renderShell([NOTICE]);
    expect(stack).toHaveAttribute("data-placement", "bottom");

    // Partly covered: still visible, so the stack stays.
    await user.tab();
    expect(screen.getByRole("button", { name: "Workspace mode" })).toHaveFocus();
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "bottom");

    await user.tab();
    expect(screen.getByRole("button", { name: "Pin thread" })).toHaveFocus();
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

    // A control the top hides sends it home.
    await user.tab();
    expect(screen.getByRole("button", { name: "First thread" })).toHaveFocus();
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "bottom");
  });

  it("does not move for a click, even into a text field it hides", async () => {
    // Chromium matches `:focus-visible` on a text field clicked into.
    matchWhile({ focusVisible: () => true });
    const user = userEvent.setup();
    const { stack } = renderShell([NOTICE]);
    await user.click(screen.getByRole("textbox", { name: "Search threads" }));
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "bottom");
    await user.click(screen.getByRole("button", { name: "Pin thread" }));
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "bottom");
  });

  it("does not move for focus the app moves after a click", async () => {
    matchWhile({ focusVisible: () => true });
    const user = userEvent.setup();
    const { stack } = renderShell([NOTICE]);
    const pin = screen.getByRole("button", { name: "Pin thread" });
    screen.getByRole("button", { name: "Send" }).addEventListener("click", () => pin.focus());
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(pin).toHaveFocus();
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "bottom");
  });

  it("does not move when the stack or window changes size", async () => {
    matchWhile({ focusVisible: () => true });
    const user = userEvent.setup();
    const { stack } = renderShell([NOTICE]);
    await user.tab();
    expect(screen.getByRole("button", { name: "Workspace mode" })).toHaveFocus();
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "bottom");

    // Paging to a wider notice now hides the focused control. Focus did not
    // move, so the stack does not either.
    place(stack, { left: 16, top: 520, right: 480, bottom: 752 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "bottom");
  });

  it("does not slide out from under the pointer", async () => {
    let hovered = true;
    matchWhile({ focusVisible: () => true, stackHovered: () => hovered });
    const user = userEvent.setup();
    const { stack } = renderShell([NOTICE]);
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Pin thread" })).toHaveFocus();
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "bottom");

    hovered = false;
    await user.tab({ shift: true });
    await user.tab();
    await nextFrame();
    expect(stack).toHaveAttribute("data-placement", "top");
  });

  it("goes home once the last notice closes", async () => {
    matchWhile({ focusVisible: () => true });
    const user = userEvent.setup();
    const { stack, rerender } = renderShell([NOTICE]);
    await user.tab();
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
