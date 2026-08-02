import type {
  DesktopApplicationDiscoveryCandidate,
  DesktopApplicationKind,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import { AppIcon } from "../../components/AppIcon";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import {
  SettingsPathRow,
  type SettingsPathRowChip,
} from "./SettingsPathRow";

export function ApplicationsSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onPreferredApplicationChange: (
    kind: DesktopApplicationKind,
    preferredId: string,
  ) => Promise<void>;
}) {
  return (
    <SettingsSectionStack paneId="applications" aria-label="Application settings">
      <SettingsPanelHead
        eyebrow="Applications"
        title="Editor & terminal"
        help="Choose which apps PwrAgent opens when you click the editor or terminal launcher below the composer. Detected apps are listed below; pick the default for each role."
      />

      <ApplicationSection
        applications={props.snapshot.applications.editors}
        emptyLabel="No editors found."
        eyebrow="Applications"
        preferredId={props.snapshot.applications.preferredEditorId.value}
        saving={props.saving}
        title="Editor"
        onPreferredApplicationChange={props.onPreferredApplicationChange}
      />
      <ApplicationSection
        applications={props.snapshot.applications.terminals}
        emptyLabel="No terminals found."
        eyebrow="Applications"
        preferredId={props.snapshot.applications.preferredTerminalId.value}
        saving={props.saving}
        title="Terminal"
        onPreferredApplicationChange={props.onPreferredApplicationChange}
      />
    </SettingsSectionStack>
  );
}

function ApplicationSection(props: {
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
    <SettingsSection eyebrow={props.eyebrow} title={props.title}>
      <div className="settings-paths">
        {props.applications.length === 0 ? (
          <p className="settings-empty">{props.emptyLabel}</p>
        ) : (
          props.applications.map((application) => (
            <ApplicationPathRow
              key={`${application.kind}:${application.id}`}
              application={application}
              selected={application.id === selectedId}
              saving={props.saving}
              onPreferredApplicationChange={props.onPreferredApplicationChange}
            />
          ))
        )}
      </div>
    </SettingsSection>
  );
}

function ApplicationPathRow(props: {
  application: DesktopApplicationDiscoveryCandidate;
  saving: boolean;
  selected: boolean;
  onPreferredApplicationChange: (
    kind: DesktopApplicationKind,
    preferredId: string,
  ) => Promise<void>;
}) {
  const application = props.application;
  const location = application.appPath ?? application.executablePath;
  const chips: SettingsPathRowChip[] = [
    { label: application.source, tone: "muted" },
  ];
  if (application.canOpenWorkspace) {
    chips.push({ label: "openable", tone: "muted" });
  }

  return (
    <SettingsPathRow
      icon={<ApplicationIcon application={application} />}
      title={application.name}
      path={location ?? undefined}
      chips={chips}
      selected={props.selected}
      disabled={props.saving || !application.canOpenWorkspace}
      onUse={() => {
        void props.onPreferredApplicationChange(
          application.kind,
          application.id,
        );
      }}
    />
  );
}

function ApplicationIcon(props: {
  application: DesktopApplicationDiscoveryCandidate;
}) {
  return <AppIcon application={props.application} size={16} />;
}
