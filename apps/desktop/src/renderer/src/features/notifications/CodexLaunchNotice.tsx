import { useEffect, useMemo, useState } from "react";
import type { DesktopCodexDiscoverySnapshot } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export const CODEX_LAUNCH_NOTICE_ID = "codex-launch-failed";
export const CODEX_CLI_INSTALL_URL = "https://developers.openai.com/codex/cli#getting-started";

type CodexLaunchFailure = { command: string; reason: string };

export function isCodexLaunchFailureReason(reason: string): boolean {
  return reason === "not_executable"
    || reason.startsWith("Codex CLI failed to launch:")
    || /^Command failed: [^\n]*\bcodex(?:\.cmd|\.exe)?(?:\s|$)/i.test(reason)
    || /\bspawn\b[^\n]*[\\/]codex(?:\.exe)?\s+(?:ENOENT|ENOTDIR|EACCES|EPERM)\b/i.test(reason)
    || reason.includes("Missing optional dependency @openai/codex");
}

export function findCodexLaunchFailure(
  discovery: DesktopCodexDiscoverySnapshot | undefined,
): CodexLaunchFailure | undefined {
  for (const candidate of discovery?.candidates ?? []) {
    const reason = candidate.failureReason ?? candidate.versionFailureReason;
    // Missing commands, old versions, and unfinished probes are not evidence
    // of a broken installation. A nested npm spawn failure is a nonzero exit
    // of an executable wrapper, reported in versionFailureReason upstream.
    if (reason && isCodexLaunchFailureReason(reason)) {
      return { command: candidate.command, reason };
    }
  }
  return undefined;
}

export function CodexLaunchNotice(props: {
  discovery?: DesktopCodexDiscoverySnapshot;
  onNoticeChanged: (notice: AppNoticeToastNotice | undefined) => void;
  onOpenCodexSettings: () => void;
}) {
  const failure = findCodexLaunchFailure(props.discovery);
  const failureKey = failure ? JSON.stringify(failure) : undefined;
  const [dismissedFailure, setDismissedFailure] = useState<string>();
  const { onNoticeChanged, onOpenCodexSettings } = props;
  const selectedCommand = props.discovery?.selectedCommand;
  const notice = useMemo(() => {
    if (!failureKey || failureKey === dismissedFailure) return undefined;
    return buildCodexLaunchNotice({
      failure: JSON.parse(failureKey) as CodexLaunchFailure,
      selectedCommand,
      onDismiss: () => setDismissedFailure(failureKey),
      onOpenCodexSettings,
    });
  }, [dismissedFailure, failureKey, selectedCommand, onOpenCodexSettings]);

  useEffect(() => {
    // Once a successful refresh clears the failure, a later failure of the
    // same install is a new incident and must be shown again.
    if (!failureKey) setDismissedFailure(undefined);
  }, [failureKey]);

  useEffect(() => {
    onNoticeChanged(notice);
  }, [notice, onNoticeChanged]);

  return null;
}

export function buildCodexLaunchNotice(params: {
  failure: CodexLaunchFailure;
  selectedCommand?: string;
  onDismiss: () => void;
  onOpenCodexSettings: () => void;
}): AppNoticeToastNotice {
  return {
    id: CODEX_LAUNCH_NOTICE_ID,
    autoDismiss: false,
    // Supersede the generic no-provider startup notice for this incident.
    coalescing: { key: "codex-launch", priority: 1 },
    title: "Codex installation failed to start",
    tone: params.selectedCommand ? "warning" : "error",
    message:
      "Open Codex settings and click Refresh Codex to rediscover available"
      + " versions. If it still fails, reinstall the Codex CLI.",
    ...(params.selectedCommand
      ? { detail: "Another working Codex installation is available." }
      : {}),
    facts: [{ label: "Failed installation", value: params.failure.command }],
    copyText: `${params.failure.command}\n${params.failure.reason}`,
    onDismiss: params.onDismiss,
    actions: [{
      label: "Open Codex settings",
      onClick: params.onOpenCodexSettings,
      tone: "primary",
    }],
    body: <CodexInstallGuideLink />,
  };
}

export function CodexInstallGuideLink(props: { showRefreshHint?: boolean }) {
  return (
    <>
      {props.showRefreshHint ? (
        <p className="app-notice-toast__detail">
          Click Refresh Codex in Settings to rediscover available versions.
        </p>
      ) : null}
      <a className="app-notice-toast__link"
        href={CODEX_CLI_INSTALL_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        Codex CLI installation guide
      </a>
    </>
  );
}
