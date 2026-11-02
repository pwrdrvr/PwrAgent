import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { reducedMotionPairedRingSelectors } from "../../styles/__tests__/css-style-rules";
import { PendingSpinner } from "../PendingSpinner";

/**
 * The busy ring's reduced-motion decision lives in its `pairing` prop. These
 * tests hold the prop to what `app.css` does with it: a paired ring matches
 * the selector the reduce rule stops, and a standalone ring does not.
 */
describe("PendingSpinner", () => {
  const pairedRing = reducedMotionPairedRingSelectors.join(", ");

  it("stops a paired ring under reduced motion", () => {
    expect(reducedMotionPairedRingSelectors.length).toBeGreaterThan(0);
    const { container } = render(<PendingSpinner pairing="paired" size="sm" />);
    const ring = container.querySelector(".pending-spinner");
    expect(ring?.matches(pairedRing)).toBe(true);
    expect(ring).toHaveClass("pending-spinner--sm");
    expect(ring).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps a standalone ring spinning and renders no reason text", () => {
    const { container } = render(
      <PendingSpinner pairing="standalone" standaloneReason="Only signal on a bare button." />,
    );
    const ring = container.querySelector(".pending-spinner");
    expect(ring?.matches(pairedRing)).toBe(false);
    expect(ring).toHaveAttribute("aria-hidden", "true");
    // The reason is for the call site and review, not for the operator.
    expect(container.textContent).toBe("");
    expect(ring?.className).toBe("pending-spinner");
  });

  it("makes the reduced-motion decision a required prop", () => {
    // `pnpm typecheck` holds these: a ring must say how it pairs, a standalone
    // ring must say why, and a paired ring takes no reason.
    // @ts-expect-error `pairing` is required.
    const undecided = <PendingSpinner size="sm" />;
    // @ts-expect-error a standalone ring needs `standaloneReason`.
    const unexplained = <PendingSpinner pairing="standalone" />;
    // @ts-expect-error a paired ring takes no `standaloneReason`.
    const contradicted = <PendingSpinner pairing="paired" standaloneReason="Spins." />;
    expect([undecided, unexplained, contradicted]).toHaveLength(3);
  });

  it("draws the large ring for a preview tile", () => {
    const { container } = render(<PendingSpinner pairing="paired" size="lg" />);
    expect(container.querySelector(".pending-spinner")).toHaveClass("pending-spinner--lg");
  });
});
