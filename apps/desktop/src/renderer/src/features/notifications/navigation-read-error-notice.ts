import { useEffect, useRef } from "react";
import { navigationPageErrorKind, type NavigationPageErrorKind } from "../../lib/navigation-query-state";
import type { AppNoticeToastNotice } from "./AppNoticeToast";
import type { AppNoticeAction } from "./app-notice-state";

/**
 * Thread lists that failed to load, as durable toasts.
 *
 * A page read fails while the list it feeds stays on screen, but the list is
 * the wrong place to say so: a line under one directory or at the foot of a
 * lens is an error slot nothing else in the app uses, and it scrolls away
 * with the rows. One notice per kind, so ten directories over the page budget
 * raise one toast, not ten. The window's demand clears a notice when its
 * reads recover, and an offline peer raises none (see
 * `navigationPageErrorKind`).
 */
const NAVIGATION_READ_ERROR_NOTICES: Record<NavigationPageErrorKind, { title: string; message: string }> = {
  "page-budget": {
    title: "Too many thread lists open",
    message: "Collapse a directory to load more threads.",
  },
  "owner-upgrade": {
    title: "Another instance needs an update",
    message: "Update PwrAgent on the other instance to see its threads.",
  },
  "viewer-upgrade": {
    title: "PwrAgent needs an update",
    message: "Update PwrAgent to see these threads.",
  },
  "read-failed": {
    title: "Couldn't load threads",
    message: "Some threads didn't load.",
  },
};

export function navigationReadErrorNoticeId(kind: NavigationPageErrorKind): string {
  return `navigation-read-error:${kind}`;
}

export const NAVIGATION_READ_ERROR_NOTICE_IDS: readonly string[] =
  (Object.keys(NAVIGATION_READ_ERROR_NOTICES) as NavigationPageErrorKind[]).map(navigationReadErrorNoticeId);

/**
 * `admissionError` is the window's own demand outgrowing its budget, which
 * the operator relieves the same way as the owner's retained-page budget.
 */
export function resolveNavigationReadErrorNotices(params: {
  admissionError?: string;
  pageErrors: Iterable<string | undefined>;
}): AppNoticeToastNotice[] {
  const errorsByKind = new Map<NavigationPageErrorKind, string>();
  if (params.admissionError) errorsByKind.set("page-budget", params.admissionError);
  for (const error of params.pageErrors) {
    const kind = navigationPageErrorKind(error);
    if (kind && error && !errorsByKind.has(kind)) errorsByKind.set(kind, error);
  }
  return [...errorsByKind].map(([kind, error]) => ({
    autoDismiss: false,
    // The owner's own message, for a bug report; the toast shows the copy.
    copyText: error,
    id: navigationReadErrorNoticeId(kind),
    ...NAVIGATION_READ_ERROR_NOTICES[kind],
    tone: "error",
  }));
}

/**
 * Keeps the toasts in step with the window's reads. Keyed on what they say, so
 * a dismissed toast stays dismissed until a read fails differently, and a
 * recovered read takes its toast down.
 */
export function useNavigationReadErrorNotices(
  params: { admissionError?: string; pageErrors: Iterable<string | undefined> },
  dispatch: (action: AppNoticeAction) => void,
): void {
  const notices = resolveNavigationReadErrorNotices(params);
  const key = JSON.stringify(notices.map((notice) => [notice.id, notice.copyText]));
  const noticesRef = useRef(notices);
  noticesRef.current = notices;
  useEffect(() => {
    const current = noticesRef.current;
    for (const id of NAVIGATION_READ_ERROR_NOTICE_IDS) {
      if (!current.some((notice) => notice.id === id)) dispatch({ type: "dismiss", id });
    }
    for (const notice of current) dispatch({ type: "show", notice });
  }, [dispatch, key]);
}
