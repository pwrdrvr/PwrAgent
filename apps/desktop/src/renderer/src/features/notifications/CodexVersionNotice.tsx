import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  DesktopCodexVersionAdvisory,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import { OPENAI_CODEX_RELEASES_URL } from "../../lib/codex-release-channel";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppNoticeToastNotice } from "./AppNoticeToast";
import { codexInstallOffer } from "../onboarding/get-started-agents";
import { ManagedRuntimeProgressStrip, useManagedRuntimeProgress } from "../settings/ManagedRuntimeProgress";
import { SettingsSwitch } from "../settings/SettingsSwitch";
import { useOpenAiCodexInstall } from "../settings/useOpenAiCodexInstall";
import type { ManagedRuntimeProgress } from "../../../../shared/managed-runtime-progress";

/**
 * Every durable notice id this producer can emit, as prefixes, for the host to
 * sweep before showing the current one. See `GROK_UPDATE_NOTICE_ID_PREFIXES`.
 */
export const CODEX_VERSION_NOTICE_ID_PREFIXES = ["codex-version:"] as const;

/**
 * Warns at startup when the Codex PwrAgent launches is too old to offer the
 * newest models. It reads the settings snapshot the window already holds, so it
 * adds no probe of its own: discovery has already run the version check.
 */
