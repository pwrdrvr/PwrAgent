import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import fc from "fast-check";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { PrRollupChip } from "../PrRollupChip";
import { resolvePrRollup } from "../pr-rollup";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pr(number: number): PrSummary {
  return {
    provider: "github.com",
    number,
    org: "acme",
    repo: "orbit",
    title: `Change ${number}`,
    url: `https://github.com/acme/orbit/pull/${number}`,
    state: "passing",
    checkState: "passing",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    mergeState: "mergeable",
  };
}

/** The thread's PR list, which a detach shrinks, as the app's snapshot does. */
function Harness(props: {
  initial: PrSummary[];
  onDetach: (pr: PrSummary) => void;
  onDetachAll: (prs: readonly PrSummary[]) => void;
}) {
  const [prs, setPrs] = useState(props.initial);
  return (
    <PrRollupChip
      prs={prs}
      repoPrefixedUrls=""
      threadTitle="Orbit refactor"
      onOpen={() => undefined}
      onDetach={(target) => {
        props.onDetach(target);
        setPrs((current) => current.filter((item) => item.url !== target.url));
      }}
      onDetachAll={props.onDetachAll}
    />
  );
}

function rowLabels(): string[] {
  return [...document.querySelectorAll(".pr-rollup-popover__row .pr-chip__label")]
    .map((label) => label.textContent ?? "");
}

const actionArbitrary = fc.record({
  via: fc.constantFrom("button", "delete-key"),
  pick: fc.nat(),
});

/**
 * Minimal's rollup had no way to detach one PR. The rule: each ✕ or Delete
 * detaches exactly the PR on its row, the list stays open on the PRs that
 * remain, and Delete leaves focus on the row that took the detached one's
 * place.
 */
describe("PrRollupChip detach properties", () => {
  it("detaches exactly the targeted PR and keeps the rest listed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 7 }),
        fc.array(actionArbitrary, { minLength: 1, maxLength: 6 }),
        (count, actions) => {
          const frames: FrameRequestCallback[] = [];
          vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
            frames.push(callback);
            return frames.length;
          });
          const initial = Array.from({ length: count }, (_, index) => pr(100 + index));
          const detached: PrSummary[] = [];
          const onDetachAll = vi.fn();
          const view = render(
            <Harness
              initial={initial}
              onDetach={(target) => detached.push(target)}
              onDetachAll={onDetachAll}
            />,
          );
          try {
            fireEvent.click(view.container.querySelector("[data-pr-rollup]")!);
            let model = initial;
            for (const action of actions) {
              if (model.length < 2) break;
              const ordered = resolvePrRollup(model)!.ordered;
              expect(rowLabels()).toEqual(ordered.map((item) => `#${item.number}`));
              const index = action.pick % ordered.length;
              const target = ordered[index]!;
              const rows = document.querySelectorAll<HTMLElement>(".pr-rollup-popover__row");
              if (action.via === "button") {
                fireEvent.click(
                  document.querySelectorAll<HTMLElement>(".pr-rollup-popover__detach")[index]!,
                );
              } else {
                act(() => rows[index]!.focus());
                fireEvent.keyDown(rows[index]!, { key: "Delete" });
              }
              model = model.filter((item) => item.url !== target.url);
              expect(detached.at(-1)).toBe(target);
              act(() => {
                frames.splice(0).forEach((frame) => frame(0));
              });
              if (model.length >= 2) {
                const remaining = document.querySelectorAll<HTMLElement>(
                  ".pr-rollup-popover__row",
                );
                expect(remaining).toHaveLength(model.length);
                if (action.via === "delete-key") {
                  expect(remaining[Math.min(index, model.length - 1)]).toHaveFocus();
                }
              } else {
                // One PR left: the plain chip, and no list.
                expect(document.querySelector(".pr-rollup-popover")).toBeNull();
                expect(view.container.querySelector("[data-pr-chip]")).toHaveTextContent(
                  `#${model[0]!.number}`,
                );
              }
            }
            expect(onDetachAll).not.toHaveBeenCalled();
            expect(new Set(detached.map((item) => item.url)).size).toBe(detached.length);
          } finally {
            view.unmount();
            vi.restoreAllMocks();
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("Detach all hands over every listed PR and closes the list", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 9 }), (count) => {
        const initial = Array.from({ length: count }, (_, index) => pr(200 + index));
        const onDetach = vi.fn();
        const onDetachAll = vi.fn();
        const view = render(
          <Harness initial={initial} onDetach={onDetach} onDetachAll={onDetachAll} />,
        );
        try {
          fireEvent.click(view.container.querySelector("[data-pr-rollup]")!);
          fireEvent.click(document.querySelector(".pr-rollup-popover__detach-all")!);
          expect(onDetachAll).toHaveBeenCalledTimes(1);
          const handed = onDetachAll.mock.calls[0]![0] as PrSummary[];
          expect(handed.map((item) => item.url).sort())
            .toEqual(initial.map((item) => item.url).sort());
          expect(onDetach).not.toHaveBeenCalled();
          expect(document.querySelector(".pr-rollup-popover")).toBeNull();
        } finally {
          view.unmount();
        }
      }),
      { numRuns: 20 },
    );
  });
});

describe("PrRollupChip detach controls", () => {
  it("draws no ✕ on Minimal's lone chip, but Delete still detaches it", () => {
    const onDetach = vi.fn();
    const lone = pr(7);
    const view = render(
      <PrRollupChip
        prs={[lone]}
        repoPrefixedUrls=""
        threadTitle="Orbit refactor"
        onOpen={() => undefined}
        onDetach={onDetach}
      />,
    );
    const chip = view.container.querySelector<HTMLElement>("[data-pr-chip]")!;
    expect(chip.querySelector(".pr-chip__detach")).toBeNull();
    fireEvent.keyDown(chip, { key: "Delete" });
    expect(onDetach).toHaveBeenCalledWith(lone);
  });

  it("offers no detach controls when the thread cannot detach", () => {
    const view = render(
      <PrRollupChip
        prs={[pr(1), pr(2)]}
        repoPrefixedUrls=""
        threadTitle="Orbit refactor"
        onOpen={() => undefined}
      />,
    );
    fireEvent.click(view.container.querySelector("[data-pr-rollup]")!);
    expect(document.querySelector(".pr-rollup-popover__detach")).toBeNull();
    expect(document.querySelector(".pr-rollup-popover__detach-all")).toBeNull();
  });

  it("walks Tab from the rows to Detach all, and Shift+Tab back", () => {
    const view = render(
      <PrRollupChip
        prs={[pr(1), pr(2), pr(3)]}
        repoPrefixedUrls=""
        threadTitle="Orbit refactor"
        onOpen={() => undefined}
        onDetach={() => undefined}
        onDetachAll={() => undefined}
      />,
    );
    fireEvent.click(view.container.querySelector("[data-pr-rollup]")!);
    const rows = document.querySelectorAll<HTMLElement>(".pr-rollup-popover__row");
    const detachAll = document.querySelector<HTMLElement>(".pr-rollup-popover__detach-all")!;
    act(() => rows[0]!.focus());
    let moved = true;
    act(() => {
      moved = fireEvent.keyDown(rows[0]!, { key: "Tab" });
    });
    expect(moved).toBe(false);
    expect(detachAll).toHaveFocus();
    act(() => {
      moved = fireEvent.keyDown(detachAll, { key: "Tab", shiftKey: true });
    });
    expect(moved).toBe(false);
    expect(rows[2]).toHaveFocus();
  });
});
