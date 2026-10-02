import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import {
  AppNoticeHoverRegion,
  AppNoticeToast,
  type AppNoticeToastNotice,
} from "./AppNoticeToast";
import { useToastStackPlacement } from "./toast-stack-placement";

export function AppNoticeStack(props: {
  children?: ReactNode;
  desktopApi?: Pick<DesktopApi, "copyText">;
  durableNotices: readonly AppNoticeToastNotice[];
  onDismissDurable: (id: string) => void;
  onOpenThread?: (link: ResolvedThreadLink) => void;
  onSuppressSkillQuestionsWarning?: () => Promise<boolean>;
  transientNotices?: readonly {
    notice?: AppNoticeToastNotice;
    onDismiss: () => void;
  }[];
}) {
  const [activeId, setActiveId] = useState<string>();
  // Holds a card at the size of the notice it replaced until the pointer
  // leaves the stack, not just the card (AppNoticeToast.tsx).
  const [hovered, setHovered] = useState(false);
  const lastActiveIndexRef = useRef(0);
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

  useEffect(() => {
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
  }, [activeId, durableNotices]);

  const selectIndex = (index: number): void => {
    const next = durableNotices[index];
    if (!next) return;
    lastActiveIndexRef.current = index;
    setActiveId(next.id);
  };

  return (
    <div
      ref={stackRef}
      className="app-toast-stack"
      data-placement={placement}
      aria-live="polite"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <AppNoticeHoverRegion.Provider value={hovered}>
      {props.transientNotices?.map(({ notice, onDismiss }) =>
        notice ? (
          <AppNoticeToast
            key={notice.id}
            desktopApi={props.desktopApi}
            notice={notice}
            onDismiss={onDismiss}
            onOpenThread={props.onOpenThread}
            onSuppressSkillQuestionsWarning={props.onSuppressSkillQuestionsWarning}
          />
        ) : null
      )}
      <AppNoticeToast
        desktopApi={props.desktopApi}
        notice={activeNotice}
        onOpenThread={props.onOpenThread}
        onSuppressSkillQuestionsWarning={props.onSuppressSkillQuestionsWarning}
        navigation={activeNotice
          ? {
              current: activeIndex + 1,
              total: durableNotices.length,
              ...(activeDismissGroup && groupedNotices.length > 1
                ? {
                    dismissAll: {
                      label: activeDismissGroup.label,
                      onDismiss: () => {
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
      </AppNoticeHoverRegion.Provider>
    </div>
  );
}