export function CodexVersionNotice(props: {
  desktopApi?: Pick<
    DesktopApi,
    "copyText" | "onManagedRuntimeProgress" | "readManagedRuntimeProgress" | "refreshCodexDiscovery"
  >;
  snapshot?: DesktopSettingsSnapshot;
  onNoticeChanged: (notice: AppNoticeToastNotice | undefined) => void;
  onOpenCodexSettings: () => void;
  onManagedBuildsChange?: (enabled: boolean) => Promise<boolean>;
  onCheckManagedBuildUpdates?: () => Promise<void>;
  /** Re-read settings and models once OpenAI's Codex is installed. */
  onOpenAiCodexInstalled?: () => Promise<void>;
}) {
  const latestAdvisory = props.snapshot?.models?.codex?.versionAdvisory;
  // Every settings write hands back a new snapshot, so the advisory is a new
  // object each time even when nothing in it changed. Keep the first one for as
  // long as its content holds, or the notice below would rebuild and re-show on
  // every unrelated save.
  const advisoryKey = latestAdvisory ? JSON.stringify(latestAdvisory) : undefined;
  const stableAdvisory = useRef<{
    key: string | undefined;
    value: DesktopCodexVersionAdvisory | undefined;
  }>({ key: undefined, value: undefined });
  if (stableAdvisory.current.key !== advisoryKey) {
    stableAdvisory.current = { key: advisoryKey, value: latestAdvisory };
  }
  const advisory = stableAdvisory.current.value;
  const progress = useManagedRuntimeProgress(props.desktopApi, "codex");
  const openAi = useOpenAiCodexInstall({
    desktopApi: props.desktopApi,
    discoveryIntent: "settings-user-action",
    onInstalled: props.onOpenAiCodexInstalled,
  });
  // Set once this notice asks for the install, so its progress and result
  // stay on screen after the new Codex clears the advisory.
  const [openAiRequested, setOpenAiRequested] = useState(false);
  const [operationAdvisory, setOperationAdvisory] = useState<DesktopCodexVersionAdvisory>();
  const [pendingNext, setPendingNext] = useState<boolean>();
  const [operationError, setOperationError] = useState<string>();
  const [failedOperation, setFailedOperation] = useState<{ next: boolean; check: boolean }>();
  const inFlight = useRef(false);
  const managedRequired = props.snapshot?.models?.codex?.managedBuildsRequiredBy !== undefined;
  const managedOn = managedRequired || props.snapshot?.models?.codex?.managedBuilds?.value === true;
  const runtime = props.snapshot?.runtime?.tokenMiser?.managedCodex;
  const customBusy = pendingNext !== undefined || isRunning(progress);
  const displayedAdvisory = advisory ?? operationAdvisory;
  // The same offer Get started makes: OpenAI's Codex fills in over a
  // user-installed Codex that is too old, but never over a path the
  // operator chose. PwrAgent's own installs keep their own guidance.
  const openAiOffered = props.desktopApi?.refreshCodexDiscovery !== undefined
    && advisory !== undefined
    && advisory.installer !== "pwragent-openai"
    && codexInstallOffer({ snapshot: props.snapshot, discovering: false })?.reason === "outdated";
  const openAiProgress = openAiRequested || openAiOffered ? openAi.progress : undefined;
  const openAiBusy = openAi.installing || isRunning(openAiProgress);
  const busy = customBusy || openAiBusy;
  const { onManagedBuildsChange, onCheckManagedBuildUpdates } = props;
  const changeBuild = useCallback(async (next: boolean, check = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOperationAdvisory(displayedAdvisory);
    setPendingNext(next);
    setOperationError(undefined);
    setFailedOperation(undefined);
    try {
      if (check && onCheckManagedBuildUpdates) {
        await onCheckManagedBuildUpdates();
      } else if (!await onManagedBuildsChange?.(next)) {
        setFailedOperation({ next, check });
        setOperationError("Could not change the Codex build. Open Codex settings for details, or try again.");
      }
    } catch (error) {
      setFailedOperation({ next, check });
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setPendingNext(undefined);
    }
  }, [displayedAdvisory, onManagedBuildsChange, onCheckManagedBuildUpdates]);
  const { install: installOpenAi } = openAi;
  const installOpenAiCodex = useCallback(() => {
    setOperationAdvisory(displayedAdvisory);
    setOpenAiRequested(true);
    void installOpenAi();
  }, [displayedAdvisory, installOpenAi]);
  const retryOperation = useCallback(() => {
    // A retained installer failure may have started in another window. Only
    // that case falls back to the current preference; our own retries retain
    // the operation the operator requested, including a disable.
    const operation = failedOperation ?? { next: true, check: managedOn };
    void changeBuild(operation.next, operation.check);
  }, [failedOperation, managedOn, changeBuild]);

  useEffect(() => {
    // Keep the originating warning through the ready strip, even if the
    // settings response already names the new build and clears its advisory.
    if (!busy && !progress && !openAiProgress && !operationError && !openAi.error) {
      setOperationAdvisory(undefined);
      if (!advisory) setOpenAiRequested(false);
    }
  }, [advisory, busy, progress, openAiProgress, operationError, openAi.error]);
  // Held in memory: closing the toast silences it for this launch, and a
  // Codex that is still old asks again at the next one. It is a warning about
  // models the operator cannot see, so it should not quietly stay gone.
  const [dismissedVersion, setDismissedVersion] = useState<string>();
  const { desktopApi, onNoticeChanged, onOpenCodexSettings } = props;
  const openAiInstalled = !advisory && !busy && openAiRequested && openAiProgress?.phase === "ready";
  const openAiInstalledVersion = openAiProgress?.tag;

  const notice = useMemo(
    () => buildCodexVersionNotice({
      advisory: displayedAdvisory,
      dismissedVersion,
      onCopyCommand: (command) => {
        void copyText(command, desktopApi);
      },
      onDismiss: setDismissedVersion,
      onOpenCodexSettings,
      onOpenReleasePage: (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
      installed: !advisory && !busy && progress?.phase === "ready",
      openAiInstalled: openAiInstalled ? { version: openAiInstalledVersion } : undefined,
      openAiInstall: openAiOffered || openAiRequested
        ? { onInstall: !busy && !openAiProgress ? installOpenAiCodex : undefined }
        : undefined,
      waitingForIdle: runtime?.state === "pending-switch",
      body: onManagedBuildsChange || openAiProgress || openAi.error ? (
        <div className="codex-version-build">
          {openAiProgress ? (
            <ManagedRuntimeProgressStrip
              progress={openAiProgress}
              onRetry={openAi.installing ? undefined : installOpenAiCodex}
            />
          ) : openAi.installing ? (
            <p className="app-notice-toast__status">Installing OpenAI's latest Codex…</p>
          ) : null}
          {openAi.error && openAiProgress?.phase !== "failed" ? (
            <p className="app-notice-toast__suppression-error">{openAi.error}</p>
          ) : null}
          {onManagedBuildsChange && !openAiInstalled ? (
            <CustomBuildControls
              checked={pendingNext ?? managedOn}
              busy={busy}
              locked={managedRequired}
              progress={progress}
              customBusy={customBusy}
              waitingForIdle={runtime?.state === "pending-switch"}
              operationError={operationError}
              canCheckForUpdates={managedOn && onCheckManagedBuildUpdates !== undefined}
              onChange={(next) => { void changeBuild(next); }}
              onRetry={retryOperation}
              onCheckForUpdates={() => { void changeBuild(true, true); }}
            />
          ) : null}
        </div>
      ) : undefined,
    }),
    [advisory, displayedAdvisory, desktopApi, dismissedVersion, onOpenCodexSettings,
      onManagedBuildsChange, onCheckManagedBuildUpdates, pendingNext, managedOn,
      busy, customBusy, managedRequired, progress, runtime?.state, operationError, changeBuild,
      retryOperation, openAiOffered, openAiProgress, openAiRequested, openAi.installing, openAi.error,
      openAiInstalled, openAiInstalledVersion, installOpenAiCodex],
  );

  useEffect(() => {
    onNoticeChanged(notice);
  }, [notice, onNoticeChanged]);

  return null;
}

/** A download that has started and not yet settled. */
function isRunning(progress: ManagedRuntimeProgress | undefined): boolean {
  return progress !== undefined && progress.phase !== "ready" && progress.phase !== "failed";
}

/**
 * PwrAgent's own Codex build, as the secondary choice under OpenAI's: the
 * switch, its install progress, and its update check.
 */
function CustomBuildControls(props: {
  checked: boolean;
  busy: boolean;
  locked: boolean;
  progress?: ManagedRuntimeProgress;
  customBusy: boolean;
  waitingForIdle: boolean;
  operationError?: string;
  canCheckForUpdates: boolean;
  onChange: (next: boolean) => void;
  onRetry: () => void;
  onCheckForUpdates: () => void;
}) {
  return (
    <>
      <div className="codex-version-build__toggle">
        <span>Use PwrAgent custom Codex build</span>
        <SettingsSwitch
          label="Use PwrAgent custom Codex build"
          checked={props.checked}
          disabled={props.busy}
          pending={props.customBusy}
          locked={props.locked}
          describedBy={props.locked ? "codex-version-build-lock" : undefined}
          onChange={props.onChange}
        />
      </div>
      {props.locked ? (
        <p id="codex-version-build-lock" className="app-notice-toast__detail">
          Token Miser requires the custom build. Turn Token Miser off in settings to disable it.
        </p>
      ) : null}
      {props.progress ? (
        <ManagedRuntimeProgressStrip
          progress={props.progress}
          waitingForIdle={props.waitingForIdle}
          onRetry={props.onRetry}
        />
      ) : props.customBusy ? (
        <p className="app-notice-toast__status">Checking and installing the Codex build…</p>
      ) : props.waitingForIdle ? (
        <p className="app-notice-toast__detail">Installed and verified. Takes over after active turns finish.</p>
      ) : null}
      {props.operationError && props.progress?.phase !== "failed" ? (
        <>
          <p className="app-notice-toast__suppression-error">{props.operationError}</p>
          <button className="button button--ghost"
            type="button"
            disabled={props.busy}
            onClick={props.onRetry}
          >
            Try again
          </button>
        </>
      ) : null}
      {props.canCheckForUpdates && !props.busy && props.progress?.phase !== "failed" ? (
        <button className="button button--ghost"
          type="button"
          onClick={props.onCheckForUpdates}
        >
          Check for updates
        </button>
      ) : null}
    </>
  );
}

export function buildCodexVersionNotice(params: {
  advisory?: DesktopCodexVersionAdvisory;
  dismissedVersion?: string;
  onCopyCommand: (command: string) => void;
  onDismiss: (version: string) => void;
  onOpenCodexSettings: () => void;
  onOpenReleasePage: (url: string) => void;
  body?: ReactNode;
  installed?: boolean;
  waitingForIdle?: boolean;
  /**
   * PwrAgent can replace this Codex with OpenAI's latest. `onInstall` is
   * absent while an install runs: its progress is in the body.
   */
  openAiInstall?: { onInstall?: () => void };
  /** OpenAI's Codex, installed from this notice, is ready. */
  openAiInstalled?: { version?: string };
}): AppNoticeToastNotice | undefined {
  const { advisory } = params;
  if (!advisory || advisory.version === params.dismissedVersion) {
    return undefined;
  }
  const openSettings = {
    label: "Open Codex settings",
    onClick: params.onOpenCodexSettings,
    tone: "secondary" as const,
  };
  const base = {
    id: `codex-version:${advisory.version}`,
    autoDismiss: false,
    onDismiss: () => params.onDismiss(advisory.version),
    tone: "warning" as const,
    body: params.body,
  };
  const message =
    `Codex ${advisory.version} is too old for GPT-6.1-Sol. Update to`
    + ` Codex ${advisory.minimumVersion}+ to use it.`;

  if (params.openAiInstalled) {
    const version = params.openAiInstalled.version;
    return {
      ...base,
      tone: "success",
      title: "OpenAI Codex installed",
      message: `${version ? `Codex ${version}` : "OpenAI's latest Codex"} is installed and ready.`
        + " PwrAgent keeps it up to date.",
      actions: [openSettings],
    };
  }

  if (params.installed) {
    return {
      ...base,
      tone: "success",
      title: "PwrAgent custom Codex build installed",
      message: params.waitingForIdle
        ? "Installed and verified. Takes over after active turns finish."
        : "The custom Codex build is installed and ready.",
      actions: [openSettings],
    };
  }

  if (advisory.installer === "pwragent") {
    // PwrAgent keeps its own build current, so there is nothing to install by
    // hand; an old one means an update check has not landed.
    return {
      ...base,
      title: "PwrAgent's Codex build is out of date",
      message,
      detail:
        "Check for an updated custom build here or in Codex settings.",
      actions: [
        {
          ...openSettings,
          tone: "primary",
        },
      ],
    };
  }

  if (advisory.installer === "pwragent-openai") {
    // PwrAgent installed this Codex from OpenAI and updates it itself, so
    // there is no command to run; the next update check replaces it.
    return {
      ...base,
      title: "Update Codex for GPT-6.1-Sol",
      message,
      detail:
        "PwrAgent installed this Codex from OpenAI and updates it on its own."
        + " Once the newer release downloads, check again in Codex settings to use it.",
      actions: [{ ...openSettings, tone: "primary" }],
    };
  }

  const openAiInstall = params.openAiInstall;
  if (openAiInstall) {
    // OpenAI's own release, kept current by PwrAgent, is the one-click way
    // out. The way this Codex was installed stays on offer beside it.
    const install = openAiInstall.onInstall
      ? [{ label: "Install latest Codex", onClick: openAiInstall.onInstall, tone: "primary" as const }]
      : [];
    const command = advisory.upgradeCommand;
    const lead = "PwrAgent can install OpenAI's latest Codex and keep it up to date.";
    if (command) {
      return {
        ...base,
        title: "Update Codex for GPT-6.1-Sol",
        message,
        detail: `${lead} Or run this in a terminal, then restart PwrAgent:\n${command}`,
        copyText: command,
        actions: [
          ...install,
          { label: "Copy command", onClick: () => params.onCopyCommand(command), tone: "secondary" },
        ],
      };
    }
    return {
      ...base,
      title: "Update Codex for GPT-6.1-Sol",
      message,
      detail: advisory.installer === "application"
        ? `${lead} Or update the ChatGPT / Codex app that supplies this Codex, then restart PwrAgent.`
        : `${lead} Or update this Codex the way you installed it, then restart PwrAgent.`,
      actions: [...install, openSettings],
    };
  }

  if (advisory.upgradeCommand) {
    const command = advisory.upgradeCommand;
    return {
      ...base,
      title: "Update Codex for GPT-6.1-Sol",
      message,
      detail:
        `Run this in a terminal, then restart PwrAgent:\n${command}`,
      // The toast's copy button copies this, so it is the command and not the
      // sentence around it.
      copyText: command,
      actions: [
        {
          label: "Copy command",
          onClick: () => params.onCopyCommand(command),
          tone: "primary",
        },
        openSettings,
      ],
    };
  }

  if (advisory.installer === "application") {
    return {
      ...base,
      title: "Update Codex for GPT-6.1-Sol",
      message,
      detail:
        "Update the ChatGPT / Codex app that supplies this Codex, then restart"
        + " PwrAgent. Or enable the PwrAgent custom Codex build below.",
      actions: [{ ...openSettings, tone: "primary" }],
    };
  }

  return {
    ...base,
    title: "Update Codex for GPT-6.1-Sol",
    message,
    detail:
      "PwrAgent could not tell how this Codex was installed. Update it the same"
      + " way, or update your ChatGPT / Codex app or Codex CLI, then restart"
      + " PwrAgent. You can also enable the custom build below.",
    actions: [
      {
        label: "Open releases",
        onClick: () => params.onOpenReleasePage(OPENAI_CODEX_RELEASES_URL),
        tone: "primary",
      },
      openSettings,
    ],
  };
}
