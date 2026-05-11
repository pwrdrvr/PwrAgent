import { useCallback, useEffect, useState } from "react";
import type {
  DesktopApplicationDiscoveryCandidate,
  DesktopApplicationKind,
  DesktopGitDiscoveryCandidate,
  DesktopGhDiscoveryCandidate,
  DesktopSettingsSnapshot,
  GhStatus,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { copyText } from "../../lib/copy-text";
import {
  SettingsField,
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
  onRefresh: () => Promise<void>;
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
      <GitStatusPanel
        desktopApi={props.desktopApi}
        saving={props.saving}
        snapshot={props.snapshot}
        onRefresh={props.onRefresh}
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

const XCODE_LICENSE_REMEDIATION_COMMAND = "sudo xcodebuild -license";

function GitStatusPanel(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onRefresh: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const discovery = props.snapshot.applications.git.discovery;
  const selected = discovery.candidates.find((candidate) => candidate.selected);
  const hasWorkingGit = discovery.candidates.some((candidate) => candidate.executable);
  const visibleCandidates = discovery.candidates.filter(
    (candidate) =>
      candidate.executable || isXcodeLicenseCandidate(candidate) || !hasWorkingGit,
  );
  const xcodeLicenseCandidate = discovery.candidates.find((candidate) =>
    isXcodeLicenseCandidate(candidate)
  );
  const pill = describeGitStatusPill(discovery, xcodeLicenseCandidate);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      await props.onRefresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <SettingsSection
      eyebrow="Applications"
      title="Git"
      description={
        <>
          PwrAgent uses <code>git</code> to inspect repositories and create
          worktrees for new threads.
        </>
      }
    >
      <div className="settings-fields">
        <SettingsField
          label="Command status"
          sub="Checks the git command PwrAgent will use for repository and worktree operations."
          source={selected?.source ?? "auto"}
          control={
            <div className="settings-gh-status">
              <span className={`settings-pill settings-pill--${pill.tone}`}>
                {pill.label}
              </span>
              {selected?.command ? (
                <span className="settings-pathrow__path">
                  Path: <code>{selected.command}</code>
                </span>
              ) : null}
              {selected?.version ? (
                <span className="settings-pathrow__path">
                  Version: <code>{selected.version}</code>
                </span>
              ) : null}
              {xcodeLicenseCandidate ? (
                <div className="settings-gh-status">
                  <span className="settings-pathrow__path settings-error">
                    Apple&apos;s Git at <code>{xcodeLicenseCandidate.command}</code>{" "}
                    is blocked by the Xcode license check.
                  </span>
                  <span className="settings-pathrow__path">
                    Run this in Terminal, then follow the prompts:
                  </span>
                  <span className="settings-pathrow__path">
                    <code>{XCODE_LICENSE_REMEDIATION_COMMAND}</code>
                  </span>
                  <div className="settings-inline-actions">
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={() =>
                        void copyText(
                          XCODE_LICENSE_REMEDIATION_COMMAND,
                          props.desktopApi,
                        )
                      }
                    >
                      Copy command
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="settings-inline-actions">
                <button
                  className="button button--secondary"
                  disabled={loading || props.saving}
                  type="button"
                  onClick={() => void refresh()}
                >
                  {loading ? "Checking…" : "Re-check"}
                </button>
              </div>
            </div>
          }
        />
        <SettingsField
          label="Available paths"
          sub={
            hasWorkingGit
              ? "Detected on this machine. The selected path is used."
              : "No working git executable was found. These are the paths PwrAgent checked."
          }
          control={
            <div className="settings-paths" aria-label="Git discovery">
              {visibleCandidates.length === 0 ? (
                <p className="settings-empty">No git candidates found.</p>
              ) : (
                visibleCandidates.map((candidate) => (
                  <GitCandidateRow
                    key={`${candidate.source}:${candidate.command}`}
                    candidate={candidate}
                  />
                ))
              )}
            </div>
          }
        />
      </div>
    </SettingsSection>
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
  const sourceLabel = gh.path.source === "default" ? "auto" : gh.path.source;
  const saveGhPath = async (path: string): Promise<void> => {
    await props.onSaveGhPath(path);
    await load(true);
  };

  return (
    <SettingsSection
      eyebrow="Applications"
      title="GitHub CLI (gh)"
      description={
        <>
          PwrAgent uses <code>gh</code> to read pull request status for thread chips.
          It never opens, comments on, or merges PRs.
        </>
      }
    >
      <div className="settings-fields">
        <SettingsField
          label="Connection status"
          sub="Checks the selected gh path and GitHub auth scopes."
          source={sourceLabel}
          control={
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
              <div className="settings-inline-actions">
                <button
                  className="button button--secondary"
                  disabled={loading || !desktopApi?.getGhStatus}
                  type="button"
                  onClick={() => void load(true)}
                >
                  {loading ? "Checking…" : "Re-check"}
                </button>
              </div>
            </div>
          }
        />
        {gh.path.value.trim() || envForced ? (
          <SettingsField
            label="Discovery mode"
            sub="Clear the override and use the first discovered gh candidate."
            source={envForced ? "env override active" : "config"}
            control={
              <SettingsPathRow
                title="Auto discovery"
                chips={[{ label: "default", tone: "muted" }]}
                selected={false}
                disabled={props.saving || envForced}
                useLabel="Auto"
                onUse={() => void saveGhPath("")}
              />
            }
          />
        ) : null}
        <SettingsField
          label="Available paths"
          sub={
            candidates.some((candidate) => candidate.executable)
              ? "Detected on this machine. The selected path is used."
              : "No executable gh was found. These are the paths PwrAgent checked."
          }
          control={
            <div className="settings-paths" aria-label="GitHub CLI discovery">
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
          }
        />
        <SettingsField
          label="Manual path"
          sub="Pick a gh executable outside the discovered locations."
          control={
            <div className="settings-inline-actions">
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
          }
        />
      </div>
    </SettingsSection>
  );
}

function GitCandidateRow(props: {
  candidate: DesktopGitDiscoveryCandidate;
}) {
  const candidate = props.candidate;
  const failureLabel = describeCommandDiscoveryFailure(candidate.failureReason);
  const chips: SettingsPathRowChip[] = [
    { label: describeGitCandidateSource(candidate.source), tone: "muted" },
  ];
  if (candidate.executable) {
    chips.push({
      label: candidate.version ?? "version unknown",
      tone: candidate.version ? "muted" : "err",
    });
  } else {
    chips.push({
      label: failureLabel ?? "Unavailable",
      tone: isXcodeLicenseCandidate(candidate) ? "warn" : "err",
    });
  }

  return (
    <SettingsPathRow
      title={candidate.command}
      chips={chips}
      selected={candidate.selected}
      disabled
    />
  );
}

function GhCandidateRow(props: {
  candidate: DesktopGhDiscoveryCandidate;
  disabled?: boolean;
  onUse: (command: string) => void;
}) {
  const candidate = props.candidate;
  const unavailableLabel = describeCommandDiscoveryFailure(candidate.failureReason);
  const chips: SettingsPathRowChip[] = [
    { label: candidate.source, tone: "muted" },
  ];
  if (candidate.executable) {
    chips.push({
      label:
        candidate.version
        ?? describeCommandDiscoveryFailure(candidate.versionFailureReason)
        ?? "version unknown",
      tone: candidate.version ? "muted" : "err",
    });
  } else {
    chips.push({
      label: unavailableLabel ?? "Unavailable",
      tone: "err",
    });
  }
  if (candidate.executable && !candidate.selected) {
    chips.push({
      label: "Available",
      tone: "muted",
    });
  }

  return (
    <SettingsPathRow
      title={candidate.command}
      chips={chips}
      selected={candidate.selected}
      disabled={props.disabled || !candidate.executable}
      onUse={candidate.executable ? () => props.onUse(candidate.command) : undefined}
    />
  );
}

function describeGitStatusPill(
  discovery: DesktopSettingsSnapshot["applications"]["git"]["discovery"],
  xcodeLicenseCandidate?: DesktopGitDiscoveryCandidate,
): {
  tone: "ok" | "warn" | "bad" | "neutral";
  label: string;
} {
  if (discovery.selectedCommand) {
    return xcodeLicenseCandidate
      ? { tone: "warn", label: "Available" }
      : { tone: "ok", label: "Available" };
  }
  if (xcodeLicenseCandidate) {
    return { tone: "bad", label: "Xcode license required" };
  }
  return { tone: "bad", label: "Not available" };
}

function describeGitCandidateSource(
  source: DesktopGitDiscoveryCandidate["source"],
): string {
  if (source === "xcode") return "Apple Git";
  if (source === "homebrew") return "Homebrew";
  if (source === "env") return "env";
  if (source === "path") return "PATH";
  return source;
}

function describeCommandDiscoveryFailure(reason?: string): string | undefined {
  if (!reason) return undefined;
  if (reason === "not_found") return "Missing";
  if (reason === "not_executable") return "Not executable";
  if (reason === "version_not_reported") return "Version unknown";
  if (isXcodeLicenseFailure(reason)) return "Xcode license";
  return reason;
}

function isXcodeLicenseCandidate(
  candidate: DesktopGitDiscoveryCandidate,
): boolean {
  return candidate.command === "/usr/bin/git"
    && isXcodeLicenseFailure(candidate.failureReason ?? candidate.versionFailureReason);
}

function isXcodeLicenseFailure(reason?: string): boolean {
  return Boolean(
    reason?.includes("Xcode license")
      || reason?.includes("license agreements")
      || reason?.includes("xcodebuild -license"),
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
