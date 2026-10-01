import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  DesktopCodexVersionAdvisory,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import { OPENAI_CODEX_RELEASES_URL } from "../../lib/codex-release-channel";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppNoticeToastNotice } from "./AppNoticeToast";
import { ManagedRuntimeProgressStrip, useManagedRuntimeProgress } from "../settings/ManagedRuntimeProgress";
import { SettingsSwitch } from "../settings/SettingsSwitch";

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
  desktopApi?: Pick<DesktopApi, "copyText" | "onManagedRuntimeProgress" | "readManagedRuntimeProgress">;
  snapshot?: DesktopSettingsSnapshot;
  onNoticeChanged: (notice: AppNoticeToastNotice | undefined) => void;
  onOpenCodexSettings: () => void;
  onManagedBuildsChange?: (enabled: boolean) => Promise<boolean>;
  onCheckManagedBuildUpdates?: () => Promise<void>;
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
  const [operationAdvisory, setOperationAdvisory] = useState<DesktopCodexVersionAdvisory>();
  const [pendingNext, setPendingNext] = useState<boolean>();
  const [operationError, setOperationError] = useState<string>();
  const inFlight = useRef(false);
  const managedRequired = props.snapshot?.models?.codex?.managedBuildsRequiredBy !== undefined;
  const managedOn = managedRequired || props.snapshot?.models?.codex?.managedBuilds?.value === true;
  const runtime = props.snapshot?.runtime?.tokenMiser?.managedCodex;
  const busy = pendingNext !== undefined
    || (progress !== undefined && progress.phase !== "ready" && progress.phase !== "failed");
  const displayedAdvisory = advisory ?? operationAdvisory;
  const { onManagedBuildsChange, onCheckManagedBuildUpdates } = props;
  const changeBuild = useCallback(async (next: boolean, check = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOperationAdvisory(displayedAdvisory);
    setPendingNext(next);
    setOperationError(undefined);
    try {
      if (check && onCheckManagedBuildUpdates) {
        await onCheckManagedBuildUpdates();
      } else if (!await onManagedBuildsChange?.(next)) {
        setOperationError("Could not change the Codex build. Open Codex settings for details, or try again.");
      }
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setPendingNext(undefined);
    }
  }, [displayedAdvisory, onManagedBuildsChange, onCheckManagedBuildUpdates]);

  useEffect(() => {
    // Keep the originating warning through the ready strip, even if the
    // settings response already names the new build and clears its advisory.
    if (!busy && !progress && !operationError) setOperationAdvisory(undefined);
  }, [busy, progress, operationError]);
  // Held in memory: closing the toast silences it for this launch, and a
  // Codex that is still old asks again at the next one. It is a warning about
  // models the operator cannot see, so it should not quietly stay gone.
  const [dismissedVersion, setDismissedVersion] = useState<string>();
  const { desktopApi, onNoticeChanged, onOpenCodexSettings } = props;

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
      waitingForIdle: runtime?.state === "pending-switch",
      body: onManagedBuildsChange ? (
        <div className="codex-version-build">
          <div className="codex-version-build__toggle">
            <span>Use PwrAgent custom Codex build</span>
            <SettingsSwitch
              label="Use PwrAgent custom Codex build"
              checked={pendingNext ?? managedOn}
              disabled={busy}
              pending={busy}
              locked={managedRequired}
              describedBy={managedRequired ? "codex-version-build-lock" : undefined}
              onChange={(next) => { void changeBuild(next); }}
            />
          </div>
          {managedRequired ? (
            <p id="codex-version-build-lock" className="app-notice-toast__detail">
              Token Miser requires the custom build. Turn Token Miser off in settings to disable it.
            </p>
          ) : null}
          {progress ? (
            <ManagedRuntimeProgressStrip
              progress={progress}
              waitingForIdle={runtime?.state === "pending-switch"}
              onRetry={() => { void changeBuild(true, managedOn); }}
            />
          ) : busy ? (
            <p className="app-notice-toast__status">Checking and installing the Codex build…</p>
          ) : runtime?.state === "pending-switch" ? (
            <p className="app-notice-toast__detail">Installed and verified. Takes over after active turns finish.</p>
          ) : null}
          {operationError && progress?.phase !== "failed" ? (
            <>
              <p className="app-notice-toast__suppression-error">{operationError}</p>
              <button className="button button--ghost"
                type="button"
                disabled={busy}
                onClick={() => { void changeBuild(true, managedOn); }}
              >
                Try again
              </button>
            </>
          ) : null}
          {managedOn && !busy && progress?.phase !== "failed" && onCheckManagedBuildUpdates ? (
            <button className="button button--ghost"
              type="button"
              onClick={() => { void changeBuild(true, true); }}
            >
              Check for updates
            </button>
          ) : null}
        </div>
      ) : undefined,
    }),
    [advisory, displayedAdvisory, desktopApi, dismissedVersion, onOpenCodexSettings,
      onManagedBuildsChange, onCheckManagedBuildUpdates, pendingNext, managedOn,
      busy, managedRequired, progress, runtime?.state, operationError, changeBuild],
  );

  useEffect(() => {
    onNoticeChanged(notice);
  }, [notice, onNoticeChanged]);

  return null;
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
