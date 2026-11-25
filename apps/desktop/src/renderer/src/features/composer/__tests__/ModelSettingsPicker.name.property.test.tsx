import { cleanup, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { ModelSettingsPicker } from "../ModelSettingsPicker";

afterEach(cleanup);

/** The text a reader sees: every text node outside aria-hidden. */
function visibleText(element: Element): string {
  const words: string[] = [];
  const walk = (node: Node): void => {
    if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return;
    if (node.nodeType === Node.TEXT_NODE) words.push(node.textContent ?? "");
    node.childNodes.forEach(walk);
  };
  walk(element);
  return words.join("");
}

/** axe's comparison form: lowercase, punctuation dropped, spaces collapsed. */
function curate(text: string): string {
  return text.toLowerCase().replace(/[\p{P}\p{S}]/gu, "").replace(/\s+/g, " ").trim();
}

const label = fc.stringMatching(/^[A-Z][a-z]{1,6}( [0-9](\.[0-9])?)?$/);

/**
 * axe's label-content-name-mismatch: a control named by aria-label must
 * contain its visible text. The pill once ran its parts together
 * ("Opus 5.5high"), which no name contains, and failed the a11y gate.
 */
describe("model settings pill name", () => {
  it("contains the pill's visible text for any provider, model, effort and speed", () => {
    fc.assert(fc.property(
      fc.record({
        provider: fc.option(label, { nil: undefined }),
        model: label,
        stops: fc.uniqueArray(fc.constantFrom("low", "medium", "high", "xhigh", "max"), { maxLength: 5 }),
        pick: fc.nat(),
        speed: fc.option(fc.constantFrom("standard" as const, "fast" as const, "ultrafast" as const), { nil: undefined }),
        size: fc.constantFrom("composer" as const, "card" as const, "setting" as const),
      }),
      ({ provider, model, stops, pick, speed, size }) => {
        try {
          render(
            <ModelSettingsPicker
              size={size}
              provider={provider ? { label: provider, showInPill: true } : undefined}
              model={{ value: "m", label: model, kind: "codex", models: [], onChange: () => undefined }}
              {...(stops.length > 0 ? {
                effort: { stops, value: stops[pick % stops.length], onChange: () => undefined },
              } : {})}
              {...(speed ? {
                speed: { options: ["standard", "fast", "ultrafast"], value: speed, onChange: () => undefined },
              } : {})}
            />,
          );
          const pill = screen.getByRole("button", { name: /^Model settings/ });
          const visible = curate(visibleText(pill));
          expect(visible.length).toBeGreaterThan(0);
          expect(curate(pill.getAttribute("aria-label") ?? "")).toContain(visible);
        } finally {
          cleanup();
        }
      },
    ), { numRuns: 60 });
  });
});
