import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import { AppNoticeToast, type AppNoticeToastNotice } from "./AppNoticeToast";

export function AppNoticeStack(props: {
  children?: ReactNode;
  desktopApi?: Pick<DesktopApi, "copyText">;
  durableNotices: readonly AppNoticeToastNotice[];
  onDismissDurable: (id: string) => void;
  onOpenThread?: (link: ResolvedThreadLink) => void;
  transientNotices?: readonly {
    notice?: AppNoticeToastNotice;
    onDismiss: () => void;
  }[];
}) {
  const [activeId, setActiveId] = useState<string>();
  const lastActiveIndexRef = useRef(0);
  const durableNotices = props.durableNotices;
  const activeIndex = Math.max(
    0,
    durableNotices.findIndex((notice) => notice.id === activeId),
  );
  const activeNotice = durableNotices[activeIndex];

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
    <div className="app-toast-stack" aria-live="polite">
      {props.transientNotices?.map(({ notice, onDismiss }) =>
        notice ? (
          <AppNoticeToast
            key={notice.id}
            desktopApi={props.desktopApi}
            notice={notice}
            onDismiss={onDismiss}
            onOpenThread={props.onOpenThread}
          />
        ) : null
      )}
      <AppNoticeToast
        desktopApi={props.desktopApi}
        notice={activeNotice}
        onOpenThread={props.onOpenThread}
        navigation={activeNotice && durableNotices.length > 1
          ? {
              current: activeIndex + 1,
              total: durableNotices.length,
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
