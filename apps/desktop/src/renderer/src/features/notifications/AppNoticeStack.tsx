import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import {
  AppNoticeHoverRegion,
  AppNoticeToast,
  type AppNoticeToastNotice,
} from "./AppNoticeToast";
import { useToastStackPlacement } from "./toast-stack-placement";

type NoticeCardProps = {
  desktopApi?: Pick<DesktopApi, "copyText">;
  onDismissDurable: (id: string) => void;
  onOpenThread?: (link: ResolvedThreadLink) => void;
  onSuppressSkillQuestionsWarning?: () => Promise<boolean>;
};

/**
 * The kind a durable notice pages with: its dismiss group, or else the
 * prefix of its id. Every producer keys its ids `<kind>:<instance>`
 * (`federation-shutdown:<peer>`, `hot-cpu-profile:<capture>`), and a
 * producer whose notices span several prefixes names one dismiss group.
 */
export function appNoticeKind(notice: AppNoticeToastNotice): string {
  return notice.dismissGroup?.key ?? notice.id.split(":", 1)[0]!;
}

function groupByKind(
  notices: readonly AppNoticeToastNotice[],
): { kind: string; notices: AppNoticeToastNotice[] }[] {
  const groups = new Map<string, AppNoticeToastNotice[]>();
  for (const notice of notices) {
    const kind = appNoticeKind(notice);
    const group = groups.get(kind);
    if (group) group.push(notice);
    else groups.set(kind, [notice]);
  }
  return Array.from(groups, ([kind, members]) => ({ kind, notices: members }));
}

export function AppNoticeStack(props: NoticeCardProps & {
  children?: ReactNode;
  durableNotices: readonly AppNoticeToastNotice[];
  transientNotices?: readonly {
    notice?: AppNoticeToastNotice;
    onDismiss: () => void;
  }[];
}) {
  // Keeps a card from shrinking below the notice it replaced until the
  // pointer leaves the stack, not just the card (AppNoticeToast.tsx).
  const [hovered, setHovered] = useState(false);
  const stackRef = useRef<HTMLDivElement>(null);
  const placement = useToastStackPlacement(stackRef);

  // A card removed from under the pointer, as a closed toast is, fires no
  // pointerleave, so the stack would read as hovered until the pointer next
  // crossed it. The next element the pointer reaches says otherwise.
  useEffect(() => {
    if (!hovered) return;
    const onPointerOver = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && stackRef.current?.contains(target)) return;
      setHovered(false);
    };
    document.addEventListener("pointerover", onPointerOver, true);
    return () => {
      document.removeEventListener("pointerover", onPointerOver, true);
    };
  }, [hovered]);

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
      {groupByKind(props.durableNotices).map((group) => (
        <AppNoticeKindCard
          key={group.kind}
          desktopApi={props.desktopApi}
          notices={group.notices}
          onDismissDurable={props.onDismissDurable}
          onOpenThread={props.onOpenThread}
          onSuppressSkillQuestionsWarning={props.onSuppressSkillQuestionsWarning}
        />
      ))}
      {props.children}
      </AppNoticeHoverRegion.Provider>
    </div>
  );
}

/**
 * One card per kind of durable notice, paging through that kind only, so a
 * run of closes or pages meets notices of one shape. Even those differ in
 * height (a peer's label, an error's text), so the card is drawn over
 * hidden copies of the kind's other notices in one grid cell and takes the
 * largest of their sizes: paging and closing never move its close button or
 * its pager. Closing the largest would shrink it; the card's own hold keeps
 * it while the pointer stays.
 */
function AppNoticeKindCard(props: NoticeCardProps & {
  notices: readonly AppNoticeToastNotice[];
}) {
  const [activeId, setActiveId] = useState<string>();
  const lastActiveIndexRef = useRef(0);
  const notices = props.notices;
  const foundIndex = notices.findIndex((notice) => notice.id === activeId);
  // A closed notice gives its place to the one after it, or to the last.
  const activeIndex = foundIndex >= 0
    ? foundIndex
    : Math.min(lastActiveIndexRef.current, notices.length - 1);
  const activeNotice = notices[activeIndex];

  useEffect(() => {
    if (activeNotice && activeNotice.id !== activeId) setActiveId(activeNotice.id);
  }, [activeId, activeNotice]);

  if (!activeNotice) return null;

  const selectIndex = (index: number): void => {
    const next = notices[index];
    if (!next) return;
    lastActiveIndexRef.current = index;
    setActiveId(next.id);
  };
  const paged = notices.length > 1;
  const navigation = paged
    ? {
        current: activeIndex + 1,
        total: notices.length,
        dismissAll: {
          label: activeNotice.dismissGroup?.label ?? "notices like this",
          onDismiss: () => {
            for (const notice of notices) {
              if (notice.onDismiss) notice.onDismiss();
              else props.onDismissDurable(notice.id);
            }
          },
        },
        onPrevious: activeIndex > 0
          ? () => selectIndex(activeIndex - 1)
          : undefined,
        onNext: activeIndex < notices.length - 1
          ? () => selectIndex(activeIndex + 1)
          : undefined,
      }
    : undefined;

  return (
    <div className="app-notice-kind">
      <AppNoticeToast
        desktopApi={props.desktopApi}
        notice={activeNotice}
        navigation={navigation}
        onOpenThread={props.onOpenThread}
        onSuppressSkillQuestionsWarning={props.onSuppressSkillQuestionsWarning}
        onDismiss={() => {
          lastActiveIndexRef.current = activeIndex;
          props.onDismissDurable(activeNotice.id);
        }}
      />
      {paged
        ? notices.map((notice) =>
            notice === activeNotice ? null : (
              <AppNoticeToast
                key={notice.id}
                notice={notice}
                navigation={navigation}
                onOpenThread={props.onOpenThread}
                onDismiss={() => undefined}
                sizer
              />
            )
          )
        : null}
    </div>
  );
}
