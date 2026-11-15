import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerMentions } from "../useComposerMentions";

describe("compact composer skill refresh", () => {
  afterEach(cleanup);

  it.each(["$", "/"])("refreshes once per %s opening across query and callback updates", (prefix) => {
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
});
