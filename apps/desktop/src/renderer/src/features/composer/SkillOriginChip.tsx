import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  describeSkillOriginKind,
  skillOriginMarketplace,
  type AppServerSkillOrigin,
  type AppServerSkillSummary,
} from "@pwragent/shared";
import {
  CheckIcon,
  CopyIcon,
  FolderIcon,
  PackageIcon,
  PlugIcon,
  PopoutIcon,
  ShieldIcon,
  UserIcon,
  WorktreeIcon,
} from "../../icons";
import type { IconProps } from "../../icons/icon-types";
import { copyText } from "../../lib/copy-text";
import { getDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { tildifyPath } from "../../lib/tildify-path";

const CARD_OPEN_DELAY_MS = 300;
/** Long enough to cross the gap from the chip into the card. */
const CARD_CLOSE_GRACE_MS = 160;
const CARD_GAP_PX = 6;
const VIEWPORT_PADDING_PX = 8;
const COPIED_FEEDBACK_MS = 1500;

type OriginSkill = AppServerSkillSummary & {
  origin: AppServerSkillOrigin;
  path: string;
};

function skillOriginIcon(origin: AppServerSkillOrigin): ComponentType<IconProps> {
  switch (origin.kind) {
    case "project":
      return origin.worktree ? WorktreeIcon : FolderIcon;
    case "personal":
    case "codex-home":
      return UserIcon;
    case "plugin":
      return PlugIcon;
    case "built-in":
      return PackageIcon;
    case "admin":
      return ShieldIcon;
    case "repository":
    case "other":
      return FolderIcon;
  }
}

/**
 * Names where a `$skill` row came from: the linked project's label, or
 * Personal / Codex home / a plugin / Built-in / Admin.
 *
 * A plain span on purpose. Picker rows are `<button role="option">`, and a
 * control inside a button is invalid and unreachable, so the path and its
 * Copy button live in the hover card `useSkillOriginCard` portals beside the
 * list. The label is part of the row's accessible name, which is what tells
 * a screen reader the three `$release` rows apart.
 */
export function SkillOriginChip(props: {
  origin: AppServerSkillOrigin;
  onPointerEnter?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: ReactPointerEvent<HTMLElement>) => void;
}): ReactNode {
  const { origin } = props;
  const Icon = skillOriginIcon(origin);
  // The thread's primary project gets the stronger neutral. The accent stays
  // with the row's selection tint and the typed run, as on the `/` badges.
  const primary = origin.kind === "project" && origin.directoryIndex === 0;
  return (
    <span
      className={`skill-origin-chip${primary ? " skill-origin-chip--primary" : ""}`}
      data-origin-kind={origin.kind}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
    >
      <Icon size={11} aria-hidden="true" />
      <span className="skill-origin-chip__label">{origin.label}</span>
    </span>
  );
}

type CardState = {
  anchor: HTMLElement;
  skill: OriginSkill;
  left?: number;
  top?: number;
};

export type SkillOriginCardController = {
  /** Pointer handlers for one row's chip. */
  chipHandlers: (skill: AppServerSkillSummary) => {
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
  };
  /**
   * The card's id while it belongs to this skill, for the picker row's
   * `aria-describedby`. The card holds the path, and nothing else in the
   * document points at the portal.
   */
  describedBy: (skill: AppServerSkillSummary) => string | undefined;
  /**
   * The same hover for an anchor React does not render: a `$skill` chip in
   * the composer's editor, whose DOM belongs to Tiptap. Takes the skill
   * first, so it is the editor's `onSkillChipPointerEnter` as it stands.
   */
  hoverAnchor: (skill: AppServerSkillSummary, anchor: HTMLElement) => void;
  leaveAnchor: () => void;
  close: () => void;
  /** The portal. Render it once, outside every option row. */
  cardNode: ReactNode;
};

/**
 * The hover card behind a `SkillOriginChip`: the origin, the full path, Copy
 * path, and Open SKILL.md.
 *
 * `useViewportTooltip` cannot host it. That hook's cards are pointer-inert
 * and close on any pointerdown, which is right for a status readout and
 * wrong for a card whose point is a button. This one stays open while the
 * pointer travels from the chip into it, and closes on Escape before the
 * picker does.
 *
 * Presses inside the card keep their default suppressed, as the picker rows
 * do: the composer's caret and the open picker both survive a Copy. They also
 * stop propagating, because React bubbles through the portal to the host —
 * on the Star Map that host is a draggable chat card.
 */
