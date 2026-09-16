import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StarMapProjectBody } from "../StarMapProjectBody";

function tooltipText(): string[] {
  return [...document.querySelectorAll(".viewport-tooltip")].map(
    (node) => node.textContent ?? "",
  );
}

describe("StarMapProjectBody", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps a loading continuation focusable and keeps its tooltip up", () => {
    // A project-query refresh holds `loadingThreads` for well under a tenth
    // of a second — 88ms, measured on a Windows CI runner in
    // pwrdrvr/PwrAgent#2176. While this button carried the native `disabled`
    // property, a real engine blurred it the instant that window opened:
    // focus went to `body`, and clearing the property brought it back
    // nowhere. The operator lost their place on a map of hundreds of cards,
    // and — because this control is icon-only and its tooltip is shown on
    // focus — lost the only visible name it has along with it.
    //
    // Pins the CAUSE, not the blur: jsdom does not implement
    // blur-on-disable, so the `activeElement` assertions here pass against
    // the regression too. What separates them is that the button is never
    // given the native property.
    const onLoadMoreThreads = vi.fn();
    const label = "Load more threads from instances in acme";
    const view = render(
      <StarMapProjectBody label="acme" projectKey="acme" threadCount={12}
        onLoadMoreThreads={onLoadMoreThreads}
      />,
    );
    const button = screen.getByRole("button", { name: label });
    button.focus();
    fireEvent.focus(button);
    expect(document.activeElement).toBe(button);
    expect(tooltipText()).toEqual([label]);

    view.rerender(
      <StarMapProjectBody label="acme" projectKey="acme" threadCount={12}
        loadingThreads onLoadMoreThreads={onLoadMoreThreads}
      />,
    );
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    // No blur, so no `onBlur`, so the tooltip naming this control is still up
    // — the refresh is invisible to the operator's place on the map.
    expect(document.activeElement).toBe(button);
    expect(tooltipText()).toEqual([label]);

    // `aria-disabled` stops no real click the way the property did, so the
    // handler has to refuse the press itself.
    fireEvent.click(button);
    expect(onLoadMoreThreads).not.toHaveBeenCalled();

    view.rerender(
      <StarMapProjectBody label="acme" projectKey="acme" threadCount={12}
        onLoadMoreThreads={onLoadMoreThreads}
      />,
    );
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onLoadMoreThreads).toHaveBeenCalledTimes(1);
  });

  it("refuses a restart press while the project is still loading", () => {
    // The same button becomes Restart once the anchor is gone, and it reads
    // the same `loadingThreads`. The refusal is on the shared handler, so
    // this is the half of it a Load-more-only test cannot reach.
    const onRestartThreads = vi.fn();
    const view = render(
      <StarMapProjectBody label="acme" projectKey="acme" threadCount={12}
        loadingThreads onRestartThreads={onRestartThreads}
      />,
    );
    const button = screen.getByRole("button", { name: "Restart acme threads" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(onRestartThreads).not.toHaveBeenCalled();

    view.rerender(
      <StarMapProjectBody label="acme" projectKey="acme" threadCount={12}
        onRestartThreads={onRestartThreads}
      />,
    );
    fireEvent.click(button);
    expect(onRestartThreads).toHaveBeenCalledTimes(1);
  });
});
