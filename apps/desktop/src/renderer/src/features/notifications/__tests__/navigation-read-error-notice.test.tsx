import type { NavigationQueryRequest } from "@pwragent/shared";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createNavigationPageState } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import {
  NAVIGATION_READ_ERROR_NOTICE_IDS,
  resolveNavigationReadErrorNotices,
  useNavigationReadErrorNotices,
} from "../navigation-read-error-notice";

describe("navigation read error notices", () => {
  it("raises one durable toast per kind and none for an offline peer", () => {
    const failed = "Error invoking remote method 'navigation:get-query-page': Error: owner exploded";
    const notices = resolveNavigationReadErrorNotices({
      pageErrors: [
        undefined,
        "Federation peer peer-1 is not connected.",
        "Navigation retained-page budget reached. Collapse a directory or change lens to release pages.",
        "Navigation retained-page budget reached. Collapse a directory or change lens to release pages.",
        failed,
        "Error: a second failure",
      ],
    });

    expect(notices.map((notice) => [notice.id, notice.title, notice.autoDismiss, notice.tone])).toEqual([
      ["navigation-read-error:page-budget", "Too many thread lists open", false, "error"],
      ["navigation-read-error:read-failed", "Couldn't load threads", false, "error"],
    ]);
    // The first failure's own message stays copyable for a bug report.
    expect(notices[1]?.copyText).toBe(failed);
    expect(notices[1]?.message).not.toContain("navigation:get-query-page");
  });

  it("reports the window's demand budget as the page budget", () => {
    const admissionError = "Navigation request metadata exceeds its memory budget.";
    expect(resolveNavigationReadErrorNotices({ admissionError, pageErrors: [] })).toEqual([
      expect.objectContaining({ id: "navigation-read-error:page-budget", copyText: admissionError }),
    ]);
  });

  it("says nothing when every read is healthy or only a peer is offline", () => {
    expect(resolveNavigationReadErrorNotices({
      pageErrors: [undefined, "Target federation peer is not connected."],
    })).toEqual([]);
  });

  it("lists every id it can raise, so App can take each down", () => {
    expect(NAVIGATION_READ_ERROR_NOTICE_IDS).toEqual([
      "navigation-read-error:page-budget",
      "navigation-read-error:owner-upgrade",
      "navigation-read-error:viewer-upgrade",
      "navigation-read-error:read-failed",
    ]);
  });

  it("shows a failure once, holds it through a re-read, and takes it down on recovery", () => {
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" } };
    const resource = (error: string | undefined, loading = false): NavigationWindowResource => ({
      id: "lens", loading, state: { ...createNavigationPageState(request), error },
    });
    const dispatch = vi.fn();
    type Props = { resources: ReadonlyMap<string, NavigationWindowResource> };
    const { rerender } = renderHook(
      ({ resources }: Props) => useNavigationReadErrorNotices({ resources }, dispatch),
      { initialProps: { resources: new Map([["lens", resource("Error: owner exploded")]]) } as Props },
    );
    const shown = dispatch.mock.calls.filter(([action]) => action.type === "show");
    expect(shown.map(([action]) => action.notice.id)).toEqual(["navigation-read-error:read-failed"]);

    // A refresh clears the error while it reads (beginNavigationPageRead), then
    // fails the same way. The operator may have dismissed the toast meanwhile.
    dispatch.mockClear();
    rerender({ resources: new Map([["lens", resource(undefined, true)]]) });
    rerender({ resources: new Map([["lens", resource("Error: owner exploded")]]) });
    expect(dispatch).not.toHaveBeenCalled();

    rerender({ resources: new Map([["lens", resource(undefined)]]) });
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual(
      NAVIGATION_READ_ERROR_NOTICE_IDS.map((id) => ({ type: "dismiss", id })),
    );
  });

  it("raises no toast for an offline peer", () => {
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query: { kind: "exact", identities: [] } };
    const dispatch = vi.fn();
    renderHook(() => useNavigationReadErrorNotices({ resources: new Map([["drafts:peer", {
      id: "drafts:peer", loading: false,
      state: { ...createNavigationPageState(request), error: "Federation peer peer-1 is not connected." },
    }]]) }, dispatch));
    expect(dispatch.mock.calls.filter(([action]) => action.type === "show")).toEqual([]);
  });
});
