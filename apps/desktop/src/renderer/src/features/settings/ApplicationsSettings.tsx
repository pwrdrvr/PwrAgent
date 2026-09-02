import type {
  DesktopApplicationDiscoveryCandidate,
  DesktopApplicationKind,
  DesktopCodeSignature,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import { AppIcon } from "../../components/AppIcon";
import type { DesktopApi } from "../../lib/desktop-api";
import { GhToolSection, GitToolSection } from "./CommandToolsSettings";
import { codeSignatureChip } from "./code-signature-chip";
import { useCodeSignatures } from "./useCodeSignatures";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import {
  SettingsPathRow,
  type SettingsPathRowChip,
} from "./SettingsPathRow";

/**
 * Every program PwrAgent runs but does not ship: the editor and terminal it
 * launches, and the two command line tools it shells out to.
 *
 * The two CLI sections are the same components the Git pane renders, over
 * the same config keys — see `CommandToolsSettings`. They live here as
 * well because this is the pane an operator opens to answer "which
 * programs do you run, from where, at what version", and answering that
 * for the editor and the terminal but not for `git` and `gh` left the
 * question half-answered.
 */
export function ApplicationsSettings(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onPreferredApplicationChange: (
    kind: DesktopApplicationKind,
    preferredId: string,
  ) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSaveGhPath: (path: string) => Promise<void>;
  onSaveGitPath: (path: string) => Promise<void>;
}) {
  return (
    <SettingsSectionStack paneId="applications" aria-label="Application settings">
      <SettingsPanelHead
        eyebrow="Applications"
        title="External programs"
        help="The programs PwrAgent runs but does not ship. Detected copies are listed below; pick the one each role should use."
      />

      <ApplicationSection
        applications={props.snapshot.applications.editors}
        desktopApi={props.desktopApi}
        emptyLabel="No editors found."
        eyebrow="Applications"
        preferredId={props.snapshot.applications.preferredEditorId.value}
        saving={props.saving}
        sub="Opened by the editor launcher below the composer."
        title="Editor"
        onPreferredApplicationChange={props.onPreferredApplicationChange}
      />
      <ApplicationSection
        applications={props.snapshot.applications.terminals}
        desktopApi={props.desktopApi}
        emptyLabel="No terminals found."
        eyebrow="Applications"
        preferredId={props.snapshot.applications.preferredTerminalId.value}
        saving={props.saving}
        sub="Opened by the terminal launcher below the composer."
        title="Terminal"
        onPreferredApplicationChange={props.onPreferredApplicationChange}
      />
      <GitToolSection
        desktopApi={props.desktopApi}
        saving={props.saving}
        snapshot={props.snapshot}
        onRefresh={props.onRefresh}
        onSaveGitPath={props.onSaveGitPath}
      />
      <GhToolSection
        desktopApi={props.desktopApi}
        saving={props.saving}
        snapshot={props.snapshot}
        onSaveGhPath={props.onSaveGhPath}
      />
    </SettingsSectionStack>
  );
}

function ApplicationSection(props: {
  applications: DesktopApplicationDiscoveryCandidate[];
  desktopApi?: DesktopApi;
  emptyLabel: string;
  eyebrow: string;
  preferredId: string;
  saving: boolean;
  sub: string;
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
  const signatures = useCodeSignatures(
    props.desktopApi,
    props.applications.map(
      (application) => application.appPath ?? application.executablePath,
    ),
  );

  return (
    <SettingsSection
      description={props.sub}
      eyebrow={props.eyebrow}
      title={props.title}
    >
      <div className="settings-paths" aria-label={props.title} role="group">
        {props.applications.length === 0 ? (
          <p className="settings-empty">{props.emptyLabel}</p>
        ) : (
          props.applications.map((application) => (
            <ApplicationPathRow
              key={`${application.kind}:${application.id}`}
              application={application}
              selected={application.id === selectedId}
              saving={props.saving}
              signature={signatures.get(
                application.appPath ?? application.executablePath ?? "",
              )}
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
  signature?: DesktopCodeSignature;
  onPreferredApplicationChange: (
    kind: DesktopApplicationKind,
    preferredId: string,
  ) => Promise<void>;
}) {
  const application = props.application;
  const location = application.appPath ?? application.executablePath;
  const chips: SettingsPathRowChip[] = [];
  const signatureChip = codeSignatureChip(props.signature);
  if (signatureChip) {
    chips.push(signatureChip);
  }
  // "openable" only ever needed saying when it was false. Saying so on
  // every row that can be picked spent a chip slot on a non-fact.
  if (!application.canOpenWorkspace) {
    chips.push({ key: "state", label: "Cannot open a folder", tone: "warn" });
  }

  return (
    <SettingsPathRow
      icon={<ApplicationIcon application={application} />}
      title={application.name}
      path={location ?? undefined}
      chips={chips}
      selected={props.selected}
      selectedLabel="In use"
      selectLabel={`Use ${application.name}${location ? ` at ${location}` : ""}`}
      disabled={props.saving || !application.canOpenWorkspace}
      onSelect={() => {
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
