import type {
  DesktopApplicationDiscoveryCandidate,
  DesktopApplicationKind,
  DesktopSettingsSnapshot,
} from "@pwragnt/shared";

export function ApplicationsSettings(props: {
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
    </section>
  );
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
