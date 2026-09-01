import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  createRendererErrorReport,
  reportRendererError,
} from "../../lib/renderer-error-reporting";
import { SettingsSwitch } from "./SettingsSwitch";

/**
 * Layout primitives for settings screens. Compose `SettingsPanelHead`,
 * `SettingsSection`, `SettingsField`, and `SettingsCompOption` instead of
 * rolling per-pane markup so spacing, typography, and accessibility stay
 * consistent across panes.
 *
 * Visual contract follows the v2 design (see
 * `docs/design/pwragent-v2/project/settings.jsx` and `styles.css`):
 * - 22-px pane head (eyebrow + title + helper paragraph)
 * - cards with eyebrow + title + optional chip in head
 * - field rows with 220-px label column, label + sub stack on left
 * - composer-options as a vertical list with custom radio bullets
 */

/**
 * Shared chip-tone vocabulary used by both `SettingsSection.chipKind`
 * and `SettingsPathRowChip.tone`. Defined once here so the two
 * primitives can never drift apart.
 *
 * - `default`: neutral chip, panel-elevated background, muted text.
 * - `muted`: same neutrality as `default` — alias kept for callers
 *   whose semantics read better as "muted" (e.g. a path-row source
 *   tag like `application` / `path`).
 * - `ok`: success-tinted (configured, healthy, currently in use).
 * - `err`: danger-tinted (failed, unavailable).
 * - `warn`: accent-tinted (env override active, attention needed).
 */
export type SettingsChipTone = "default" | "muted" | "ok" | "err" | "warn";

function settingsChipClassName(kind?: SettingsChipTone): string {
  return kind && kind !== "default" && kind !== "muted"
    ? `settings-card__chip settings-card__chip--${kind}`
    : "settings-card__chip";
}

type SettingsSectionRegistration = {
  element: HTMLElement;
  id: string;
  title: string;
};

type SettingsSectionPaneContextValue = {
  allCollapsed: boolean;
  allExpanded: boolean;
  collapseAll: () => void;
  collapsedSections: Record<string, boolean>;
  expandAll: () => void;
  paneId: string;
  registerSection: (section: SettingsSectionRegistration) => () => void;
  registeredSections: SettingsSectionRegistration[];
  rememberSectionVisit: (sectionId: string) => void;
  toggleSection: (sectionId: string) => void;
};

const SettingsSectionPaneContext =
  createContext<SettingsSectionPaneContextValue | null>(null);

const savedCollapsedSectionsByPane = new Map<string, Record<string, boolean>>();
const savedVisitedSectionByPane = new Map<string, string>();
const savedGroupCollapsed = new Map<string, boolean>();

