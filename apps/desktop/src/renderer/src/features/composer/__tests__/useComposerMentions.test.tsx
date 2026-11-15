import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerMentions } from "../useComposerMentions";

describe("compact composer skill refresh", () => {
  afterEach(cleanup);

  it.each(["$", "/"])("checks freshness once per %s opening across query and callback updates", (prefix) => {
    const refresh = vi.fn();
    const { result, rerender } = renderHook(
      ({ threadKey }) => useComposerMentions({ sources: {
        currentThreadKey: threadKey,
        ensureSkillsLoaded: () => refresh(),
      } }),
      { initialProps: { threadKey: "thread-1" } },
    );
    for (const query of ["", "p", "pa", "pap", "paper"]) {
      act(() => result.current.handleChange(`${prefix}${query}`));
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ threadKey: "thread-1" });
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => result.current.handleChange(""));
    act(() => result.current.handleChange(`${prefix}paper`));
    expect(refresh).toHaveBeenCalledTimes(2);
    rerender({ threadKey: "thread-2" });
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("offers Refresh without matches, disables it while loading, and lets Escape dismiss it", () => {
    const refresh = vi.fn();
    const { result, rerender } = renderHook(
      ({ loading }) => useComposerMentions({ sources: { ensureSkillsLoaded: refresh, skillLoading: loading } }),
      { initialProps: { loading: false } },
    );
    act(() => result.current.handleChange("$paper"));
    const view = render(result.current.popover);
    expect(screen.getByText("No matching skills.")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Refresh skills" });
    expect(button.closest('[role="listbox"]')).toBeNull();
    fireEvent.click(button);
    expect(refresh).toHaveBeenLastCalledWith({ force: true });
    rerender({ loading: true });
    view.rerender(result.current.popover);
    expect(button).toBeDisabled();
    rerender({ loading: false });
    view.rerender(result.current.popover);
    fireEvent.keyDown(button, { key: "Escape" });
    view.rerender(result.current.popover);
    expect(screen.queryByRole("button", { name: "Refresh skills" })).not.toBeInTheDocument();
  });
});
