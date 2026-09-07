import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import {
  resetComposerMentionSourcesCache,
  useComposerMentionSources,
} from "../useComposerMentionSources";

beforeEach(resetComposerMentionSourcesCache);

describe("bounded composer mention sources", () => {
  it("modern mentions never read snapshots and can find a thread outside the initial page", async () => {
    const threads = Array.from({ length: 1_001 }, (_, index): NavigationThreadSummary => ({
      id: `thread-${index}`,
      source: "codex",
      title: `Unique project ${index}`,
      titleSource: "explicit",
      linkedDirectories: [],
      inbox: { inInbox: false },
    }));
    const getNavigationQueryPage = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(
      async (request) => navigationQueryFixture(request, { threads }),
    );
    const getNavigationSnapshot = vi.fn(() => { throw new Error("Retired collection"); });
    const desktopApi: DesktopApi = { getNavigationQueryPage, getNavigationSnapshot };
    const { result } = renderHook(() => useComposerMentionSources({ desktopApi }));
    expect(getNavigationQueryPage).not.toHaveBeenCalled();
    act(() => result.current.ensureLoaded());
    await waitFor(() => expect(result.current.threads).toHaveLength(10));
    expect(result.current.threads.some((thread) => thread.id === "thread-1000")).toBe(false);
    act(() => result.current.ensureLoaded("Unique project 1000"));
    await waitFor(() => expect(result.current.settledQuery).toBe("unique project 1000"));
    expect(result.current.threads.map((thread) => thread.id)).toEqual(["thread-1000"]);
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
    expect(getNavigationQueryPage.mock.calls.every(([request]) => request.pageSize === 10)).toBe(true);
  });

  it("releases both query interests when the picker closes", async () => {
    const releaseNavigationQuery = vi.fn(async () => undefined);
    const desktopApi: DesktopApi = {
      getNavigationQueryPage: async (request) => navigationQueryFixture(request, {}),
      releaseNavigationQuery,
    };
    const { result } = renderHook(() => useComposerMentionSources({ desktopApi }));
    act(() => result.current.ensureLoaded("query"));
    await waitFor(() => expect(result.current.settledQuery).toBe("query"));
    act(() => result.current.release());
    expect(releaseNavigationQuery).toHaveBeenCalledTimes(2);
  });
});