function slugForSettingsId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function SettingsSectionStack(props: {
  "aria-label": string;
  children: ReactNode;
  paneId: string;
}) {
  const [registeredSections, setRegisteredSections] = useState<
    SettingsSectionRegistration[]
  >([]);
  const [collapsedSections, setCollapsedSections] = useState<
    Record<string, boolean>
  >(() => savedCollapsedSectionsByPane.get(props.paneId) ?? {});
  const didRestoreFocusRef = useRef(false);
  const stackRef = useRef<HTMLElement | null>(null);
  const paneChangedRef = useRef(false);
  const [seededPaneId, setSeededPaneId] = useState(props.paneId);
  if (seededPaneId !== props.paneId) {
    // The stack instance survives hub↔focused pane swaps (same component
    // type at the same tree position), so per-pane state must be
    // re-seeded by hand: the initializer read the saved map for the old
    // pane, and carrying that state over would restore nothing for the
    // new pane and save the old pane's map under the new id.
    setSeededPaneId(props.paneId);
    setCollapsedSections(savedCollapsedSectionsByPane.get(props.paneId) ?? {});
    setRegisteredSections([]);
    didRestoreFocusRef.current = false;
    paneChangedRef.current = true;
  }

  const updateCollapsedSections = useCallback(
    (
      updater: (
        current: Record<string, boolean>,
      ) => Record<string, boolean>,
    ) => {
      setCollapsedSections((current) => {
        const next = updater(current);
        savedCollapsedSectionsByPane.set(props.paneId, next);
        return next;
      });
    },
    [props.paneId],
  );

  const registerSection = useCallback(
    (section: SettingsSectionRegistration) => {
      setRegisteredSections((current) => {
        const existingIndex = current.findIndex(
          (entry) => entry.id === section.id,
        );
        if (existingIndex === -1) {
          return [...current, section];
        }
        const next = [...current];
        next[existingIndex] = section;
        return next;
      });

      return () => {
        setRegisteredSections((current) =>
          current.filter((entry) => entry.id !== section.id),
        );
      };
    },
    [],
  );

  const rememberSectionVisit = useCallback(
    (sectionId: string) => {
      savedVisitedSectionByPane.set(props.paneId, sectionId);
    },
    [props.paneId],
  );

  const toggleSection = useCallback(
    (sectionId: string) => {
      updateCollapsedSections((current) => {
        const nextCollapsed = current[sectionId] !== true;
        if (!nextCollapsed) {
          savedVisitedSectionByPane.set(props.paneId, sectionId);
        }
        return {
          ...current,
          [sectionId]: nextCollapsed,
        };
      });
    },
    [props.paneId, updateCollapsedSections],
  );

  const collapseAll = useCallback(() => {
    updateCollapsedSections((current) => {
      const next = { ...current };
      for (const section of registeredSections) {
        next[section.id] = true;
      }
      return next;
    });
  }, [registeredSections, updateCollapsedSections]);

  const expandAll = useCallback(() => {
    updateCollapsedSections((current) => {
      const next = { ...current };
      for (const section of registeredSections) {
        next[section.id] = false;
      }
      return next;
    });
  }, [registeredSections, updateCollapsedSections]);

  const allCollapsed =
    registeredSections.length > 0 &&
    registeredSections.every((section) => collapsedSections[section.id] === true);
  const allExpanded =
    registeredSections.length > 0 &&
    registeredSections.every((section) => collapsedSections[section.id] !== true);

  useEffect(() => {
    if (didRestoreFocusRef.current || registeredSections.length === 0) {
      return;
    }
    didRestoreFocusRef.current = true;
    const paneChanged = paneChangedRef.current;
    paneChangedRef.current = false;
    const visitedSectionId = savedVisitedSectionByPane.get(props.paneId);
    const visitedSection = visitedSectionId
      ? registeredSections.find((section) => section.id === visitedSectionId)
      : undefined;
    if (visitedSection) {
      visitedSection.element.focus();
      return;
    }
    // A pane swap unmounts the control that had focus (an index row, a
    // strip action, a breadcrumb crumb); without a programmatic target
    // the browser drops focus to <body> and Tab restarts at the top of
    // the overlay. Land on the pane itself instead.
    if (paneChanged && document.activeElement === document.body) {
      stackRef.current?.focus();
    }
  }, [props.paneId, registeredSections]);

  const value = useMemo<SettingsSectionPaneContextValue>(
    () => ({
      allCollapsed,
      allExpanded,
      collapseAll,
      collapsedSections,
      expandAll,
      paneId: props.paneId,
      registerSection,
      registeredSections,
      rememberSectionVisit,
      toggleSection,
    }),
    [
      allCollapsed,
      allExpanded,
      collapseAll,
      collapsedSections,
      expandAll,
      props.paneId,
      registerSection,
      registeredSections,
      rememberSectionVisit,
      toggleSection,
    ],
  );

  return (
    <SettingsSectionPaneContext.Provider value={value}>
      <section
        ref={stackRef}
        className="settings-stack"
        aria-label={props["aria-label"]}
        tabIndex={-1}
      >
        {props.children}
      </section>
    </SettingsSectionPaneContext.Provider>
  );
}

