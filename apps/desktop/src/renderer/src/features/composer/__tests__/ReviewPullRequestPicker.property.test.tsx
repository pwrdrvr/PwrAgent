import fc from "fast-check";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { ReviewPullRequestPicker } from "../ReviewPullRequestPicker";
import {
  build,
  modelOrder,
  specArb,
} from "../../pr-status/__tests__/pr-rollup-order-model";

/**
 * Rule: the Attached PR review target lists a thread's PRs in the order the
 * sidebar's PR popover uses (open above finished, each stack newest first),
 * and reports a selection in that order whatever order the boxes were
 * checked in, because a batch is reviewed in the order it is reported.
 *
 * The native select this replaced listed PRs in attachment order, so the
 * oldest merged PR sat on top and the open one at the bottom.
 */

function numberOf(url: string): number {
  return Number(/\/pull\/(\d+)$/.exec(url)![1]);
}

function inputs(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>("input.review-pr-picker__input")];
}

function Picker(props: {
  prs: PrSummary[];
  selectedUrls: string[];
  onChange: (urls: string[]) => void;
}) {
  return (
    <ReviewPullRequestPicker
      prs={props.prs}
      selectedUrls={props.selectedUrls}
      multiple
      repositoryLabel={() => ""}
      onChange={props.onChange}
    />
  );
}

describe("ReviewPullRequestPicker order properties", () => {
  afterEach(cleanup);

  it("lists PRs in the stack model's order", () => {
    fc.assert(
      fc.property(fc.array(specArb, { minLength: 1, maxLength: 8 }), (specs) => {
        const prs = build(specs);
        const { container, unmount } = render(
          <Picker prs={prs} selectedUrls={[]} onChange={() => undefined} />,
        );
        const listed = inputs(container).map((input) => numberOf(input.value));
        unmount();
        expect(listed).toEqual(modelOrder(prs));
      }),
      { numRuns: 60 },
    );
  });

  it("reports the checked PRs in list order, whatever order they were checked in", () => {
    fc.assert(
      fc.property(
        fc.array(specArb, { minLength: 2, maxLength: 6 }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 8 }),
        (specs, picks) => {
          const prs = build(specs);
          let selected: string[] = [];
          const onChange = (urls: string[]): void => {
            selected = urls;
          };
          const { container, rerender, unmount } = render(
            <Picker prs={prs} selectedUrls={selected} onChange={onChange} />,
          );
          const toggles = new Map<string, number>();
          for (const pick of picks) {
            const url = prs[pick % prs.length]!.url;
            toggles.set(url, (toggles.get(url) ?? 0) + 1);
            fireEvent.click(inputs(container).find((input) => input.value === url)!);
            rerender(<Picker prs={prs} selectedUrls={selected} onChange={onChange} />);
          }
          unmount();
          const order = modelOrder(prs);
          const expected = order
            .map((number) => prs.find((pr) => pr.number === number)!.url)
            .filter((url) => (toggles.get(url) ?? 0) % 2 === 1);
          expect(selected).toEqual(expected);
        },
      ),
      { numRuns: 60 },
    );
  });
});
