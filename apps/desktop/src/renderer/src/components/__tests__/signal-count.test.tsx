import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SignalCount } from "../SignalCount";

/**
 * The one shape the app uses to say "this many, and here is what kind".
 *
 * It exists because three renderings of it were once visible in a single
 * window: the Attention tab drew mark-then-count in mono, the directory
 * header counts drew count-then-mark, and the live strips drew a bordered
 * pill with no mark at all. These tests pin the parts that made them read as
 * different objects — the order, and the absence of chrome — so a fourth
 * rendering cannot appear without failing here first.
 */

describe("SignalCount", () => {
  it("draws the mark before the digits", () => {
    // The direction the whole primitive exists to settle. The mark says
    // WHICH number this is, so it leads; a surface that flips it reads as a
    // different control even with identical tokens.
    const { container } = render(
      <SignalCount
        count={4}
        indicator={<span data-testid="mark" />}
        tone="active"
      />,
    );
    const signal = container.querySelector(".signal-count")!;
    const children = [...signal.children];
    expect(children[0]).toHaveAttribute("data-testid", "mark");
    expect(children[1]).toHaveClass("signal-count__value");
    expect(children[1]).toHaveTextContent("4");
  });

  it("carries the tone as a modifier and nothing else", () => {
    for (const tone of ["active", "remote-active", "idle"] as const) {
      const { container } = render(
        <SignalCount count={1} indicator={<span />} tone={tone} />,
      );
      expect(container.querySelector(".signal-count")).toHaveClass(
        `signal-count--${tone}`,
      );
    }
  });

  it("greys a zero rather than hiding it, and only a zero", () => {
    // An idle surface has to read as "nothing here", which a vanishing count
    // cannot do — the same rule the Attention tab has always followed.
    const zero = render(
      <SignalCount count={0} indicator={<span />} tone="active" />,
    );
    expect(zero.container.querySelector(".signal-count")).toHaveAttribute(
      "data-zero",
      "true",
    );
    expect(zero.container.querySelector(".signal-count")).toHaveTextContent("0");

    const live = render(
      <SignalCount count={2} indicator={<span />} tone="active" />,
    );
    expect(
      live.container.querySelector(".signal-count"),
    ).not.toHaveAttribute("data-zero");
  });

  it("stays in the accessibility tree unless the caller opts out", () => {
    // The directory counts ARE the announcement; the Attention readouts hide
    // because their control's aria-label already spells every count out.
    const spoken = render(
      <SignalCount count={1} indicator={<span />} tone="idle" />,
    );
    expect(
      spoken.container.querySelector(".signal-count"),
    ).not.toHaveAttribute("aria-hidden");

    const silent = render(
      <SignalCount ariaHidden count={1} indicator={<span />} tone="idle" />,
    );
    expect(silent.container.querySelector(".signal-count")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
