import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("shows a failure once, leaves a dismissal alone, and takes the toast down on recovery", () => {
    const dispatch = vi.fn();
    type Props = { pageErrors: (string | undefined)[] };
    const { rerender } = renderHook(
      ({ pageErrors }: Props) => useNavigationReadErrorNotices({ pageErrors }, dispatch),
      { initialProps: { pageErrors: ["Error: owner exploded"] } as Props },
    );
    const shown = dispatch.mock.calls.filter(([action]) => action.type === "show");
    expect(shown.map(([action]) => action.notice.id)).toEqual(["navigation-read-error:read-failed"]);

    // The same failure on a later render, e.g. after the operator dismissed it.
    dispatch.mockClear();
    rerender({ pageErrors: ["Error: owner exploded", undefined] });
    expect(dispatch).not.toHaveBeenCalled();

    rerender({ pageErrors: [undefined, "Federation peer peer-1 is not connected."] });
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual(
      NAVIGATION_READ_ERROR_NOTICE_IDS.map((id) => ({ type: "dismiss", id })),
    );
  });
});
