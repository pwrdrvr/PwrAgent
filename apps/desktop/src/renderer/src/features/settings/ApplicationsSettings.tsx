import { useCallback, useEffect, useState } from "react";
import type {
  DesktopApplicationDiscoveryCandidate,
  DesktopApplicationKind,
  DesktopSettingsSnapshot,
  GhStatus,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

export function ApplicationsSettings(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onPreferredApplicationChange: (
    kind: DesktopApplicationKind,
    preferredId: string,
  ) => Promise<void>;
}) {
  return (
    <section className="settings-stack" aria-label="Application settings">
      <ApplicationPanel
        applications={props.snapshot.applications.editors}
        emptyLabel="No editors found."
        eyebrow="Applications"
        preferredId={props.snapshot.applications.preferredEditorId.value}
        saving={props.saving}
        title="Editor"
        onPreferredApplicationChange={props.onPreferredApplicationChange}
      />
      <ApplicationPanel
        applications={props.snapshot.applications.terminals}
        emptyLabel="No terminals found."
        eyebrow="Applications"
        preferredId={props.snapshot.applications.preferredTerminalId.value}
        saving={props.saving}
        title="Terminal"
        onPreferredApplicationChange={props.onPreferredApplicationChange}
      />
      <GhStatusPanel desktopApi={props.desktopApi} />
    </section>
  );
}

function GhStatusPanel(props: { desktopApi?: DesktopApi }) {
  const desktopApi = props.desktopApi;
  const [status, setStatus] = useState<GhStatus | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(
    async (recheck: boolean) => {
      if (!desktopApi?.getGhStatus) return;
      setLoading(true);
      setError(undefined);
      try {
        const next = await desktopApi.getGhStatus({ recheck });
        setStatus(next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    },
    [desktopApi],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const pill = describeGhStatusPill(status);

  return (
    <section className="settings-panel" aria-labelledby="settings-gh-title">
      <div className="settings-panel__header">
        <div>
          <p className="eyebrow">Applications</p>
          <h2 id="settings-gh-title">GitHub CLI (gh)</h2>
        </div>
        <button
          className="button button--secondary"
          disabled={loading || !desktopApi?.getGhStatus}
          type="button"
          onClick={() => void load(true)}
        >
          {loading ? "Checking…" : "Re-check"}
        </button>
      </div>
      <p className="settings-panel__hint">
        PwrAgent uses <code>gh</code> to read pull request status for thread chips.
        It never opens, comments on, or merges PRs — read-only.
      </p>
      <div className="settings-gh-status">
        <span
          className={`settings-pill settings-pill--${pill.tone}`}
          aria-live="polite"
        >
          {pill.label}
        </span>
        {status?.account ? (
          <span className="settings-application__path">
            Signed in as <strong>{status.account}</strong>
          </span>
        ) : null}
        {status && status.installed && status.scopes.length > 0 ? (
          <span className="settings-application__path">
            Scopes: {status.scopes.join(", ")}
          </span>
        ) : null}
        {status?.reason ? (
          <span className="settings-application__path">{status.reason}</span>
        ) : null}
        {error ? (
          <span className="settings-application__path settings-error">{error}</span>
        ) : null}
      </div>
    </section>
  );
}

function describeGhStatusPill(status: GhStatus | undefined): {
  tone: "ok" | "warn" | "bad" | "neutral";
  label: string;
} {
  if (!status) return { tone: "neutral", label: "Checking…" };
  if (!status.installed) return { tone: "bad", label: "Not installed" };
  if (!status.loggedIn) return { tone: "bad", label: "Not signed in" };
  if (!status.hasRepoScope)
    return { tone: "warn", label: "Missing `repo` scope" };
  return { tone: "ok", label: "Connected" };
}

function ApplicationPanel(props: {
  applications: DesktopApplicationDiscoveryCandidate[];
  emptyLabel: string;
  eyebrow: string;
  preferredId: string;
  saving: boolean;
  title: string;
  onPreferredApplicationChange: (
    kind: DesktopApplicationKind,
    preferredId: string,
  ) => Promise<void>;
}) {
  const fallbackSelectedId = props.applications.find(
    (application) => application.canOpenWorkspace,
  )?.id;
  const selectedId = props.preferredId || fallbackSelectedId;

  return (
    <section className="settings-panel" aria-labelledby={`settings-${props.title}-title`}>
      <div className="settings-panel__header">
        <div>
          <p className="eyebrow">{props.eyebrow}</p>
          <h2 id={`settings-${props.title}-title`}>{props.title}</h2>
        </div>
      </div>
      <div className="settings-applications">
        {props.applications.length === 0 ? (
          <p className="settings-empty">{props.emptyLabel}</p>
        ) : (
          props.applications.map((application) => (
            <ApplicationRow
              key={`${application.kind}:${application.id}`}
              application={application}
              selected={application.id === selectedId}
              saving={props.saving}
              onPreferredApplicationChange={props.onPreferredApplicationChange}
            />
          ))
        )}
      </div>
    </section>
  );
}

function ApplicationRow(props: {
  application: DesktopApplicationDiscoveryCandidate;
  saving: boolean;
  selected: boolean;
  onPreferredApplicationChange: (
    kind: DesktopApplicationKind,
    preferredId: string,
  ) => Promise<void>;
}) {
  const location = props.application.appPath ?? props.application.executablePath;

  return (
    <div className={`settings-application${props.selected ? " is-selected" : ""}`}>
      <ApplicationIcon application={props.application} />
      <div className="settings-application__body">
        <div className="settings-application__header">
          <span className="settings-application__name">{props.application.name}</span>
          <span className="settings-source">{props.application.source}</span>
          {props.application.canOpenWorkspace ? (
            <span className="settings-source">openable</span>
          ) : null}
        </div>
        {location ? (
          <span className="settings-application__path">{location}</span>
        ) : null}
      </div>
      <button
        className="button button--secondary"
        disabled={props.saving || !props.application.canOpenWorkspace || props.selected}
        type="button"
        onClick={() => {
          void props.onPreferredApplicationChange(
            props.application.kind,
            props.application.id,
          );
        }}
      >
        {props.selected ? "Selected" : "Use"}
      </button>
    </div>
  );
}

function ApplicationIcon(props: {
  application: DesktopApplicationDiscoveryCandidate;
}) {
  if (props.application.iconDataUrl) {
    return (
      <img
        alt=""
        className="settings-application__icon"
        src={props.application.iconDataUrl}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="settings-application__icon settings-application__icon--fallback"
    >
      {props.application.name.slice(0, 1)}
    </span>
  );
}
