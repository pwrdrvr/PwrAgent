import { useEffect, useRef } from "react";
import { navigationPageErrorKind, type NavigationPageErrorKind } from "../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../lib/navigation-window-queries";
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
    message: "Collapse directories or switch lenses to load more threads.",
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

type NavigationReadError = { error?: string; instanceId?: string };
type FederationInstanceLabel = { instanceId: string; label: string };

/**
 * `admissionError` is the window's own demand outgrowing its budget, which
 * the operator relieves the same way as the owner's retained-page budget.
 */
export function resolveNavigationReadErrorNotices(params: {
  admissionError?: string;
  pageErrors: Iterable<NavigationReadError>;
  instances?: readonly FederationInstanceLabel[];
}): AppNoticeToastNotice[] {
  const errorsByKind = new Map<NavigationPageErrorKind, Map<string, NavigationReadError>>();
  const add = (kind: NavigationPageErrorKind, failure: NavigationReadError) => {
    const errors = errorsByKind.get(kind) ?? new Map<string, NavigationReadError>();
    const key = JSON.stringify([failure.instanceId ?? null, failure.error]);
    if (!errors.has(key)) errors.set(key, failure);
    errorsByKind.set(kind, errors);
  };
  if (params.admissionError) add("page-budget", { error: params.admissionError });
  for (const failure of params.pageErrors) {
    const { error } = failure;
    const kind = navigationPageErrorKind(error);
    if (kind && error) add(kind, failure);
  }
  const labels = new Map(params.instances?.map((instance) => [instance.instanceId, instance.label]));
  return [...errorsByKind].map(([kind, errors]) => {
    const failures = [...errors.values()];
    const local = failures.some(({ instanceId }) => !instanceId);
    const remoteOwners = new Set(failures.flatMap(({ instanceId }) => instanceId ? [instanceId] : []));
    const remote = [...remoteOwners].map((instanceId) => ({ instanceId, label: labels.get(instanceId) ?? instanceId }));
    const facts = [
      ...(local ? [{ label: "Instance", value: "This instance" }] : []),
      ...(remote.length ? [{ label: remote.length === 1 ? "Federation instance" : "Federation instances",
        value: remote.map(({ label }) => label).join(", ") }] : []),
    ];
    let { title, message } = NAVIGATION_READ_ERROR_NOTICES[kind];
    if (kind === "read-failed") {
      // Busy includes admission contention and cancellation, not just a slow
      // connection. Do not diagnose a network timeout from this shared code.
      if (failures.every(({ error }) => error?.includes("[navigation_busy]"))) {
        title = "Thread loading delayed";
        message = !local
          ? `Thread lists from ${remote.length === 1 ? "this federation instance are" : "these federation instances are"} busy or taking too long to load.`
          : remote.length ? "Some thread lists are busy or taking too long to load."
            : "Thread lists on this instance are busy or taking too long to load.";
      } else if (!local) {
        message = `Thread lists from ${remote.length === 1 ? "this federation instance" : "these federation instances"} couldn't be loaded.`;
      }
    }
    return {
      autoDismiss: false,
      // Keep raw owner errors copyable, with the source missing from wrapped
      // federation exceptions. Local-only diagnostics keep their old shape.
      copyText: failures.map(({ error, instanceId }) => instanceId
        ? `Federation instance: ${labels.get(instanceId) ?? instanceId} (${instanceId})\n${error}`
        : remote.length ? `This instance\n${error}` : error).join("\n\n"),
      facts,
      id: navigationReadErrorNoticeId(kind), title, message,
      tone: "error" as const,
    };
  });
}

/**
 * Keeps the toasts in step with the window's reads. Keyed on what they say, so
 * a dismissed toast stays dismissed until a read fails differently, and a
 * settled read that recovers takes its toast down.
 *
 * A re-read clears its resource's error while it is in flight
 * (`beginNavigationPageRead`), so a resource that is loading keeps the error
 * it last settled on. Keying on the in-flight state would take a persistent
 * failure's toast down and put it back on every refresh, undoing a dismissal.
 */
export function useNavigationReadErrorNotices(
  params: { admissionError?: string; resources: ReadonlyMap<string, NavigationWindowResource>; instances?: readonly FederationInstanceLabel[] },
  dispatch: (action: AppNoticeAction) => void,
): void {
  const { admissionError, resources, instances } = params;
  const settledErrorsRef = useRef(new Map<string, NavigationReadError>());
  const shownKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const settled = new Map<string, NavigationReadError>();
    for (const [id, resource] of resources) {
      const target = resource.state.request.federationTarget;
      const instanceId = target?.scope === "remote" ? target.instanceId : undefined;
      const previous = settledErrorsRef.current.get(id);
      settled.set(id, { instanceId, error: resource.loading && !resource.state.error && previous?.instanceId === instanceId
        ? previous?.error : resource.state.error });
    }
    settledErrorsRef.current = settled;
    const notices = resolveNavigationReadErrorNotices({ admissionError, pageErrors: settled.values(), instances });
    const key = JSON.stringify(notices.map((notice) => [notice.id, notice.copyText]));
    if (key === shownKeyRef.current) return;
    shownKeyRef.current = key;
    for (const id of NAVIGATION_READ_ERROR_NOTICE_IDS) {
      if (!notices.some((notice) => notice.id === id)) dispatch({ type: "dismiss", id });
    }
    for (const notice of notices) dispatch({ type: "show", notice });
  }, [admissionError, dispatch, instances, resources]);
}
