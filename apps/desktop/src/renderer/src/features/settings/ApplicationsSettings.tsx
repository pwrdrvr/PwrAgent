import { useCallback, useEffect, useState } from "react";
import type {
  DesktopApplicationDiscoveryCandidate,
  DesktopApplicationKind,
  DesktopGhDiscoveryCandidate,
  DesktopSettingsSnapshot,
  GhStatus,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
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
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onPreferredApplicationChange: (
    kind: DesktopApplicationKind,
    preferredId: string,
  ) => Promise<void>;
  onSaveGhPath: (path: string) => Promise<void>;
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
      <GhStatusPanel
        desktopApi={props.desktopApi}
        saving={props.saving}
        snapshot={props.snapshot}
        onSaveGhPath={props.onSaveGhPath}
      />
    </SettingsSectionStack>
  );
}

function GhStatusPanel(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onSaveGhPath: (path: string) => Promise<void>;
}) {
  const desktopApi = props.desktopApi;
  const [status, setStatus] = useState<GhStatus | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const gh = props.snapshot.applications.gh;
  const envForced = gh.path.source === "env";
  const discovery = status?.discovery ?? gh.discovery;
  const candidates = discovery.candidates;

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
  const selected = discovery.candidates.find((candidate) => candidate.selected);
  const resolvedCommand = selected?.command ?? discovery.selectedCommand;
  const resolvedVersion = selected?.version;
  const saveGhPath = async (path: string): Promise<void> => {
    await props.onSaveGhPath(path);
    await load(true);
  };

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
        {resolvedCommand ? (
          <span className="settings-pathrow__path">
            Path: <code>{resolvedCommand}</code>
          </span>
        ) : null}
        {resolvedVersion ? (
          <span className="settings-pathrow__path">
            Version: <code>{resolvedVersion}</code>
          </span>
        ) : null}
        {status?.account ? (
          <span className="settings-pathrow__path">
            Signed in as <strong>{status.account}</strong>
          </span>
        ) : null}
        {status && status.installed && status.scopes.length > 0 ? (
          <span className="settings-pathrow__path">
            Scopes: {status.scopes.join(", ")}
          </span>
        ) : null}
        {status?.reason ? (
          <span className="settings-pathrow__path">{status.reason}</span>
        ) : null}
        {error ? (
          <span className="settings-pathrow__path settings-error">{error}</span>
        ) : null}
      </div>
      <div className="settings-paths" aria-label="GitHub CLI discovery">
        {gh.path.value.trim() || envForced ? (
          <SettingsPathRow
            title="Auto discovery"
            path="Clear the override and use the first discovered gh candidate."
            chips={[{ label: envForced ? "env override active" : "default", tone: "muted" }]}
            selected={false}
            disabled={props.saving || envForced}
            useLabel="Auto"
            onUse={() => void saveGhPath("")}
          />
        ) : null}
        {candidates.length === 0 ? (
          <p className="settings-empty">No gh candidates found.</p>
        ) : (
          candidates.map((candidate) => (
            <GhCandidateRow
              key={`${candidate.source}:${candidate.command}`}
              candidate={candidate}
              disabled={props.saving || envForced}
              onUse={(command) => void saveGhPath(command)}
            />
          ))
        )}
      </div>
      <div className="settings-secret">
        <button
          className="button button--secondary"
          disabled={props.saving || envForced || !desktopApi?.pickGhCommand}
          type="button"
          onClick={() => {
            void (async () => {
              if (!desktopApi?.pickGhCommand) return;
              setError(undefined);
              const result = await desktopApi.pickGhCommand();
              if (result.canceled) return;
              if (result.error || !result.path) {
                setError(result.error ?? "No gh path was selected.");
                return;
              }
              await saveGhPath(result.path);
            })();
          }}
        >
          Choose…
        </button>
      </div>
    </section>
  );
}

function GhCandidateRow(props: {
  candidate: DesktopGhDiscoveryCandidate;
  disabled?: boolean;
  onUse: (command: string) => void;
}) {
  const candidate = props.candidate;
  const version =
    candidate.version
    ?? candidate.versionFailureReason
    ?? candidate.failureReason
    ?? "version unknown";
  const chips: SettingsPathRowChip[] = [
    { label: candidate.source, tone: "muted" },
    {
      label: version,
      tone: candidate.executable && candidate.version ? "muted" : "err",
    },
  ];
  if (!candidate.selected) {
    chips.push({
      label: candidate.executable ? "Available" : "Unavailable",
      tone: candidate.executable ? "muted" : "err",
    });
  }

  return (
    <SettingsPathRow
      title={candidate.command}
      chips={chips}
      selected={candidate.selected}
      selectedLabel="Using"
      disabled={props.disabled || !candidate.executable}
      onUse={() => props.onUse(candidate.command)}
    />
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
  if (props.application.iconDataUrl) {
    return (
      <img
        alt=""
        src={props.application.iconDataUrl}
      />
    );
  }

  return (
    <span aria-hidden="true">
      {props.application.name.slice(0, 1)}
    </span>
  );
}