export function SettingsPanelHead(props: {
  eyebrow: string;
  title: ReactNode;
  help?: ReactNode;
  /** Optional right-side action (e.g. "Check for updates" button). */
  action?: ReactNode;
}) {
  const pane = useContext(SettingsSectionPaneContext);
  const bulkControls = pane?.registeredSections.length ? (
    <SettingsSectionBulkControls />
  ) : null;

  return (
    <header className="settings-head">
      <div className="settings-head__text">
        <p className="settings-head__eyebrow">{props.eyebrow}</p>
        <h1 className="settings-head__title">{props.title}</h1>
        {props.help ? (
          <p className="settings-head__help">{props.help}</p>
        ) : null}
      </div>
      {props.action || bulkControls ? (
        <div className="settings-head__action">
          {bulkControls}
          {props.action}
        </div>
      ) : null}
    </header>
  );
}

function SettingsSectionBulkControls() {
  const pane = useContext(SettingsSectionPaneContext);
  if (!pane || pane.registeredSections.length === 0) {
    return null;
  }

  return (
    <div className="settings-section-controls" aria-label="Section controls">
      <button
        className="button button--ghost settings-section-controls__button"
        disabled={pane.allCollapsed}
        type="button"
        onClick={pane.collapseAll}
      >
        Collapse all
      </button>
      <button
        className="button button--ghost settings-section-controls__button"
        disabled={pane.allExpanded}
        type="button"
        onClick={pane.expandAll}
      >
        Expand all
      </button>
    </div>
  );
}

export function SettingsSection(props: {
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  children: ReactNode;
  /** Optional right-side chip in the card header. */
  chip?: ReactNode;
  chipKind?: SettingsChipTone;
  "aria-label"?: string;
  sectionId?: string;
}) {
  const generatedId = useId();
  const pane = useContext(SettingsSectionPaneContext);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const slug = slugForSettingsId(props.sectionId ?? props.title);
  const sectionId = `${pane?.paneId ?? "global"}-${slug || generatedId}`;
  const registerSection = pane?.registerSection;
  const headingId = `settings-section-${sectionId}-heading`;
  const bodyId = `settings-section-${sectionId}-body`;
  const collapsed = pane?.collapsedSections[sectionId] === true;

  const chipClass = settingsChipClassName(props.chipKind);

  useLayoutEffect(() => {
    const element = headerRef.current;
    if (!registerSection || !element) {
      return;
    }
    return registerSection({
      element,
      id: sectionId,
      title: props.title,
    });
  }, [props.title, registerSection, sectionId]);

  const focusSiblingHeader = (direction: "next" | "previous" | "first" | "last") => {
    if (!pane) return;
    const sections = pane.registeredSections;
    const currentIndex = sections.findIndex((section) => section.id === sectionId);
    if (currentIndex === -1) return;

    let nextIndex: number;
    if (direction === "next") {
      nextIndex = Math.min(sections.length - 1, currentIndex + 1);
    } else if (direction === "previous") {
      nextIndex = Math.max(0, currentIndex - 1);
    } else if (direction === "first") {
      nextIndex = 0;
    } else {
      nextIndex = sections.length - 1;
    }

    const nextSection = sections[nextIndex];
    nextSection?.element.focus();
    if (nextSection) {
      pane.rememberSectionVisit(nextSection.id);
    }
  };

  const handleHeaderKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!pane) return;

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pane.toggleSection(sectionId);
      pane.rememberSectionVisit(sectionId);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusSiblingHeader("next");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusSiblingHeader("previous");
    } else if (event.key === "Home") {
      event.preventDefault();
      focusSiblingHeader("first");
    } else if (event.key === "End") {
      event.preventDefault();
      focusSiblingHeader("last");
    }
  };

  const handleHeaderClick = () => {
    pane?.toggleSection(sectionId);
    pane?.rememberSectionVisit(sectionId);
  };

  return (
    <section
      aria-labelledby={headingId}
      aria-label={props["aria-label"]}
      className={`settings-panel settings-panel--has-body settings-panel--collapsible${
        collapsed ? " settings-panel--is-collapsed" : ""
      }`}
    >
      <div
        ref={headerRef}
        aria-controls={bodyId}
        aria-expanded={!collapsed}
        aria-label={props.title}
        className="settings-panel__header settings-section__header-button"
        role="button"
        tabIndex={0}
        onClick={handleHeaderClick}
        onKeyDown={handleHeaderKeyDown}
      >
        <span className="settings-section__chevron" aria-hidden="true" />
        <div className="settings-section__header-main">
          {props.eyebrow ? <p className="eyebrow">{props.eyebrow}</p> : null}
          <h2 id={headingId}>{props.title}</h2>
          {props.description ? (
            <p className="settings-section__description">{props.description}</p>
          ) : null}
        </div>
        <span className="settings-section__header-actions">
          {props.chip ? <span className={chipClass}>{props.chip}</span> : null}
        </span>
      </div>
      <div
        id={bodyId}
        aria-hidden={collapsed}
        className="settings-section__body-clip"
        inert={collapsed ? true : undefined}
      >
        <div className="settings-section__body">{props.children}</div>
      </div>
    </section>
  );
}

