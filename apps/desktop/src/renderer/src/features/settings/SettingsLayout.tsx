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
    const visitedSectionId = savedVisitedSectionByPane.get(props.paneId);
    if (!visitedSectionId) {
      return;
    }
    const visitedSection = registeredSections.find(
      (section) => section.id === visitedSectionId,
    );
    visitedSection?.element.focus();
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
      <section className="settings-stack" aria-label={props["aria-label"]}>
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

  const chipClass =
    props.chipKind && props.chipKind !== "default" && props.chipKind !== "muted"
      ? `settings-card__chip settings-card__chip--${props.chipKind}`
      : "settings-card__chip";

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

    let nextIndex = currentIndex;
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
        <div className="settings-section__header-main">
          {props.eyebrow ? <p className="eyebrow">{props.eyebrow}</p> : null}
          <h2 id={headingId}>{props.title}</h2>
          {props.description ? (
            <p className="settings-section__description">{props.description}</p>
          ) : null}
        </div>
        <span className="settings-section__header-actions">
          {props.chip ? <span className={chipClass}>{props.chip}</span> : null}
          <span className="settings-section__chevron" aria-hidden="true" />
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
}) {
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
        {props.control}
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
