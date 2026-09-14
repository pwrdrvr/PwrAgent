import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useEventCallback } from "../useEventCallback";

afterEach(cleanup);

describe("useEventCallback", () => {
  it("keeps one identity across renders", () => {
    const seen: Array<() => void> = [];
    function Host({ value }: { value: number }) {
      seen.push(useEventCallback(() => value));
      return <span>{value}</span>;
    }

    const { rerender } = render(<Host value={0} />);
    for (let round = 1; round <= 5; round += 1) rerender(<Host value={round} />);

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(1);
  });

  it("runs the newest closure, not the one it was created with", () => {
    // The half that makes the stable identity safe: a `useCallback([])` here
    // would keep calling the first render's `value`.
    let handler: (() => number) | undefined;
    function Host({ value }: { value: number }) {
      handler = useEventCallback(() => value);
      return <span>{value}</span>;
    }

    const { rerender } = render(<Host value={1} />);
    expect(handler?.()).toBe(1);

    rerender(<Host value={2} />);

    expect(handler?.()).toBe(2);
  });

  it("forwards arguments and the return value", () => {
    let handler: ((a: number, b: number) => number) | undefined;
    function Host() {
      handler = useEventCallback((a: number, b: number) => a + b);
      return null;
    }

    render(<Host />);

    expect(handler?.(2, 3)).toBe(5);
  });
});