/**
 * Collapsible drawer that wraps a set of `SettingsSection` cards under a
 * single section-style header. Unlike `SettingsSection`, the group owns its
 * own collapse state (so it can start collapsed without a first-paint flash
 * or a special case in the pane reducer), and it renders its children inside
 * a fresh `SettingsSectionStack`. That nested stack gives the child sections
 * their own pane so they keep full collapsible headers without registering
 * into — and polluting the "Collapse all / Expand all" controls and arrow-key
 * navigation of — the parent pane.
 *
 * Header chrome reuses the same class hierarchy as `SettingsSection` so the
 * eyebrow / title / chevron / chip read identically (see the chrome-reuse
 * rule in CLAUDE.md).
 */
export function SettingsSectionGroup(props: {
  /** Stable id used both to persist collapse state and to seed the nested
   *  pane id. Must be globally unique — collapse state is keyed by this id in
   *  a module-level map shared across every group in the app. */
  groupId: string;
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  children: ReactNode;
  /** Optional right-side chip in the group header. */
  chip?: ReactNode;
  chipKind?: SettingsChipTone;
  /** Initial collapse state on first mount (before any user toggle). */
  defaultCollapsed?: boolean;
  "aria-label"?: string;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(
    () => savedGroupCollapsed.get(props.groupId) ?? props.defaultCollapsed ?? false,
  );
  const headingId = `settings-group-${props.groupId}-heading`;
  const bodyId = `settings-group-${props.groupId}-body`;

  const chipClass = settingsChipClassName(props.chipKind);

  const toggle = () => {
    setCollapsed((current) => {
      const next = !current;
      savedGroupCollapsed.set(props.groupId, next);
      return next;
    });
  };

  // Disclosure-style: Enter/Space toggle. Unlike `SettingsSection`, the group
  // is not registered in a pane, so it intentionally omits the Arrow/Home/End
  // roving navigation — it is a standalone control reached via Tab, and its
  // children get their own arrow-key ring inside the nested stack.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };

  return (
    // The outer region is named by its heading (`aria-labelledby`); the
    // `aria-label` prop instead names the nested stack below so we don't end up
    // with two identically-named region landmarks.
    <section
      aria-labelledby={headingId}
      className={`settings-panel settings-panel--has-body settings-panel--collapsible settings-section-group${
        collapsed ? " settings-panel--is-collapsed" : ""
      }`}
    >
      <div
        aria-controls={bodyId}
        aria-expanded={!collapsed}
        aria-label={props.title}
        className="settings-panel__header settings-section__header-button"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={handleKeyDown}
      >
        <span className="settings-section__chevron" aria-hidden="true" />
        <div className="settings-section__header-main">
          {props.eyebrow ? <p className="eyebrow">{props.eyebrow}</p> : null}
          <h2 id={headingId}>{props.title}</h2>
          {props.description ? (
            <p className="settings-section__description">{props.description}</p>
          ) : null}
        </div>
        <span className="settings-section__header-actions">
          {props.chip ? <span className={chipClass}>{props.chip}</span> : null}
        </span>
      </div>
      <div
        id={bodyId}
        aria-hidden={collapsed}
        className="settings-section__body-clip"
        inert={collapsed ? true : undefined}
      >
        <div className="settings-section__body settings-section-group__body">
          <SettingsSectionStack
            aria-label={props["aria-label"] ?? props.title}
            paneId={`${props.groupId}-nested`}
          >
            {props.children}
          </SettingsSectionStack>
        </div>
      </div>
    </section>
  );
}

/**
 * 220-px label column field row. Replaces the legacy `SettingsRow` for
 * settings panes. Label + sub-line stack on left; control + help stack
 * on right.
 */
export function SettingsField(props: {
  /** Visible label adjacent to the control. Narrowed to `string` so
   *  the accessibility contract is explicit — empty/null/array would
   *  render a malformed label. */
  label: string;
  /** 12-px description below the label. Single sentence framing. */
  sub?: ReactNode;
  /** 11.5-px hint below the control. */
  help?: ReactNode;
  /** Optional source / status chip (existing `.settings-source` pill). */
  source?: ReactNode;
  control: ReactNode;
  /** Optional inline error message rendered under the control. */
  error?: ReactNode;
  /** Follow-on controls for the field (a reset button row), rendered under
   *  the control rather than beside it. */
  actions?: ReactNode;
  /** Opt into the shared pending affordance: pass a boolean (not
   *  `undefined`) and the control is laid out on a row with a spinner and
   *  "Saving…" to its right, driven by `useSettingsFieldPending`.
   *
   *  Only opt in when the control is narrow enough to leave room — a switch
   *  or a segmented group. A full-width input has none, and the indicator
   *  would wrap under it. */
  pending?: boolean;
  /** Overrides the indicator's "Saving…" wording, for a wait that is not a
   *  config write — a probe or a count the row is holding open. */
  pendingLabel?: string;
}) {
  const control = props.pending === undefined ? (
    props.control
  ) : (
    // A div, not a span: `SegmentedField`'s control is a `role="radiogroup"`
    // div, and flow content inside phrasing content is invalid markup that an
    // HTML parser reparents out of the flex row.
    <div className="settings-control-row">
      {props.control}
      <SettingsPendingIndicator
        label={props.pendingLabel}
        pending={props.pending}
      />
    </div>
  );

  return (
    <div className="settings-field">
      <div className="settings-field__label">
        <span>{props.label}</span>
        {props.sub ? (
          <span className="settings-field__sub">{props.sub}</span>
        ) : null}
        {props.source ? (
          <span className="settings-source">{props.source}</span>
        ) : null}
      </div>
      <div className="settings-field__control">
        {control}
        {props.actions}
        {props.help ? (
          <span className="settings-field__help">{props.help}</span>
        ) : null}
        {props.error ? (
          <p className="settings-row__error" role="alert">
            {props.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Per-control pending latch for a settings write.
 *
 * `useDesktopSettings` exposes a single `saving` boolean for the whole pane,
 * so a control cannot learn from it whether *it* was the one the operator
 * actuated — reading it directly would light up every control on the panel
 * at once. Each control instead awaits the promise its own handler returns,
 * which scopes the affordance to the actuated control and clears it on
 * failure as well as success.
 *
 * Field handlers are typed to return a promise for exactly this reason: a
 * fire-and-forget `void save(...)` body is a type error here instead of a
 * control that silently never shows pending.
 */
export type SettingsFieldPending = {
  pending: boolean;
  /** Hold the pending state until `result` settles. Overlapping writes are
   *  counted, so an early one returning does not clear a later one. */
  track: (result: Promise<unknown>) => void;
};

export function useSettingsFieldPending(): SettingsFieldPending {
  const [inFlight, setInFlight] = useState(0);

  const track = useCallback((result: Promise<unknown>): void => {
    setInFlight((current) => current + 1);
    const settle = () => {
      setInFlight((current) => Math.max(0, current - 1));
    };
    // `Promise.resolve` rather than `result.then`: `track` is exported, and a
    // caller handing it a non-thenable would otherwise throw out of the click
    // handler with `inFlight` already incremented — a row stuck at "Saving…"
    // with no write outstanding.
    //
    // Settling on rejection is what clears the row, but the handler must not
    // be where the error stops. `void save(...)` used to let a rejection reach
    // the `unhandledrejection` reporter in lib/renderer-error-reporting.ts;
    // most writes go through `writeConfig`, which catches and owns the error
    // copy, but not all of them do (`onMessagingEnabledChange` calls
    // `setMessagingEnabled` directly), so re-report rather than swallow.
    Promise.resolve(result).then(settle, (error: unknown) => {
      settle();
      // "unhandled-rejection" is the honest source: this is the report the
      // global handler would have filed before `track` attached a handler.
      reportRendererError(
        createRendererErrorReport("unhandled-rejection", error),
      );
    });
  }, []);

  return { pending: inFlight > 0, track };
}

/**
 * The shared "write in flight" affordance: the renderer's one spinner plus
 * the word, announced through a `role="status"` region.
 *
 * The region mounts only while the write is in flight, matching how the rest
 * of the settings panes announce transient state. Keeping an empty region
 * mounted per field would read marginally better to a screen reader — a live
 * region present before its text lands — but a pane carries dozens of these
 * fields, and dozens of standing announcer regions is the worse trade. Saves
 * here run for seconds, so the region is present long enough to be picked up.
 */
export function SettingsPendingIndicator(props: {
  pending: boolean;
  /** Overrides the default "Saving…" wording. */
  label?: string;
}) {
  if (!props.pending) {
    return null;
  }

  return (
    <span className="settings-pending" role="status">
      <span aria-hidden="true" className="pending-spinner pending-spinner--sm" />
      {props.label ?? "Saving…"}
    </span>
  );
}

/**
 * Switch row. `onChange` returns the write's promise so the row can show
 * pending for its own save only — see `useSettingsFieldPending`.
 */
export function ToggleField(props: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  /** Disambiguates the switch when the row's label only reads correctly in
   *  place — an "Enabled" row inside a named agent's card needs the switch to
   *  say which agent. Appended to `label` rather than replacing it: WCAG 2.5.3
   *  Label in Name requires the visible text to appear in the accessible name,
   *  or a Voice Control user saying "click Enabled" matches nothing. */
  switchQualifier?: string;
  sub?: ReactNode;
  help?: ReactNode;
  source?: ReactNode;
  /** Follow-on controls for the row (a confirmation prompt, an apply button),
   *  rendered under the switch rather than beside it. */
  actions?: ReactNode;
  /** Overrides the pending indicator's "Saving…" wording. */
  pendingLabel?: string;
  onChange: (value: boolean) => Promise<unknown>;
}) {
  const { pending, track } = useSettingsFieldPending();

  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      help={props.help}
      source={props.source}
      actions={props.actions}
      pending={pending}
      pendingLabel={props.pendingLabel}
      control={
        <SettingsSwitch
          checked={props.checked}
          disabled={props.disabled}
          label={
            props.switchQualifier
              ? `${props.label} — ${props.switchQualifier}`
              : props.label
          }
          pending={pending}
          onChange={(value) => track(props.onChange(value))}
        />
      }
    />
  );
}

/**
 * The segmented radio group itself, without a field row around it.
 *
 * Split out of `SegmentedField` because the group also appears inside
 * composite controls that supply their own surrounding layout (the update
 * channel's row of buttons and version text). Those sites used to hand-roll
 * the markup, which is how they drifted: same class names, but no same-value
 * guard and no busy state. The caller owns the pending tracker so it can place
 * the indicator to suit its layout; this component owns which segment is busy.
 */
export type SegmentedControlProps<TValue extends string | number> = {
  disabled?: boolean;
  /** Names the group for assistive tech. */
  label: string;
  /** An option carrying `meta` renders stacked, with the secondary line under
   *  its label — release versions, delays, thresholds. The two always went
   *  together in the hand-rolled groups this replaced, so presence of `meta`
   *  is what selects the variant rather than a separate flag to keep in sync. */
  options: Array<{ label: string; meta?: ReactNode; value: TValue }>;
  value: TValue;
} & (
  | {
      /** A tracker from `useSettingsFieldPending`. Supplying one obliges
       *  `onChange` to return the write's promise, so a fire-and-forget
       *  handler is a type error rather than a control that never shows
       *  pending. */
      pending: SettingsFieldPending;
      onChange: (value: TValue) => Promise<unknown>;
    }
  | {
      /** No tracker: the change lands immediately and needs no affordance.
       *  Appearance axes apply optimistically — the window re-themes or
       *  re-sizes on the click — and some groups only move local state. Say
       *  so explicitly rather than passing a tracker nothing would drive. */
      pending?: undefined;
      onChange: (value: TValue) => void;
    }
);

export function SegmentedControl<TValue extends string | number>(
  props: SegmentedControlProps<TValue>,
) {
  // Which segments have a write outstanding, counted per value. A single
  // "last picked" would mark the wrong segment busy as soon as two writes
  // overlap: pick A, pick B before A returns, B settles first, and the ring
  // sits on B while A is still going.
  const [busyValues, setBusyValues] = useState<ReadonlyArray<TValue>>([]);

  return (
    <div className="settings-segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map((option) => (
        <button
          key={option.value}
          aria-busy={busyValues.includes(option.value) ? true : undefined}
          aria-checked={props.value === option.value}
          className={`settings-segmented__button${
            option.meta === undefined
              ? ""
              : " settings-segmented__button--stacked"
          }${props.value === option.value ? " is-active" : ""}`}
          disabled={props.disabled}
          role="radio"
          type="button"
          onClick={() => {
            // Re-clicking the selected segment is not a change. Several panes
            // route through a delta builder that bails when nothing moved, so
            // tracking it would announce "Saving…" for a write that never
            // happens.
            if (option.value === props.value) {
              return;
            }
            if (props.pending === undefined) {
              props.onChange(option.value);
              return;
            }
            setBusyValues((current) => [...current, option.value]);
            const clear = () => {
              setBusyValues((current) => {
                const at = current.indexOf(option.value);
                if (at < 0) {
                  return current;
                }
                return [...current.slice(0, at), ...current.slice(at + 1)];
              });
            };
            const result = Promise.resolve(props.onChange(option.value));
            result.then(clear, clear);
            props.pending.track(result);
          }}
        >
          {option.meta === undefined ? (
            option.label
          ) : (
            <>
              <span>{option.label}</span>
              <span className="settings-segmented__meta">{option.meta}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Segmented (radio group) row. Like `ToggleField`, pending is scoped to this
 * field's own write; the option the operator picked also carries `aria-busy`
 * so the busy state is attached to the chosen segment, not the whole group.
 */
export function SegmentedField<TValue extends string | number>(props: {
  actions?: ReactNode;
  disabled?: boolean;
  label: string;
  sub?: ReactNode;
  help?: ReactNode;
  /** Inline error rendered under the group. */
  error?: ReactNode;
  options: Array<{ label: string; meta?: ReactNode; value: TValue }>;
  source?: ReactNode;
  value: TValue;
  /** Overrides the pending indicator's "Saving…" wording. */
  pendingLabel?: string;
  onChange: (value: TValue) => Promise<unknown>;
}) {
  const fieldPending = useSettingsFieldPending();

  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      help={props.help}
      error={props.error}
      source={props.source}
      actions={props.actions}
      pending={fieldPending.pending}
      pendingLabel={props.pendingLabel}
      control={
        <SegmentedControl
          disabled={props.disabled}
          label={props.label}
          options={props.options}
          pending={fieldPending}
          value={props.value}
          onChange={props.onChange}
        />
      }
    />
  );
}

/**
 * Compact cross-link strip shown at the top of a focused sub-screen
 * (per-provider, per-platform). Summarizes the parent hub's key state
 * — "New thread defaults" on a provider screen, "Messaging general"
 * on a platform screen — with one action back to the hub, so editing
 * a provider never strands the operator away from the defaults.
 */
export function SettingsContextStrip(props: {
  /** Tiny uppercase kicker, e.g. "Defaults" / "General". */
  eyebrow: string;
  /** Name of the summarized hub surface, e.g. "New thread defaults". */
  label: string;
  /** Summary chips (current model, effort, master switch state, …). */
  items: ReactNode[];
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div aria-label={`${props.label} summary`} className="settings-strip" role="note">
      <span className="settings-strip__eyebrow">{props.eyebrow}</span>
      <span className="settings-strip__label">{props.label}</span>
      <span className="settings-strip__meta">
        {props.items.map((item, index) => (
          <span key={index} className="settings-strip__chip">
            {item}
          </span>
        ))}
      </span>
      <button
        className="button button--ghost settings-strip__action"
        type="button"
        onClick={props.onAction}
      >
        {props.actionLabel}
      </button>
    </div>
  );
}

/**
 * One row of a hub index (AI Providers → provider list, Messaging →
 * platform list). The whole row is the button that opens the entry's
 * focused screen.
 */
export function SettingsIndexRow(props: {
  name: string;
  /** Optional leading mark (platform icon). */
  glyph?: ReactNode;
  /** Mono detail under the name (active path, version, adapter state). */
  meta?: ReactNode;
  chip?: ReactNode;
  chipKind?: SettingsChipTone;
  /** Renders the name muted — the entry is switched off. */
  off?: boolean;
  onOpen: () => void;
}) {
  // The aria-label wins the accname computation, which silences the
  // meta and chip text inside the button — re-expose them as the
  // button's description instead of stuffing them into the label.
  const descriptionId = useId();
  const metaId = props.meta ? `${descriptionId}-meta` : undefined;
  const chipId = props.chip ? `${descriptionId}-chip` : undefined;
  const describedBy =
    [metaId, chipId].filter(Boolean).join(" ") || undefined;
  return (
    <button
      aria-describedby={describedBy}
      aria-label={`Open ${props.name} settings`}
      className={`settings-index__row${props.off ? " is-off" : ""}`}
      type="button"
      onClick={props.onOpen}
    >
      {props.glyph ? (
        <span aria-hidden="true" className="settings-index__glyph">
          {props.glyph}
        </span>
      ) : null}
      <span className="settings-index__main">
        <span className="settings-index__name">{props.name}</span>
        {props.meta ? (
          <span id={metaId} className="settings-index__meta">
            {props.meta}
          </span>
        ) : null}
      </span>
      {props.chip ? (
        <span id={chipId} className={settingsChipClassName(props.chipKind)}>
          {props.chip}
        </span>
      ) : null}
      <span aria-hidden="true" className="settings-index__open">
        Configure ›
      </span>
    </button>
  );
}

/**
 * Composer-style radio card — used by Experimental → Reply Composer.
 * Renders as `<button role="radio">` so the existing test contract
 * (`getByRole("radio", { name: ... })`) continues to work.
 */
export function SettingsCompOption<TValue extends string>(props: {
  value: TValue;
  title: string;
  sub: string;
  isDefault?: boolean;
  active: boolean;
  disabled?: boolean;
  onSelect: (value: TValue) => void;
}) {
  return (
    <button
      aria-checked={props.active}
      aria-label={props.title}
      className={`settings-comp-opt${props.active ? " is-active" : ""}`}
      disabled={props.disabled}
      role="radio"
      type="button"
      onClick={() => props.onSelect(props.value)}
    >
      <span
        aria-hidden="true"
        className={`settings-comp-opt__radio${
          props.active ? " is-on" : ""
        }`}
      >
        {props.active ? <span className="settings-comp-opt__radio-dot" /> : null}
      </span>
      <span className="settings-comp-opt__text">
        <span className="settings-comp-opt__title">
          {props.title}
          {props.isDefault ? (
            <span aria-hidden="true" className="settings-comp-opt__defbadge">
              Default
            </span>
          ) : null}
        </span>
        <span className="settings-comp-opt__sub">{props.sub}</span>
      </span>
    </button>
  );
}
