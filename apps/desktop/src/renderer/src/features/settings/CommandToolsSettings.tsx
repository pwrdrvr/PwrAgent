import { useCallback, useEffect, useState } from "react";
import type {
  DesktopCodeSignature,
  DesktopGitDiscoveryCandidate,
  DesktopGhDiscoveryCandidate,
  DesktopSettingsSnapshot,
  GhStatus,
} from "@pwragent/shared";
import { isValidatedDiscoveryCandidate } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { copyText } from "../../lib/copy-text";
import { GitHubIcon, GitIcon } from "../../icons";
import {
  SettingsField,
  SettingsSection,
} from "./SettingsLayout";
import {
  SettingsPathRow,
  type SettingsPathRowChip,
} from "./SettingsPathRow";
import { codeSignatureChip } from "./code-signature-chip";
import { useCodeSignatures } from "./useCodeSignatures";
import {
  commandDiscoveryFailureDetail as sharedCommandDiscoveryFailureDetail,
  describeCommandDiscoveryFailure as describeSharedCommandDiscoveryFailure,
} from "./command-discovery-failure";

/**
 * The `git` and `gh` sections of Settings.
 *
 * Rendered by BOTH panes that have a claim on them, from this one module:
 *
 * - **Applications**, because "which programs do you run, from where, and
 *   at what version" is the question that pane answers, and answering it
 *   for the editor and the terminal but not for the two command line
 *   tools left it half-done.
 * - **Git**, because that is where an operator lands from a git or GitHub
 *   failure, and making them leave to repair it would be worse than the
 *   duplication.
 *
 * They are the same live component over the same config keys, so the two
 * panes cannot drift: a selection made on one is already made on the
 * other. That is the whole reason this is a module and not a copy.
 */
const XCODE_LICENSE_REMEDIATION_COMMAND = "sudo xcodebuild -license";

