import { useEffect, useRef, useState } from "react";
import type { PrSummary } from "@pwragent/shared";
import { parsePullRequestUrl } from "../../lib/pull-request-links";
import { useTranscriptPullRequest } from "../../lib/transcript-pr-status";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { PrStatusCard } from "../pr-status/PrStatusCard";

type HoverTarget = { element: HTMLElement; pr: PrSummary; immediate: boolean };

/** Tiptap owns the chip DOM; React owns its portalled, live status card. */
export function useComposerPullRequestHover(root: HTMLElement | undefined) {
  const [target, setTarget] = useState<HoverTarget>();
  useEffect(() => {
    if (!root) return;
    const chipAt = (target: EventTarget | null) => target instanceof Element
      ? target.closest<HTMLElement>(".composer-pr-chip") : null;
    const enter = (event: PointerEvent | FocusEvent) => {
      const element = chipAt(event.target);
      if (!element || !root.contains(element) || element === chipAt(event.relatedTarget)) return;
      const pr = parsePullRequestUrl(element.dataset.skillPath ?? "");
      if (!pr) return;
      const title = element.dataset.skillDescription;
      setTarget({ element, pr: title ? { ...pr, title } : pr, immediate: event.type === "focusin" });
    };
    const leave = (event: PointerEvent | FocusEvent) => {
      const element = chipAt(event.target);
      if (element && element !== chipAt(event.relatedTarget)) setTarget(undefined);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTarget(undefined);
    };
    root.addEventListener("pointerover", enter);
    root.addEventListener("pointerout", leave);
    root.addEventListener("focusin", enter);
    root.addEventListener("focusout", leave);
    root.addEventListener("keydown", keydown);
    return () => {
      root.removeEventListener("pointerover", enter);
      root.removeEventListener("pointerout", leave);
      root.removeEventListener("focusin", enter);
      root.removeEventListener("focusout", leave);
      root.removeEventListener("keydown", keydown);
    };
  }, [root]);
  return target && root?.contains(target.element) ? <ComposerPullRequestCard target={target} /> : null;
}

function ComposerPullRequestCard({ target }: { target: HoverTarget }) {
  const { show, showAfterDelay, hide, update, visible, tooltipId, tooltipNode } = useViewportTooltip({ className: "pr-status-card" });
  const pr = useTranscriptPullRequest(target.pr, { seen: visible, visible });
  const latest = useRef(pr);
  latest.current = pr;

  useEffect(() => {
    if (target.immediate) show(target.element, <PrStatusCard pr={latest.current} />);
    else showAfterDelay(target.element, () => <PrStatusCard pr={latest.current} />);
    return hide;
  }, [target, show, showAfterDelay, hide]);
  useEffect(() => {
    if (visible) update(<PrStatusCard pr={pr} />);
  }, [pr, visible, update]);
  useEffect(() => {
    if (!visible) return;
    target.element.setAttribute("aria-describedby", tooltipId);
    return () => target.element.removeAttribute("aria-describedby");
  }, [target, tooltipId, visible]);
  return tooltipNode;
}