export function useSkillOriginCard(options: {
  desktopApi?: Pick<DesktopApi, "copyText" | "openMarkdownFileViewer">;
  /**
   * The peer instance's name when the skills live on another instance. The
   * path is then a path on that machine: it is shown as-is, and the local
   * document viewer is not offered for it.
   */
  remoteInstanceLabel?: string;
  /**
   * The skill catalog, for chips that carry no origin of their own: one
   * minted before origins existed, or restored from plain Markdown. Both
   * composer surfaces hover the same way, so the lookup lives here.
   */
  skills?: readonly AppServerSkillSummary[];
} = {}): SkillOriginCardController {
  const { remoteInstanceLabel } = options;
  const skillsRef = useRef(options.skills);
  skillsRef.current = options.skills;
  const desktopApi = options.desktopApi ?? getDesktopApi();
  const cardRef = useRef<HTMLDivElement>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const [state, setState] = useState<CardState | undefined>(undefined);
  // Read synchronously by the pointer handlers, which decide between "wait"
  // and "swap now" before React has re-rendered.
  const stateRef = useRef<CardState | undefined>(undefined);
  const [copiedPath, setCopiedPath] = useState<string | undefined>(undefined);
  const cardId = useId();

  const commitState = useCallback((next: CardState | undefined) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const clearTimer = useCallback((timerRef: { current: number | null }) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    if (stateRef.current) {
      commitState(undefined);
    }
  }, [clearTimer, commitState]);

  const scheduleClose = useCallback(() => {
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      commitState(undefined);
    }, CARD_CLOSE_GRACE_MS);
  }, [clearTimer, commitState]);

  const hoverAnchor = useCallback<SkillOriginCardController["hoverAnchor"]>(
    (skill, anchor) => {
      const path = skill.path?.trim();
      const origin =
        skill.origin
        ?? (path
          ? skillsRef.current?.find((entry) => entry.path === path)?.origin
          : undefined);
      if (!origin || !path) {
        return;
      }
      clearTimer(closeTimerRef);
      clearTimer(openTimerRef);
      const current = stateRef.current;
      if (current?.anchor === anchor) {
        return;
      }
      const next: CardState = { anchor, skill: { ...skill, origin, path } };
      // Moving between chips while a card is up swaps it at once, the way
      // a menu bar does; only the first card waits.
      if (current) {
        commitState(next);
        return;
      }
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = null;
        commitState(next);
      }, CARD_OPEN_DELAY_MS);
    },
    [clearTimer, commitState],
  );

  const chipHandlers = useCallback<SkillOriginCardController["chipHandlers"]>(
    (skill) => ({
      onPointerEnter: (event) => hoverAnchor(skill, event.currentTarget),
      onPointerLeave: scheduleClose,
    }),
    [hoverAnchor, scheduleClose],
  );

  // Place below the chip, or above when the viewport has no room. Measured
  // after the first paint, which renders hidden for exactly that reason.
  useLayoutEffect(() => {
    if (!state || state.left !== undefined) {
      return;
    }
    const card = cardRef.current;
    if (!card) {
      return;
    }
    const anchorRect = state.anchor.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const maxLeft = window.innerWidth - VIEWPORT_PADDING_PX - cardRect.width;
    const left = Math.max(VIEWPORT_PADDING_PX, Math.min(anchorRect.left, maxLeft));
    const below = anchorRect.bottom + CARD_GAP_PX;
    const above = anchorRect.top - CARD_GAP_PX - cardRect.height;
    const fitsBelow =
      below + cardRect.height <= window.innerHeight - VIEWPORT_PADDING_PX;
    const top = fitsBelow || above < VIEWPORT_PADDING_PX
      ? below
      : above;
    commitState({ ...state, left, top });
  }, [commitState, state]);

  // The picker re-renders its rows on every keystroke, and closes without
  // telling the card. A card whose chip is gone must not float over the list
  // or come back with the next picker, so check before paint, not after.
  useLayoutEffect(() => {
    if (state && !state.anchor.isConnected) {
      close();
    }
  });

  const visible = state !== undefined;
  useEffect(() => {
    if (!visible) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      // Captured ahead of the composer, so this Escape closes only the card
      // and the next one closes the picker.
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && cardRef.current?.contains(target)) {
        return;
      }
      close();
    };
    // Only a scroll that moves the chip. A streaming transcript scrolls
    // constantly and has nothing to do with a card over the composer.
    const onScroll = (event: Event): void => {
      const target = event.target;
      const anchor = stateRef.current?.anchor;
      if (
        target === document
        || (target instanceof Node && anchor && target.contains(anchor))
      ) {
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("scroll", onScroll, { capture: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [close, visible]);

  useEffect(
    () => () => {
      clearTimer(openTimerRef);
      clearTimer(closeTimerRef);
      clearTimer(copiedTimerRef);
    },
    [clearTimer],
  );

  const copyPath = useCallback(
    (path: string) => {
      void copyText(path, desktopApi).then(() => {
        clearTimer(copiedTimerRef);
        setCopiedPath(path);
        copiedTimerRef.current = window.setTimeout(() => {
          copiedTimerRef.current = null;
          setCopiedPath(undefined);
        }, COPIED_FEEDBACK_MS);
      });
    },
    [clearTimer, desktopApi],
  );

  const openSkillFile = desktopApi?.openMarkdownFileViewer && !remoteInstanceLabel
    ? (skill: OriginSkill) => {
      const separator = Math.max(
        skill.path.lastIndexOf("/"),
        skill.path.lastIndexOf("\\"),
      );
      const directory = skill.path.slice(0, Math.max(0, separator)) || skill.path;
      void desktopApi.openMarkdownFileViewer?.({
        context: { key: `files:${directory}`, title: "Files", projectPath: directory },
        file: { path: skill.path, label: `$${skill.name}` },
      }).catch((error: unknown) => {
        console.error("Failed to open skill file", error);
      });
      close();
    }
    : undefined;

  const cardNode = state && typeof document !== "undefined"
    ? createPortal(
      <SkillOriginCard
        cardRef={cardRef}
        copied={copiedPath === state.skill.path}
        id={cardId}
        left={state.left}
        remoteInstanceLabel={remoteInstanceLabel}
        skill={state.skill}
        top={state.top}
        onCopy={copyPath}
        onOpen={openSkillFile}
        onPointerEnter={() => clearTimer(closeTimerRef)}
        onPointerLeave={scheduleClose}
      />,
      document.body,
    )
    : null;

  return {
    cardNode,
    chipHandlers,
    close,
    describedBy: (skill) =>
      state && state.left !== undefined && state.skill.path === skill.path
        ? cardId
        : undefined,
    hoverAnchor,
    leaveAnchor: scheduleClose,
  };
}

/**
 * A path with a break opportunity after every separator, so a long one wraps
 * between folders rather than inside a name: `fixture-` / `user` and
 * `SKIL` / `L.md` are what `overflow-wrap: anywhere` alone produces.
 */
function breakAtSeparators(path: string): ReactNode[] {
  return path.split(/(?<=[/\\])/).flatMap((segment, index) =>
    index === 0 ? [segment] : [<wbr key={index} />, segment]
  );
}

function keepComposerFocus(event: SyntheticEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function stopHostPropagation(event: SyntheticEvent): void {
  event.stopPropagation();
}

function SkillOriginCard(props: {
  cardRef: { current: HTMLDivElement | null };
  copied: boolean;
  id: string;
  left?: number;
  remoteInstanceLabel?: string;
  skill: OriginSkill;
  top?: number;
  onCopy: (path: string) => void;
  onOpen?: (skill: OriginSkill) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}): ReactNode {
  const { skill, remoteInstanceLabel } = props;
  const { origin } = skill;
  const Icon = skillOriginIcon(origin);
  const marketplace = skillOriginMarketplace(origin);
  return (
    <div
      ref={props.cardRef}
      aria-label={`Where $${skill.name} comes from`}
      className="skill-origin-card"
      id={props.id}
      role="group"
      style={{
        left: props.left,
        top: props.top,
        visibility: props.left === undefined ? "hidden" : undefined,
      }}
      onClick={stopHostPropagation}
      onKeyDown={stopHostPropagation}
      onMouseDown={keepComposerFocus}
      onPointerDown={stopHostPropagation}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
      onWheel={stopHostPropagation}
    >
      <div className="skill-origin-card__header">
        <Icon size={14} aria-hidden="true" />
        <span className="skill-origin-card__label">{origin.label}</span>
        <span className="skill-origin-card__kind">
          {describeSkillOriginKind(origin)}
        </span>
      </div>
      <div className="skill-origin-card__path">
        {breakAtSeparators(
          remoteInstanceLabel ? skill.path : tildifyPath(skill.path),
        )}
      </div>
      {marketplace ? (
        <div className="skill-origin-card__note">
          From the {marketplace} marketplace
        </div>
      ) : null}
      {remoteInstanceLabel ? (
        <div className="skill-origin-card__note">
          This path is on {remoteInstanceLabel}.
        </div>
      ) : null}
      <div className="skill-origin-card__actions">
        <button
          className={`skill-origin-card__action${props.copied ? " is-copied" : ""}`}
          type="button"
          onClick={() => props.onCopy(skill.path)}
        >
          {props.copied
            ? <CheckIcon size={13} aria-hidden="true" />
            : <CopyIcon size={13} aria-hidden="true" />}
          <span>{props.copied ? "Copied" : "Copy path"}</span>
        </button>
        {props.onOpen ? (
          <button
            className="skill-origin-card__action skill-origin-card__action--quiet"
            type="button"
            onClick={() => props.onOpen?.(skill)}
          >
            <PopoutIcon size={13} aria-hidden="true" />
            <span>Open SKILL.md</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
