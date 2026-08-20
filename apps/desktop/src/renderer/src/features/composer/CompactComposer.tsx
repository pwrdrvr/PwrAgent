import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { ThreadExecutionMode } from "@pwragent/shared";
import { ComposerTiptapInput } from "./ComposerTiptapInput";
import {
  useComposerMentions,
  type ComposerMentionSources,
} from "./useComposerMentions";

export type CompactComposerAction = {
  disabled?: boolean;
  key: string;
  label: string;
  onSelect: () => void;
};

export type CompactComposerSettingsOption = {
  id: string;
  label?: string;
};

/**
 * Everything the settings chip's menu can offer beyond the host's plain
 * actions. Each section renders only when its options AND its callback are
 * supplied, so a host exposes exactly what its thread can actually change.
 */
export type CompactComposerSettingsMenu = {
  /** True while the host is still fetching the option lists. */
  loading?: boolean;
  /**
   * Called when the menu opens. Lazy on purpose: a card the operator only
   * reads must not pay for a backend describe it never shows.
   */
  onOpen?: () => void;
  executionModes?: Array<{ label: string; mode: ThreadExecutionMode }>;
  models?: CompactComposerSettingsOption[];
  reasoningEfforts?: string[];
  supportsFastMode?: boolean;
  onSelectExecutionMode?: (mode: ThreadExecutionMode) => void;
  onSelectModel?: (model: string) => void;
  onSelectReasoningEffort?: (effort: string) => void;
  onToggleFastMode?: (enabled: boolean) => void;
};

export type CompactComposerProps = {
  busy?: boolean;
  /**
   * Whether a send during a live turn can reach the backend at all. False
   * disables the primary button while busy rather than letting the operator
   * fire a send that is guaranteed to bounce.
   */
  canSteer?: boolean;
  disabled?: boolean;
  executionMode?: ThreadExecutionMode;
  /** Thread's current fast-mode state, shown on the chip menu's toggle. */
  fastMode?: boolean;
  /**
   * Populations the `$` / `@` / `#` popovers pick from. Optional on
   * purpose: a host that supplies nothing keeps the trigger characters as
   * literal prose, so adopting this component never requires them.
   */
  mentionSources?: ComposerMentionSources;
  /** Thread's current model, the chip's leading segment. */
  model?: string;
  onInterrupt?: () => void;
  /**
   * Resolve `false` to hand the text back to the input — a send that never
   * reached the backend must not cost the operator what they typed.
   */
  onSend: (text: string) => void | boolean | Promise<boolean | void>;
  placeholder?: string;
  reasoningEffort?: string;
  /** Rendered at the bottom of the settings chip's menu. */
  secondaryActions?: CompactComposerAction[];
  /** Setting sections for the chip menu; see the type's doc comment. */
  settingsMenu?: CompactComposerSettingsMenu;
  threadTitle: string;
};

const EXECUTION_MODE_LABELS: Record<ThreadExecutionMode, string> = {
  default: "Default",
  "full-access": "Full access",
};

type SettingsMenuView = "access" | "model" | "reasoning" | "root";

function ChevronIcon(props: { direction: "back" | "forward" | "up" }) {
  const path =
    props.direction === "up"
      ? "M3 10l5-5 5 5"
      : props.direction === "back"
        ? "M10 3L5 8l5 5"
        : "M6 3l5 5-5 5";
  return (
    <svg aria-hidden="true" fill="none" height="10" viewBox="0 0 16 16" width="10">
      <path
        d={path}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  );
}

