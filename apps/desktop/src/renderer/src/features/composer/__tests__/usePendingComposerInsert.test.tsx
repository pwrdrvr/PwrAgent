import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePendingComposerInsert } from "../usePendingComposerInsert";

function renderPending(initial: string | undefined) {
  return renderHook(
    ({ shown }: { shown: string | undefined }) => usePendingComposerInsert(shown),
    { initialProps: { shown: initial } },
  );
}

describe("usePendingComposerInsert", () => {
  it("waits while its thread is shown and drops once the view leaves it", () => {
    const view = renderPending("codex:a");
    act(() => view.result.current.issue("codex:a", "Watch CI on #1"));
    expect(view.result.current.request).toMatchObject({ threadKey: "codex:a", text: "Watch CI on #1" });
    view.rerender({ shown: "codex:b" });
    expect(view.result.current.request).toBeUndefined();
    view.rerender({ shown: "codex:a" });
    expect(view.result.current.request).toBeUndefined();
  });

  it("drops a request whose thread the selection never reached", () => {
    // The selection settled on another thread, or on Settings. The request
    // used to wait until the operator opened that thread later and then
    // appended to its draft.
    const view = renderPending("codex:b");
    act(() => view.result.current.issue("codex:a", "Watch CI on #1"));
    expect(view.result.current.request).toBeUndefined();
    view.rerender({ shown: "codex:a" });
    expect(view.result.current.request).toBeUndefined();

    const settings = renderPending(undefined);
    act(() => settings.result.current.issue("codex:a", "Watch CI on #1"));
    expect(settings.result.current.request).toBeUndefined();
  });

  it("lets a newer request replace an older one, and clears on handled", () => {
    const view = renderPending("codex:a");
    act(() => view.result.current.issue("codex:a", "first"));
    const first = view.result.current.request!;
    act(() => view.result.current.issue("codex:a", "second"));
    expect(view.result.current.request).toMatchObject({ text: "second" });
    // A late answer for the replaced request leaves the newer one alone.
    act(() => view.result.current.handled(first.id));
    expect(view.result.current.request).toMatchObject({ text: "second" });
    act(() => view.result.current.handled(view.result.current.request!.id));
    expect(view.result.current.request).toBeUndefined();
  });
});
