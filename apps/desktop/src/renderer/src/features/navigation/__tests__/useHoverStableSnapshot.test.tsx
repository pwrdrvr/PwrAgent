import { act, renderHook } from "@testing-library/react";
import type { PointerEvent } from "react";
import { describe, expect, it } from "vitest";
import { useHoverStableSnapshot } from "../useHoverStableSnapshot";

type Props = { outstandingReads?: readonly string[]; value: string };

function renderSnapshot(initial: Props) {
  return renderHook((props: Props) => useHoverStableSnapshot({
    outstandingReads: props.outstandingReads,
    scope: "directories",
    value: props.value,
  }), { initialProps: initial });
}

/** What the browser dispatches when a row arrives under a resting pointer. */
function pointerOverRow(snapshot: ReturnType<typeof renderSnapshot>["result"]): void {
  const row = document.createElement("div");
  row.setAttribute("data-hover-stable-row", "");
  act(() => {
    snapshot.current.onPointerOver(
      { pointerType: "mouse", target: row } as unknown as PointerEvent<HTMLDivElement>,
    );
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("useHoverStableSnapshot reveal", () => {
  it("keeps a command's result visible when its own DOM change re-enters a row", async () => {
    const view = renderSnapshot({ value: "before" });
    pointerOverRow(view.result);
    const command = deferred();
    act(() => {
      void view.result.current.reveal(() => command.promise);
    });
    // The drop indicator clearing under the stationary pointer.
    pointerOverRow(view.result);
    view.rerender({ value: "after" });
    expect(view.result.current.value).toBe("after");

    await act(async () => {
      command.resolve();
      await command.promise;
    });
    view.rerender({ value: "settled" });
    expect(view.result.current.value).toBe("settled");
  });

  it("waits for the reads a command left outstanding before freezing again", async () => {
    const view = renderSnapshot({ value: "before" });
    pointerOverRow(view.result);
    const command = deferred();
    act(() => {
      void view.result.current.reveal(() => command.promise);
    });
    view.rerender({ outstandingReads: ["directory-pins"], value: "ranks" });
    await act(async () => {
      command.resolve();
      await command.promise;
    });

    pointerOverRow(view.result);
    view.rerender({ outstandingReads: ["directory-pins"], value: "ranks" });
    view.rerender({ outstandingReads: [], value: "reordered" });
    expect(view.result.current.value).toBe("reordered");

    // The read landed, so ordinary hover stability resumes.
    pointerOverRow(view.result);
    view.rerender({ outstandingReads: [], value: "background churn" });
    expect(view.result.current.value).toBe("reordered");
  });

  it("does not wait on reads invalidated after the command settled", async () => {
    const view = renderSnapshot({ outstandingReads: ["directory-pins"], value: "before" });
    const command = deferred();
    act(() => {
      void view.result.current.reveal(() => command.promise);
    });
    await act(async () => {
      command.resolve();
      await command.promise;
    });
    view.rerender({ outstandingReads: ["lens"], value: "reordered" });

    pointerOverRow(view.result);
    view.rerender({ outstandingReads: ["lens"], value: "background churn" });
    expect(view.result.current.value).toBe("reordered");
  });

  it("stops waiting when the pointer leaves the rows", async () => {
    const view = renderSnapshot({ outstandingReads: ["directory-pins"], value: "before" });
    const command = deferred();
    act(() => {
      void view.result.current.reveal(() => command.promise);
    });
    await act(async () => {
      command.resolve();
      await command.promise;
    });
    act(() => {
      view.result.current.onPointerLeave(
        { pointerType: "mouse" } as unknown as PointerEvent<HTMLDivElement>,
      );
    });

    pointerOverRow(view.result);
    view.rerender({ outstandingReads: ["directory-pins"], value: "background churn" });
    expect(view.result.current.value).toBe("before");
  });

  it("returns a synchronous result without holding the freeze open", () => {
    const view = renderSnapshot({ value: "before" });
    let result: number | undefined;
    act(() => {
      result = view.result.current.reveal(() => 7);
    });
    expect(result).toBe(7);

    pointerOverRow(view.result);
    view.rerender({ value: "background churn" });
    expect(view.result.current.value).toBe("before");
  });
});