/**
 * Composer for surfaces with no vertical budget — currently the star map's
 * floating chat cards.
 *
 * This is deliberately NOT a variant of `Composer.tsx`. That component is
 * ~12,000 lines and needs the backend list, skills, directories,
 * launchpad state, and provider defaults that a floating card has no
 * access to. The two share a contract (send text, stop a running turn),
 * not an implementation.
 *
 * It does share the *input*: `ComposerTiptapInput` in markdown mode, the
 * same editor the full composer types into. A card that renders a fully
 * formatted transcript but takes replies through a plain textarea teaches
 * the operator that backticks and fences do not work here, which is the
 * opposite of true. The editor is not the expensive part of a card — each
 * one already mounts a whole `TranscriptList` — so cards mount it eagerly
 * rather than hydrating it on focus, which would cost a click and a caret
 * every time the operator moved between cards.
 *
 * Mentions come from `useComposerMentions`, driven by whatever populations
 * the host can honestly supply through `mentionSources`. Nothing about the
 * pickers is re-implemented here: the triggers, ranking, token minting and
 * markdown serialization are the same modules the full composer calls.
 *
 * Model / reasoning / access render as a chip on a status strip below the
 * field — a strip, not ambient text inside the field, because the field
 * scrolls at max height and anything pinned inside it ends up painting
 * over the draft. The chip doubles as the trigger for the settings menu,
 * which also absorbs the host's secondary actions; the strip stays one
 * line: chip on the left, Stop / Send pills on the right.
 */
