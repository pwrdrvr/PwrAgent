import type {
  DesktopApplicationDiscoveryCandidate,
  DesktopSettingsSnapshot,
} from "@pwragnt/shared";

export function ApplicationsSettings(props: {
  snapshot: DesktopSettingsSnapshot;
}) {
  return (
    <section className="settings-stack" aria-label="Application settings">
      <ApplicationPanel
        applications={props.snapshot.applications.editors}
        emptyLabel="No editors found."
        eyebrow="Applications"
        title="Editor"
      />
      <ApplicationPanel
        applications={props.snapshot.applications.terminals}
        emptyLabel="No terminals found."
        eyebrow="Applications"
        title="Terminal"
      />
    </section>
  );
}

function ApplicationPanel(props: {
  applications: DesktopApplicationDiscoveryCandidate[];
  emptyLabel: string;
  eyebrow: string;
  title: string;
}) {
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
            <ApplicationRow key={`${application.kind}:${application.id}`} application={application} />
          ))
        )}
      </div>
    </section>
  );
}

function ApplicationRow(props: {
  application: DesktopApplicationDiscoveryCandidate;
}) {
  const location = props.application.appPath ?? props.application.executablePath;

  return (
    <div className="settings-application">
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
