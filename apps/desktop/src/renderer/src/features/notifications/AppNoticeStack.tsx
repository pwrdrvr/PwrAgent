import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import { AppNoticeToast, type AppNoticeToastNotice } from "./AppNoticeToast";
import { useToastStackPlacement } from "./toast-stack-placement";
import { reportToastHistory, toastHistorySurface } from "./toast-history";

function historyKey(notice: AppNoticeToastNotice): string {
  return JSON.stringify([toastHistorySurface(notice), notice.historyCategory, notice.id]);
}

export function AppNoticeStack(props: {
  children?: ReactNode;
  desktopApi?: Pick<DesktopApi, "copyText">;
  durableNotices: readonly AppNoticeToastNotice[];
  onDismissDurable: (id: string) => void;
  onOpenThread?: (link: ResolvedThreadLink) => void;
  onSuppressSkillQuestionsWarning?: () => Promise<boolean>;
  onSuppressCodexWarning?: (id: string) => Promise<boolean>;
  transientNotices?: readonly {
    notice?: AppNoticeToastNotice;
    onDismiss: () => void;
  }[];
}) {
  const [activeId, setActiveId] = useState<string>();
  const lastActiveIndexRef = useRef(0);
  const previousRevealIds = useRef(new Set<string>());
  const pendingRevealId = useRef<string | undefined>(undefined);
  const durableToastRef = useRef<HTMLElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const placement = useToastStackPlacement(stackRef);
  const durableNotices = props.durableNotices;
  const activeIndex = Math.max(
    0,
    durableNotices.findIndex((notice) => notice.id === activeId),
  );
  const activeNotice = durableNotices[activeIndex];
  const activeDismissGroup = activeNotice?.dismissGroup;
  const groupedNotices = activeDismissGroup
    ? durableNotices.filter(
        (notice) => notice.dismissGroup?.key === activeDismissGroup.key,
      )
    : [];

  const previousQueued = useRef(new Map<string, AppNoticeToastNotice>());
  const previousDisplayed = useRef(new Set<string>());
  const transientNotices = props.transientNotices;
  useEffect(() => {
    const transient = transientNotices?.flatMap(({ notice }) => notice ? [notice] : []) ?? [];
    const queued = new Map<string, AppNoticeToastNotice>();
    for (const notice of [...durableNotices, ...transient]) {
      const key = historyKey(notice);
      queued.set(key, notice);
      if (!previousQueued.current.has(key)) reportToastHistory(notice, "queued");
    }
    for (const [key, notice] of previousQueued.current) {
      if (!queued.has(key)) reportToastHistory(notice, "withdrawn");
    }
    previousQueued.current = queued;

    const displayed = new Set<string>();
    for (const notice of activeNotice ? [...transient, activeNotice] : transient) {
      const key = historyKey(notice);
      displayed.add(key);
      if (!previousDisplayed.current.has(key)) reportToastHistory(notice, "displayed");
    }
    previousDisplayed.current = displayed;
  }, [activeNotice, durableNotices, transientNotices]);

  const revealPendingNotice = useCallback((): boolean => {
    const nextId = pendingRevealId.current;
    if (!nextId) return false;
    pendingRevealId.current = undefined;
    const index = durableNotices.findIndex((notice) => notice.id === nextId);
    if (index < 0) return false;
    lastActiveIndexRef.current = index;
    setActiveId(nextId);
    return true;
  }, [durableNotices]);

  useEffect(() => {
    const revealIds = new Set(durableNotices.filter((notice) => notice.revealOnArrival).map((notice) => notice.id));
    const arrival = durableNotices.findLast(
      (notice) => revealIds.has(notice.id) && !previousRevealIds.current.has(notice.id),
    );
    previousRevealIds.current = revealIds;
    if (arrival) pendingRevealId.current = arrival.id;
    const toast = durableToastRef.current;
    if (!toast?.contains(toast.ownerDocument.activeElement) && revealPendingNotice()) return;
    if (durableNotices.length === 0) {
      setActiveId(undefined);
      lastActiveIndexRef.current = 0;
      return;
    }
    if (activeId && durableNotices.some((notice) => notice.id === activeId)) {
      return;
    }
    const nextIndex = Math.min(
      lastActiveIndexRef.current,
      durableNotices.length - 1,
    );
    setActiveId(durableNotices[nextIndex]?.id);
  }, [activeId, durableNotices, revealPendingNotice]);

  const selectIndex = (index: number): void => {
    const next = durableNotices[index];
    if (!next) return;
    pendingRevealId.current = undefined;
    lastActiveIndexRef.current = index;
    setActiveId(next.id);
  };

  return (
    <div
      ref={stackRef}
      className="app-toast-stack"
      data-placement={placement}
      aria-live="polite"
    >
      {props.transientNotices?.map(({ notice, onDismiss }) =>
        notice ? (
          <AppNoticeToast
            key={notice.id}
            desktopApi={props.desktopApi}
            historyQueued
            notice={notice}
            onDismiss={onDismiss}
            onOpenThread={props.onOpenThread}
            onSuppressSkillQuestionsWarning={props.onSuppressSkillQuestionsWarning}
            onSuppressCodexWarning={props.onSuppressCodexWarning}
          />
        ) : null
      )}
      <AppNoticeToast
        desktopApi={props.desktopApi}
        historyQueued
        notice={activeNotice}
        noticeRef={durableToastRef}
        onFocusLeave={revealPendingNotice}
        onOpenThread={props.onOpenThread}
        onSuppressSkillQuestionsWarning={props.onSuppressSkillQuestionsWarning}
        onSuppressCodexWarning={props.onSuppressCodexWarning}
        navigation={activeNotice
          ? {
              current: activeIndex + 1,
              total: durableNotices.length,
              ...(activeDismissGroup && groupedNotices.length > 1
                ? {
                    dismissAll: {
                      label: activeDismissGroup.label,
                      actionLabel: activeDismissGroup.actionLabel,
                      onDismiss: () => {
                        for (const notice of groupedNotices) {
                          reportToastHistory(notice, "dismissed");
                        }
                        if (activeDismissGroup.onDismissAll) {
                          activeDismissGroup.onDismissAll();
                          return;
                        }
                        for (const notice of groupedNotices) {
                          if (notice.onDismiss) {
                            notice.onDismiss();
                          } else {
                            props.onDismissDurable(notice.id);
                          }
                        }
                      },
                    },
                  }
                : {}),
              onPrevious: activeIndex > 0
                ? () => selectIndex(activeIndex - 1)
                : undefined,
              onNext: activeIndex < durableNotices.length - 1
                ? () => selectIndex(activeIndex + 1)
                : undefined,
            }
          : undefined}
        onDismiss={() => {
          if (!activeNotice) return;
          lastActiveIndexRef.current = activeIndex;
          props.onDismissDurable(activeNotice.id);
        }}
      />
      {props.children}
    </div>
  );
}
