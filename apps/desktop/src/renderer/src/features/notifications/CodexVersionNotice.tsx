import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopCodexVersionAdvisory,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import { OPENAI_CODEX_RELEASES_URL } from "../../lib/codex-release-channel";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

/**
 * Every durable notice id this producer can emit, as prefixes, for the host to
 * sweep before showing the current one. See `GROK_UPDATE_NOTICE_ID_PREFIXES`.
 */
export const CODEX_VERSION_NOTICE_ID_PREFIXES = ["codex-version:"] as const;

const NEWEST_MODELS = "GPT-6-Sol, GPT-6.1-Sol and newer models";

/**
 * Warns at startup when the Codex PwrAgent launches is too old to offer the
 * newest models. It reads the settings snapshot the window already holds, so it
 * adds no probe of its own: discovery has already run the version check.
 */
export function CodexVersionNotice(props: {
  desktopApi?: Pick<DesktopApi, "copyText">;
  snapshot?: DesktopSettingsSnapshot;
  onNoticeChanged: (notice: AppNoticeToastNotice | undefined) => void;
  onOpenCodexSettings: () => void;
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
  // Held in memory: closing the toast silences it for this launch, and a
  // Codex that is still old asks again at the next one. It is a warning about
  // models the operator cannot see, so it should not quietly stay gone.
  const [dismissedVersion, setDismissedVersion] = useState<string>();
  const { desktopApi, onNoticeChanged, onOpenCodexSettings } = props;

  const notice = useMemo(
    () => buildCodexVersionNotice({
      advisory,
      dismissedVersion,
      onCopyCommand: (command) => {
        void copyText(command, desktopApi);
      },
      onDismiss: setDismissedVersion,
      onOpenCodexSettings,
      onOpenReleasePage: (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    }),
    [advisory, desktopApi, dismissedVersion, onOpenCodexSettings],
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
}): AppNoticeToastNotice | undefined {
  const { advisory } = params;
  if (!advisory || advisory.version === params.dismissedVersion) {
    return undefined;
  }
  const useManagedBuild = {
    label: "Use PwrAgent build",
    onClick: params.onOpenCodexSettings,
    tone: "secondary" as const,
  };
  const base = {
    id: `codex-version:${advisory.version}`,
    autoDismiss: false,
    onDismiss: () => params.onDismiss(advisory.version),
    tone: "warning" as const,
  };
  const message =
    `Codex ${advisory.version} is older than ${advisory.minimumVersion}, so it`
    + ` can't use ${NEWEST_MODELS}.`;

  if (advisory.installer === "pwragent") {
    // PwrAgent keeps its own build current, so there is nothing to install by
    // hand; an old one means an update check has not landed.
    return {
      ...base,
      title: "PwrAgent's Codex build is out of date",
      message,
      detail:
        "PwrAgent updates its own build. Check for updates in Settings → AI"
        + " Providers → Codex, then restart PwrAgent.",
      actions: [
        {
          label: "Open Codex settings",
          onClick: params.onOpenCodexSettings,
          tone: "primary",
        },
      ],
    };
  }

  if (advisory.upgradeCommand) {
    const command = advisory.upgradeCommand;
    return {
      ...base,
      title: "Update Codex to use the newest models",
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
        useManagedBuild,
      ],
    };
  }

  if (advisory.installer === "application") {
    return {
      ...base,
      title: "Update Codex to use the newest models",
      message,
      detail:
        "This Codex comes with an installed app. Update that app, then restart"
        + " PwrAgent. Or have PwrAgent download and keep its own Codex build.",
      actions: [{ ...useManagedBuild, tone: "primary" }],
    };
  }

  return {
    ...base,
    title: "Update Codex to use the newest models",
    message,
    detail:
      "PwrAgent could not tell how this Codex was installed. Update it the same"
      + " way, or download a current release, then restart PwrAgent.",
    actions: [
      {
        label: "Open releases",
        onClick: () => params.onOpenReleasePage(OPENAI_CODEX_RELEASES_URL),
        tone: "primary",
      },
      useManagedBuild,
    ],
  };
}