export function GitToolSection(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onRefresh: () => Promise<void>;
  onSaveGitPath: (path: string) => Promise<void>;
}) {
  const desktopApi = props.desktopApi;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const discovery = props.snapshot.applications.git.discovery;
  const gitPath = props.snapshot.applications.git.path;
  const envForced = gitPath.source === "env";
  const selected = discovery.candidates.find((candidate) => candidate.selected);
  const hasWorkingGit = discovery.candidates.some((candidate) => candidate.executable);
  const configuredCommand = gitPath.value.trim();
  const visibleCandidates = discovery.candidates.filter(
    (candidate) =>
      candidate.executable
      || isXcodeLicenseCandidate(candidate)
      // The operator's own choice always stays on screen. Filtering it out
      // with the rest of the broken candidates is how a selection that has
      // stopped working becomes invisible: the pane would show some other
      // git as "In use" with nothing saying a different one is configured,
      // and no row to clear.
      || candidate.command === configuredCommand
      || !hasWorkingGit,
  );
  const xcodeLicenseCandidate = discovery.candidates.find((candidate) =>
    isXcodeLicenseCandidate(candidate)
  );
  const pill = describeGitStatusPill(discovery, xcodeLicenseCandidate);
  // Mirrors the gh field: the pill says how the choice was *made*, not which
  // location won. Where it came from is already the row's title.
  const sourceLabel = gitPath.source === "default" ? "auto" : gitPath.source;
  const signatures = useCodeSignatures(
    desktopApi,
    visibleCandidates.map((candidate) => candidate.command),
  );

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      // The projection refresh alone would re-render the memoized startup
      // probe, so "Re-check" has to ask for a real re-probe.
      if (desktopApi?.refreshGitDiscovery) {
        await desktopApi.refreshGitDiscovery();
      }
      await props.onRefresh();
    } catch (caught) {
      // Every caller reaches this through `void`, so an uncaught rejection
      // here is invisible: the spinner clears, the rows do not change, and
      // the operator is told nothing. Mirrors the gh section's `load`.
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const saveGitPath = async (path: string): Promise<void> => {
    setError(undefined);
    try {
      await props.onSaveGitPath(path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    await refresh();
  };

  return (
    <SettingsSection
      eyebrow="Git"
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
          source={sourceLabel}
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
              ? "Detected on this machine. Pick the one PwrAgent should run."
              : "No working git executable was found. These are the paths PwrAgent checked."
          }
          source={envForced ? "env override active" : undefined}
          error={error}
          control={
            <div
              className="settings-paths"
              aria-label="Git discovery"
              role="group"
            >
              {visibleCandidates.length === 0 ? (
                <p className="settings-empty">No git candidates found.</p>
              ) : (
                visibleCandidates.map((candidate) => (
                  <GitCandidateRow
                    key={`${candidate.source}:${candidate.command}`}
                    candidate={candidate}
                    disabled={props.saving || loading || envForced}
                    signature={signatures.get(candidate.command)}
                    onSelect={(command) => void saveGitPath(command)}
                  />
                ))
              )}
              {envForced ? (
                <p className="settings-empty">
                  PWRAGENT_GIT_PATH is set, so it wins over anything chosen
                  here. Unset it to choose a git in Settings.
                </p>
              ) : null}
            </div>
          }
        />
        {gitPath.value.trim() && !envForced ? (
          <SettingsField
            label="Discovery mode"
            sub="Clear the override and use the first discovered git candidate."
            source="config"
            control={
              <SettingsPathRow
                title="Auto discovery"
                chips={[{ label: "default", tone: "muted" }]}
                selected={false}
                disabled={props.saving || loading}
                useLabel="Auto"
                onUse={() => void saveGitPath("")}
              />
            }
          />
        ) : null}
        <SettingsField
          label="Manual path"
          sub="Pick a git executable outside the discovered locations."
          control={
            <div className="settings-inline-actions">
              <button
                className="button button--secondary"
                disabled={
                  props.saving || envForced || !desktopApi?.pickGitCommand
                }
                type="button"
                onClick={() => {
                  void (async () => {
                    if (!desktopApi?.pickGitCommand) return;
                    setError(undefined);
                    const result = await desktopApi.pickGitCommand();
                    if (result.canceled) return;
                    if (result.error || !result.path) {
                      setError(result.error ?? "No git path was selected.");
                      return;
                    }
                    await saveGitPath(result.path);
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

export function GhToolSection(props: {
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
  const signatures = useCodeSignatures(
    desktopApi,
    candidates.map((candidate) => candidate.command),
  );
  const selected = discovery.candidates.find((candidate) => candidate.selected);
  const resolvedCommand = selected?.command ?? discovery.selectedCommand;
  const resolvedVersion = selected?.version;
  const sourceLabel = gh.path.source === "default" ? "auto" : gh.path.source;
  const saveGhPath = async (path: string): Promise<void> => {
    try {
      await props.onSaveGhPath(path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    await load(true);
  };

  return (
    <SettingsSection
      eyebrow="Git"
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
            <div
              className="settings-paths"
              aria-label="GitHub CLI discovery"
              role="group"
            >
              {candidates.length === 0 ? (
                <p className="settings-empty">No gh candidates found.</p>
              ) : (
                candidates.map((candidate) => (
                  <GhCandidateRow
                    key={`${candidate.source}:${candidate.command}`}
                    candidate={candidate}
                    disabled={props.saving || envForced}
                    signature={signatures.get(candidate.command)}
                    onSelect={(command) => void saveGhPath(command)}
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

/**
 * One git candidate.
 *
 * The title is the **provenance**, not the path. Every row in this list is
 * `git`, so what the operator is actually choosing between is Homebrew and
 * Apple — which the old layout put in a 10-px chip while the 13-px title
 * carried the path that every row nearly duplicates.
 */
function GitCandidateRow(props: {
  candidate: DesktopGitDiscoveryCandidate;
  disabled?: boolean;
  signature?: DesktopCodeSignature;
  onSelect: (command: string) => void;
}) {
  const candidate = props.candidate;
  const failureLabel = describeCommandDiscoveryFailure(candidate.failureReason);
  const source = describeGitCandidateSource(candidate.source);
  const chips: SettingsPathRowChip[] = [];
  const signatureChip = codeSignatureChip(props.signature);
  if (signatureChip) {
    chips.push(signatureChip);
  }
  if (!candidate.executable) {
    chips.push({
      key: "state",
      label: failureLabel ?? "Unavailable",
      tone: isXcodeLicenseCandidate(candidate) ? "warn" : "err",
    });
  }

  const detail = commandDiscoveryFailureDetail(
    candidate.failureReason ?? candidate.versionFailureReason,
  );

  return (
    <SettingsPathRow
      icon={<GitIcon size={18} />}
      title={source}
      meta={candidate.version}
      path={detail ?? candidate.command}
      pathIsDetail={Boolean(detail)}
      chips={chips}
      selected={candidate.selected}
      selectedLabel="In use"
      selectLabel={`Use ${source} git at ${candidate.command}`}
      disabled={props.disabled || !candidate.executable}
      onSelect={
        candidate.executable ? () => props.onSelect(candidate.command) : undefined
      }
    />
  );
}

/** One gh candidate. Same grammar as the git row — see `GitCandidateRow`. */
function GhCandidateRow(props: {
  candidate: DesktopGhDiscoveryCandidate;
  disabled?: boolean;
  signature?: DesktopCodeSignature;
  onSelect: (command: string) => void;
}) {
  const candidate = props.candidate;
  const unavailableLabel = describeCommandDiscoveryFailure(candidate.failureReason);
  // `executable` comes from fs.access(X_OK), which succeeds for any existing
  // file on Windows, so an sh shim scores true. Gate on the same predicate
  // the main process selects with.
  const usable = isValidatedDiscoveryCandidate(candidate);
  const source = describeGhCandidateSource(candidate.source);
  const chips: SettingsPathRowChip[] = [];
  const signatureChip = codeSignatureChip(props.signature);
  if (signatureChip) {
    chips.push(signatureChip);
  }
  if (!usable) {
    // Only a real version belongs in the version slot. Routing a failure
    // label through here produced rows reading "Launch failed" next to
    // "Available"; the reason rides the detail line instead.
    chips.push({
      key: "state",
      label: unavailableLabel ?? "Unavailable",
      tone: "err",
    });
  }

  const detail = commandDiscoveryFailureDetail(
    candidate.failureReason ?? candidate.versionFailureReason,
  );

  return (
    <SettingsPathRow
      icon={<GitHubIcon size={18} />}
      title={source}
      meta={usable ? candidate.version : undefined}
      path={detail ?? candidate.command}
      pathIsDetail={Boolean(detail)}
      chips={chips}
      selected={candidate.selected}
      selectedLabel="In use"
      selectLabel={`Use ${source} gh at ${candidate.command}`}
      disabled={props.disabled || !usable}
      onSelect={usable ? () => props.onSelect(candidate.command) : undefined}
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

function describeGhCandidateSource(
  source: DesktopGhDiscoveryCandidate["source"],
): string {
  if (source === "homebrew") return "Homebrew";
  if (source === "macports") return "MacPorts";
  if (source === "windows") return "Windows install";
  if (source === "user") return "User bin";
  if (source === "config") return "Custom path";
  if (source === "env") return "env";
  if (source === "path") return "PATH";
  return source;
}

function describeGitCandidateSource(
  source: DesktopGitDiscoveryCandidate["source"],
): string {
  if (source === "xcode") return "Apple";
  if (source === "homebrew") return "Homebrew";
  if (source === "user") return "User bin";
  if (source === "config") return "Custom path";
  if (source === "env") return "env";
  if (source === "path") return "PATH";
  return source;
}

function describeXcodeLicenseFailure(reason: string): string | undefined {
  return isXcodeLicenseFailure(reason) ? "Xcode license" : undefined;
}

function describeCommandDiscoveryFailure(reason?: string): string | undefined {
  return describeSharedCommandDiscoveryFailure(reason, describeXcodeLicenseFailure);
}

function commandDiscoveryFailureDetail(reason?: string): string | undefined {
  return sharedCommandDiscoveryFailureDetail(reason, describeXcodeLicenseFailure);
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