export function CompactComposer(props: CompactComposerProps) {
  const mentions = useComposerMentions({
    disabled: props.disabled,
    sources: props.mentionSources,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<SettingsMenuView>("root");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const { onSend } = props;
  // Several cards can be open at once and the editor puts this on a DOM
  // `id`; a shared literal would give the map duplicate ids.
  const inputId = `compact-composer-${useId()}`;

  const settings = props.settingsMenu;
  const settingsOnOpen = settings?.onOpen;

  const accessLabel = props.executionMode
    ? EXECUTION_MODE_LABELS[props.executionMode]
    : undefined;
  const chipSegments = [
    props.model
      ? { danger: false, key: "model", text: props.model }
      : undefined,
    props.reasoningEffort
      ? { danger: false, key: "reasoning", text: props.reasoningEffort }
      : undefined,
    accessLabel
      ? {
          danger: props.executionMode === "full-access",
          key: "access",
          text: accessLabel,
        }
      : undefined,
  ].filter((segment): segment is NonNullable<typeof segment> =>
    Boolean(segment),
  );

  const send = useCallback(async () => {
    // The serialized text, not the plain draft: a mention chip is
    // zero-width until this splices its markdown back in.
    const text = mentions.text.trim();
    if (!text) return;
    // Clear optimistically so the input frees up immediately, then put the
    // draft back — chips and all — if the send turned out to fail.
    const previous = mentions.snapshot;
    mentions.clear();
    const delivered = await onSend(text);
    if (delivered === false) {
      mentions.restore(previous);
    }
  }, [mentions, onSend]);

  // The editor forwards the keys it does not claim itself: Enter without
  // Shift or Alt (both of which insert a newline), the arrows, and anything
  // it has no binding for — Escape and Tab among them.
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // An open mention popover claims the arrows, Enter, Tab, and Escape
      // before the send path sees them.
      if (mentions.handleKeyDown(event)) return;
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
      // The button checks this too. A disabled `<textarea>` used to swallow
      // the keydown for us; the editor only stops taking new text, and still
      // forwards Enter from a field that was focused before it was disabled.
      if (props.disabled) return;
      event.preventDefault();
      void send();
    },
    [mentions, props.disabled, send],
  );

  // Click-away and Escape close the menu. Without this it survives a click
  // on the transcript behind it and covers the conversation.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const toggleMenu = useCallback(() => {
    if (!menuOpen) {
      setMenuView("root");
      settingsOnOpen?.();
    }
    setMenuOpen(!menuOpen);
  }, [menuOpen, settingsOnOpen]);

  const closeAndSelect = useCallback((select: () => void) => {
    setMenuOpen(false);
    select();
  }, []);

  const actions = props.secondaryActions ?? [];
  // A section renders only when its mutation callback exists; the option
  // lists may still be loading the first time the menu opens.
  const modelSection = Boolean(
    settings?.onSelectModel
      && (settings.loading || (settings.models?.length ?? 0) > 0),
  );
  const reasoningSection = Boolean(
    settings?.onSelectReasoningEffort
      && (settings.loading || (settings.reasoningEfforts?.length ?? 0) > 0),
  );
  const fastSection = Boolean(
    settings?.onToggleFastMode && settings.supportsFastMode,
  );
  const accessSection = Boolean(
    settings?.onSelectExecutionMode
      && (settings.executionModes?.length ?? 0) > 1,
  );
  const hasSettingsRows =
    modelSection || reasoningSection || fastSection || accessSection;
  const hasMenu = hasSettingsRows || actions.length > 0;

  const settingRow = (
    label: string,
    value: ReactNode,
    view: SettingsMenuView,
  ) => (
    <button
      aria-haspopup="menu"
      className="compact-composer__menu-item compact-composer__menu-item--setting"
      onClick={() => setMenuView(view)}
      role="menuitem"
      type="button"
    >
      <span className="compact-composer__menu-label">{label}</span>
      {value}
      <span aria-hidden="true" className="compact-composer__menu-chevron">
        <ChevronIcon direction="forward" />
      </span>
    </button>
  );

  const optionRow = (params: {
    checked: boolean;
    danger?: boolean;
    key: string;
    label: string;
    onSelect: () => void;
  }) => (
    <button
      aria-checked={params.checked}
      className="compact-composer__menu-item compact-composer__menu-item--option"
      key={params.key}
      onClick={() => closeAndSelect(params.onSelect)}
      role="menuitemradio"
      type="button"
    >
      <span aria-hidden="true" className="compact-composer__menu-check">
        {params.checked ? "✓" : ""}
      </span>
      <span
        className={
          params.danger
            ? "compact-composer__menu-label compact-composer__menu-label--danger"
            : "compact-composer__menu-label"
        }
      >
        {params.label}
      </span>
    </button>
  );

  const submenu = (title: string, rows: ReactNode) => (
    <>
      <button
        className="compact-composer__menu-item compact-composer__menu-item--back"
        onClick={() => setMenuView("root")}
        role="menuitem"
        type="button"
      >
        <span aria-hidden="true" className="compact-composer__menu-chevron">
          <ChevronIcon direction="back" />
        </span>
        Back
      </button>
      <div className="compact-composer__menu-eyebrow">{title}</div>
      {rows}
    </>
  );

  const emptySubmenuNotice = (
    <div className="compact-composer__menu-empty">
      {settings?.loading ? "Loading options…" : "No options available."}
    </div>
  );

  let menuContent: ReactNode;
  if (menuView === "model") {
    const options = settings?.models ?? [];
    menuContent = submenu(
      "Model",
      options.length
        ? options.map((option) =>
            optionRow({
              checked: option.id === props.model,
              key: option.id,
              label: option.label ?? option.id,
              onSelect: () => settings?.onSelectModel?.(option.id),
            }),
          )
        : emptySubmenuNotice,
    );
  } else if (menuView === "reasoning") {
    const efforts = settings?.reasoningEfforts ?? [];
    menuContent = submenu(
      "Reasoning",
      efforts.length
        ? efforts.map((effort) =>
            optionRow({
              checked: effort === props.reasoningEffort,
              key: effort,
              label: effort,
              onSelect: () => settings?.onSelectReasoningEffort?.(effort),
            }),
          )
        : emptySubmenuNotice,
    );
  } else if (menuView === "access") {
    const modes = settings?.executionModes ?? [];
    menuContent = submenu(
      "Access",
      modes.map((entry) =>
        optionRow({
          checked: entry.mode === props.executionMode,
          danger: entry.mode === "full-access",
          key: entry.mode,
          label: entry.label,
          onSelect: () => settings?.onSelectExecutionMode?.(entry.mode),
        }),
      ),
    );
  } else {
    menuContent = (
      <>
        {modelSection
          ? settingRow(
              "Model",
              <span className="compact-composer__menu-value">
                {props.model}
              </span>,
              "model",
            )
          : null}
        {reasoningSection
          ? settingRow(
              "Reasoning",
              <span className="compact-composer__menu-value">
                {props.reasoningEffort}
              </span>,
              "reasoning",
            )
          : null}
        {fastSection ? (
          <button
            aria-checked={Boolean(props.fastMode)}
            className="compact-composer__menu-item compact-composer__menu-item--setting"
            onClick={() => settings?.onToggleFastMode?.(!props.fastMode)}
            role="menuitemcheckbox"
            type="button"
          >
            <span className="compact-composer__menu-label">Fast mode</span>
            <span
              aria-hidden="true"
              className={
                props.fastMode
                  ? "compact-composer__menu-toggle is-checked"
                  : "compact-composer__menu-toggle"
              }
            >
              <span className="compact-composer__menu-toggle-thumb" />
            </span>
          </button>
        ) : null}
        {accessSection
          ? settingRow(
              "Access",
              props.executionMode === "full-access" ? (
                <span className="compact-composer__menu-value compact-composer__menu-value--danger">
                  {accessLabel}
                </span>
              ) : (
                <span className="compact-composer__menu-value">
                  {accessLabel ?? "Default"}
                </span>
              ),
              "access",
            )
          : null}
        {hasSettingsRows && actions.length > 0 ? (
          <div
            aria-hidden="true"
            className="compact-composer__menu-separator"
          />
        ) : null}
        {actions.map((action) => (
          <button
            className="compact-composer__menu-item"
            disabled={action.disabled}
            key={action.key}
            onClick={() => {
              setMenuOpen(false);
              action.onSelect();
            }}
            role="menuitem"
            type="button"
          >
            {action.label}
          </button>
        ))}
      </>
    );
  }

  const chipContent =
    chipSegments.length > 0 ? (
      <>
        {chipSegments.map((segment, index) => (
          <span key={segment.key} className="compact-composer__chip-part">
            {index > 0 ? (
              <span aria-hidden="true" className="compact-composer__chip-dot">
                ·
              </span>
            ) : null}
            <span
              className={
                segment.danger
                  ? "compact-composer__chip-segment compact-composer__chip-segment--danger"
                  : "compact-composer__chip-segment"
              }
            >
              {segment.text}
            </span>
          </span>
        ))}
      </>
    ) : (
      // A thread with no model info still needs a door to the menu; the
      // bare glyph is the old kebab's, on the chip's own geometry.
      <span aria-hidden="true">⋯</span>
    );

  return (
    <div className="compact-composer">
      <div className="compact-composer__field">
        <ComposerTiptapInput
          ref={mentions.inputRef}
          ariaActiveDescendant={mentions.activeOptionId}
          ariaControls={mentions.listboxId}
          ariaExpanded={mentions.open}
          disabled={props.disabled}
          id={inputId}
          label={`Message ${props.threadTitle}`}
          markdownConversion
          onChange={mentions.handleChange}
          onKeyDown={onKeyDown}
          placeholder={props.placeholder ?? "Reply…"}
          skillTokens={mentions.skillTokens}
          value={mentions.draft}
        />
        {/* Inside the field, not portalled to the body: on the star map
            that is what keeps the list within `.star-map-chat-card`, the
            selector every camera-gesture guard tests against. */}
        {mentions.popover}
      </div>

      <div className="compact-composer__strip">
        {hasMenu ? (
          <div className="compact-composer__menu" ref={menuRef}>
            <button
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="Thread settings"
              className={
                menuOpen
                  ? "compact-composer__chip is-open"
                  : "compact-composer__chip"
              }
              onClick={toggleMenu}
              type="button"
            >
              {chipContent}
              <span
                aria-hidden="true"
                className="compact-composer__chip-chevron"
              >
                <ChevronIcon direction="up" />
              </span>
            </button>
            {/* Same in-card anchoring rule as the mention popover above. */}
            {menuOpen ? (
              <div className="compact-composer__menu-list" role="menu">
                {menuContent}
              </div>
            ) : null}
          </div>
        ) : chipSegments.length > 0 ? (
          // No menu to open (a host with no actions and no settings), so
          // the chip is informational only.
          <span
            aria-hidden="true"
            className="compact-composer__chip compact-composer__chip--static"
          >
            {chipContent}
          </span>
        ) : null}

        <span className="compact-composer__spacer" />

        {props.busy && props.onInterrupt ? (
          <button
            className="compact-composer__stop"
            onClick={props.onInterrupt}
            type="button"
          >
            Stop
          </button>
        ) : null}
        {/* A live turn used to leave Stop as the only control, which read as
            "you cannot say anything until this finishes". Sending stays
            available and becomes a steer; the host reports back whether the
            backend took it into the running turn or held it for the next. */}
        <button
          className="compact-composer__send"
          disabled={
            props.disabled
            || mentions.text.trim().length === 0
            || (props.busy && props.canSteer === false)
          }
          onClick={() => void send()}
          type="button"
        >
          {props.busy ? "Steer" : "Send"}
        </button>
      </div>
    </div>
  );
}
