import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DiffStat } from "../DiffStat";

afterEach(cleanup);

describe("DiffStat", () => {
  it("renders +additions before -removals with no comma", () => {
    const { container } = render(<DiffStat additions={244} removals={3} />);
    const stat = container.querySelector(".diff-stat")!;

    expect(stat.textContent).toBe("+244-3");
    const children = [...stat.children];
    expect(children[0]).toHaveClass("diff-stat__added");
    expect(children[0]).toHaveTextContent("+244");
    expect(children[1]).toHaveClass("diff-stat__removed");
    expect(children[1]).toHaveTextContent("-3");
  });

  it("locale-formats large counts", () => {
    const { container } = render(<DiffStat additions={1234} removals={0} />);
    expect(container.querySelector(".diff-stat__added")).toHaveTextContent("+1,234");
  });

  it("applies the chip modifier when requested", () => {
    const { container } = render(
      <DiffStat additions={1} removals={0} className="diff-stat--chip" />,
    );
    expect(container.querySelector(".diff-stat")).toHaveClass("diff-stat--chip");
  });
});
