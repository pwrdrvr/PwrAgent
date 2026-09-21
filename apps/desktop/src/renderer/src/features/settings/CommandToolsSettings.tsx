import { FORGE_PRODUCTS, type ForgeKind, type ForgeCli } from "@pwragent/shared";
import { FORGE_SETTINGS } from "./forge-settings";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DesktopCodeSignature,
  DesktopGhDiscoveryCandidate,
  DesktopSettingsSnapshot,
  GhStatus,
} from "@pwragent/shared";
import { isValidatedDiscoveryCandidate } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { GitHubIcon, GitLabIcon } from "../../icons";
import { SettingsCopyValue } from "./SettingsCopyValue";
import {
  SettingsField,
  SettingsSection,
  type SettingsChipTone,
  ToggleField,
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

/** Every configured CLI must have a deliberate brand mark. */
const FORGE_CLI_ICONS = { gh: GitHubIcon, glab: GitLabIcon } satisfies Record<ForgeCli, typeof GitHubIcon>;

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
export function GitToolSection(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onRefresh: () => Promise<void>;
  onSaveGitPath: (path: string) => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const candidate = props.snapshot.applications.git.discovery.candidates.find((item) => item.selected);
  const refresh = async () => {
    setLoading(true);
    setError(undefined);
    try {
      await props.desktopApi?.refreshGitDiscovery?.();
      await props.onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };
  return (
    <SettingsSection eyebrow="Git" sectionId="git" title="Git"
      description="PwrAgent uses the Git and Git LFS included with the application for repository and worktree operations.">
      <SettingsField label="Bundled runtime" source="bundled"
        sub="Installed Git versions and legacy custom paths do not change this runtime."
        error={error ?? candidate?.failureReason}
        control={
          <div className="settings-gh-status">
            <span className={`settings-pill settings-pill--${candidate?.executable ? "ok" : "err"}`}>
              {candidate?.executable ? "In use" : "Unavailable"}
            </span>
            {candidate?.version ? <span>Git <code>{candidate.version}</code></span> : null}
            {candidate?.lfsVersion ? <span>Git LFS <code>{candidate.lfsVersion}</code></span> : null}
            {candidate?.command ? <span className="settings-pathrow__path"><code>{candidate.command}</code></span> : null}
            <button className="button button--secondary" type="button" disabled={loading || props.saving}
              onClick={() => void refresh()}>{loading ? "Checking…" : "Re-check"}</button>
          </div>
        }
      />
    </SettingsSection>
  );
}

export function GhToolSection(props: {
  desktopApi?: DesktopApi;
  provider?: ForgeKind;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  /** GitLab only: persist the host the connection check probes. */
  onSaveHost?: (host: string) => Promise<void>;
  onSaveEnabled: (enabled: boolean) => Promise<void>;
  onSaveGhPath: (path: string) => Promise<void>;
  /** Publishes this section's status so the settings nav can show the same
   *  state without probing a second time. */
  onStatusChange?: (status: GhStatus | undefined) => void;
}) {
  const provider = props.provider ?? "github";
  const product = FORGE_PRODUCTS[provider];
  const settings = FORGE_SETTINGS[provider];
  const { cli, label, changeRequest: request, configurableHost } = product;
  const desktopApi = props.desktopApi;
  // The host has to come from config, not component state. It is only ever
  // touched by self-managed operators, and an unpersisted field sent them
  // back to gitlab.com — a host they may have no account on — on every
  // remount, which then reported a red "Not signed in" for the wrong server.
  // GitLab only. Reading this for the GitHub instance too put glab's host in
  // `load`'s dependency list for both, so editing the GitLab host re-probed
  // GitHub and flashed its pill back to "Checking…".
  const application = props.snapshot.applications[cli];
  const hostSetting = application && "host" in application ? application.host : undefined;
  const configuredHost = configurableHost
    ? hostSetting?.value.trim() || product.saasHost
    : product.saasHost;
  const [host, setHost] = useState(configuredHost);
  useEffect(() => {
    setHost(configuredHost);
  }, [configuredHost]);
  const onStatusChangeRef = useRef(props.onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = props.onStatusChange;
  });
  const getStatus = desktopApi?.[settings.statusMethod];
  const pickCommand = desktopApi?.[settings.pickMethod];
  const [status, setStatus] = useState<GhStatus | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const gh = application
    ?? {
      enabled: { value: false, source: "default" as const },
      path: { value: "", source: "default" as const },
      discovery: { candidates: [] },
    };
  const envForced = gh.path.source === "env";
  const enabled = gh.enabled.value;
  const discovery = status?.discovery ?? gh.discovery;
  const candidates = discovery.candidates;
  const installCommand = desktopApi?.platform === "darwin"
    ? product.install?.darwin
    : desktopApi?.platform === "win32"
      ? product.install?.win32
      : undefined;

  const load = useCallback(
    async (recheck: boolean) => {
      if (!enabled) {
        setStatus(undefined);
        onStatusChangeRef.current?.(undefined);
        return;
      }
      if (!getStatus) return;
      setLoading(true);
      setError(undefined);
      // Drop the previous host's verdict before probing a new one. Holding
      // it would show "Connected" under a host that has not been checked.
      setStatus(undefined);
      onStatusChangeRef.current?.(undefined);
      try {
        const next = await getStatus({ recheck, ...(configurableHost ? { host } : {}) });
        setStatus(next);
        onStatusChangeRef.current?.(next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    },
    [enabled, getStatus, host, configurableHost],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const pill = describeGhStatusPill(status, enabled);
  const signatures = useCodeSignatures(
    desktopApi,
    candidates.map((candidate) => candidate.command),
  );
  const selected = discovery.candidates.find((candidate) => candidate.selected);
  const resolvedCommand = selected?.command ?? discovery.selectedCommand;
  const signInExecutable = resolvedCommand ?? cli;
  const signInCommand = [
    // PowerShell needs the call operator only for a quoted path.
    desktopApi?.platform === "win32" && needsTerminalQuoting(signInExecutable)
      ? "&"
      : undefined,
    quoteTerminalArgument(signInExecutable, desktopApi?.platform),
    "auth",
    "login",
    // `gh auth login` defaults to github.com and prompts for anything else;
    // glab has no default, so its host is always explicit.
    ...(configurableHost
      ? ["--hostname", quoteTerminalArgument(host, desktopApi?.platform)]
      : []),
  ].filter((part) => part !== undefined).join(" ");
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
      sectionId={provider}
      chip={enabled ? "On" : "Off"}
      chipKind={enabled ? settingsChipToneForPill(pill.tone) : "default"}
      title={`${label} CLI (${cli})`}
      description={
        <>
          PwrAgent uses <code>{cli}</code> to read {request} status for thread
          chips. It never opens, comments on, or merges one.
        </>
      }
    >
      <div className="settings-fields">
        <ToggleField
          checked={enabled}
          disabled={props.saving}
          label={`Read ${request} status from ${label}`}
          sub={
            gh.enabled.source === "default"
              ? `On by default because ${cli} was found on this machine. Turn it off to stop every ${label} check, including the one below.`
              : `Turn this off to stop every ${label} check, including the one below.`
          }
          source={gh.enabled.source === "default" ? "auto" : gh.enabled.source}
          onChange={(next) => props.onSaveEnabled(next)}
        />
        {configurableHost ? (
          <SettingsField
            label={`${label} host`}
            sub="The host this check probes. Merge request status follows each thread's own remote."
            source={
              hostSetting?.source === "env"
                ? "env override active"
                : undefined
            }
            control={
              <input
                className="settings-input"
                aria-label={`${label} host`}
                key={configuredHost}
                defaultValue={configuredHost}
                placeholder={product.saasHost}
                spellCheck={false}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                onBlur={(event) => {
                  const next = event.currentTarget.value.trim().toLowerCase();
                  if (next === configuredHost) return;
                  setHost(next || product.saasHost);
                  void props.onSaveHost?.(next);
                }}
              />
            }
          />
        ) : null}
        <SettingsField
          label="Connection status"
          sub={`Checks the selected ${cli} path, login, and read permissions.`}
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
                <span className="settings-pathrow__path settings-gh-status__reason">
                  {status.reason}
                </span>
              ) : null}
              {error ? (
                <span className="settings-pathrow__path settings-error">{error}</span>
              ) : null}
              {enabled ? (
                <div className="settings-inline-actions">
                  <button
                    className="button button--secondary"
                    disabled={loading || !getStatus}
                    type="button"
                    onClick={() => void load(true)}
                  >
                    {loading ? "Checking…" : "Re-check"}
                  </button>
                </div>
              ) : null}
            </div>
          }
        />
        {status?.installed && !status.loggedIn ? (
          <SettingsField
            label={`Sign in to ${label}`}
            sub={`Run in ${terminalName(desktopApi?.platform)}, follow the sign-in prompts, then click Re-check.`}
            control={
              <div className="settings-gh-status">
                <SettingsCopyValue
                  value={signInCommand}
                  desktopApi={desktopApi}
                  label={`${label} sign-in command`}
                />
                <div className="settings-inline-actions">
                  <a
                    className="button button--secondary"
                    href={product.signInGuide}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open sign-in guide
                  </a>
                </div>
              </div>
            }
          />
        ) : null}
        {product.install && status && !status.installed ? (
          <SettingsField
            label={`Install ${label} CLI`}
            sub={installCommand
              ? `Run in ${desktopApi?.platform === "darwin" ? "Terminal with Homebrew installed" : "PowerShell with WinGet installed"}, then click Re-check.`
              : "Choose the installation method for your system, then click Re-check."}
            control={
              <div className="settings-gh-status">
                {installCommand ? (
                  <SettingsCopyValue
                    value={installCommand}
                    desktopApi={desktopApi}
                    label={`${label} CLI install command`}
                  />
                ) : null}
                <div className="settings-inline-actions">
                  <a
                    className="button button--secondary"
                    href={product.install.guide}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open install guide
                  </a>
                </div>
              </div>
            }
          />
        ) : null}
        {gh.path.value.trim() || envForced ? (
          <SettingsField
            label="Discovery mode"
            sub={`Clear the override and use the first discovered ${cli} candidate.`}
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
              : `No executable ${cli} was found. These are the paths PwrAgent checked.`
          }
          control={
            <div
              className="settings-paths"
              aria-label={`${label} CLI discovery`}
              role="group"
            >
              {candidates.length === 0 ? (
                <p className="settings-empty">No {cli} candidates found.</p>
              ) : (
                candidates.map((candidate) => (
                  <GhCandidateRow
                    cli={cli}
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
          sub={`Pick a ${cli} executable outside the discovered locations.`}
          control={
            <div className="settings-inline-actions">
              <button
                className="button button--secondary"
                disabled={props.saving || envForced || !pickCommand}
                type="button"
                onClick={() => {
                  void (async () => {
                    if (!pickCommand) return;
                    setError(undefined);
                    const result = await pickCommand();
                    if (result.canceled) return;
                    if (result.error || !result.path) {
                      setError(result.error ?? `No ${cli} path was selected.`);
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

/** One gh candidate. Same grammar as the git row — see `GitCandidateRow`. */
function GhCandidateRow(props: {
  cli?: ForgeCli;
  candidate: DesktopGhDiscoveryCandidate;
  disabled?: boolean;
  signature?: DesktopCodeSignature;
  onSelect: (command: string) => void;
}) {
  const candidate = props.candidate;
  const ForgeIcon = FORGE_CLI_ICONS[props.cli ?? "gh"];
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
      icon={<ForgeIcon size={18} />}
      title={source}
      meta={usable ? candidate.version : undefined}
      path={detail ?? candidate.command}
      pathIsDetail={Boolean(detail)}
      chips={chips}
      selected={candidate.selected}
      selectedLabel="In use"
      selectLabel={`Use ${source} ${props.cli ?? "gh"} at ${candidate.command}`}
      disabled={props.disabled || !usable}
      onSelect={usable ? () => props.onSelect(candidate.command) : undefined}
    />
  );
}

/**
 * Shell-safe rendering of one argument.
 *
 * Paths and hosts are operator input, so anything outside this allowlist is
 * quoted. Everything inside it is left bare on purpose: a displayed command
 * is only useful if the operator trusts it enough to paste, and
 * `'glab' auth login --hostname 'gitlab.com'` reads like something already
 * went wrong. PowerShell escapes an apostrophe by doubling it; POSIX shells
 * close the string, emit an escaped quote, and reopen.
 */
function quoteTerminalArgument(value: string, platform?: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return "'" + (platform === "win32"
    ? value.replaceAll("'", "''")
    : value.replaceAll("'", "'\"'\"'")) + "'";
}

/** What to call the place the operator pastes the command, per platform. */
function terminalName(platform?: string): string {
  if (platform === "win32") return "PowerShell";
  if (platform === "darwin") return "Terminal";
  return "a terminal";
}

/** True when `quoteTerminalArgument` would wrap this value. */
function needsTerminalQuoting(value: string): boolean {
  return !/^[A-Za-z0-9_@%+=:,./-]+$/.test(value);
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

function describeXcodeLicenseFailure(reason: string): string | undefined {
  return isXcodeLicenseFailure(reason) ? "Xcode license" : undefined;
}

function describeCommandDiscoveryFailure(reason?: string): string | undefined {
  return describeSharedCommandDiscoveryFailure(reason, describeXcodeLicenseFailure);
}

function commandDiscoveryFailureDetail(reason?: string): string | undefined {
  return sharedCommandDiscoveryFailureDetail(reason, describeXcodeLicenseFailure);
}

function isXcodeLicenseFailure(reason?: string): boolean {
  return Boolean(
    reason?.includes("Xcode license")
      || reason?.includes("license agreements")
      || reason?.includes("xcodebuild -license"),
  );
}

/** The pill vocabulary is wider than the section chip's; map, don't cast. */
function settingsChipToneForPill(
  tone: "ok" | "warn" | "bad" | "neutral",
): SettingsChipTone {
  if (tone === "bad") return "err";
  if (tone === "neutral") return "muted";
  return tone;
}

export function describeGhStatusPill(
  status: GhStatus | undefined,
  enabled: boolean,
): {
  tone: "ok" | "warn" | "bad" | "neutral";
  label: string;
} {
  // Off is a resting state the operator chose, not a fault: it must never
  // borrow the tone that means "this is broken".
  if (!enabled) return { tone: "neutral", label: "Disabled" };
  if (!status) return { tone: "neutral", label: "Checking…" };
  if (!status.installed) return { tone: "bad", label: "Not installed" };
  if (!status.loggedIn) return { tone: "bad", label: "Not signed in" };
  if (status.permissionState === "unknown") return { tone: "warn", label: "Permissions unverified" };
  if (status.permissionState === "limited") return { tone: "warn", label: "Public repositories only" };
  if (!status.hasRepoScope)
    return { tone: "warn", label: "Insufficient permissions" };
  return { tone: "ok", label: "Connected" };
}
