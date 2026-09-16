import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarShowMore } from "../SidebarShowMore";

describe("SidebarShowMore", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps a busy control focusable instead of disabling it", () => {
    // Every paging affordance in the rail routes through this component, and
    // while it carried the native `disabled` property a page arriving blurred
    // whichever one the operator was holding: a real engine moves focus to
    // `body` the instant the property lands, and clearing it puts focus back
    // nowhere. The busy window is short — 88ms, measured on a Windows CI
    // runner for the Star Map's equivalent chip (pwrdrvr/PwrAgent#2176) — so
    // a keyboard operator was dropped out of the rail entirely for a state
    // that was over before anything on screen could explain it.
    //
    // This pins the CAUSE rather than the blur. jsdom does not implement
    // blur-on-disable, so the `activeElement` assertion below passes against
    // the regression too; what separates them is the last pair of assertions
    // in this block, that the control is never given the native property.
    const onClick = vi.fn();
    const view = render(
      <SidebarShowMore busy label="Load more threads" onClick={onClick} />,
    );
    const button = screen.getByRole("button", { name: "Load more threads" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);

    button.focus();
    expect(document.activeElement).toBe(button);

    // `aria-disabled` stops no real click the way the property did, so the
    // block this component's `busy` prop promises has to be in the handler.
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    // The visible text is the accessible name here, so it must not change
    // while the page is in flight — renaming it mid-flight would move the
    // control out from under anyone searching for it by name.
    view.rerender(
      <SidebarShowMore label="Load more threads" onClick={onClick} />,
    );
    const settled = screen.getByRole("button", { name: "Load more threads" });
    expect(settled).toBe(button);
    expect(settled.hasAttribute("aria-disabled")).toBe(false);
    expect(settled.hasAttribute("aria-busy")).toBe(false);
    // Focus survived the whole busy window, which is the point of the swap.
    expect(document.activeElement).toBe(settled);
    fireEvent.click(settled);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
