import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";
import {
  antigravityRuntimeView,
  antigravityUpdateNoticeVersion,
  type AntigravityRuntimeView,
} from "../settings/antigravity-runtime-view";
import { ManagedRuntimeProgressStrip, useManagedRuntimeProgress } from "../settings/ManagedRuntimeProgress";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

/**
 * Every durable notice id this producer can emit, as prefixes, for the host to
 * sweep before showing the current one. See `GROK_UPDATE_NOTICE_ID_PREFIXES`.
 */
export const ANTIGRAVITY_UPDATE_NOTICE_ID_PREFIXES = ["antigravity-update:"] as const;

type NoticeApi = Pick<
  DesktopApi,
  "antigravitySetup" | "listAcpAgents" | "onManagedRuntimeProgress" | "readManagedRuntimeProgress"
>;

/**
 * Offers a newer Antigravity release at startup. PwrAgent runs its managed
 * `agy` with the CLI's own updater off, so without this the managed copy only
 * moves when someone happens to open Settings. It asks Google only when the
 * managed install is what new threads run: anyone on their own `agy`, or not
 * using Antigravity, causes no request at all.
 */
export function AntigravityUpdateNotice(props: {
  desktopApi?: NoticeApi;
  onNoticeChanged: (notice: AppNoticeToastNotice | undefined) => void;
  onOpenSettings: () => void;
}) {
  const { desktopApi, onNoticeChanged, onOpenSettings } = props;
  const [view, setView] = useState<AntigravityRuntimeView>({ kind: "loading" });
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string>();
  const [installedVersion, setInstalledVersion] = useState<string>();
  // Held in memory, as the Codex notice is: closing it quiets this version for
  // the session, and a still-old install asks again at the next launch.
  const [dismissedVersion, setDismissedVersion] = useState<string>();
  const progress = useManagedRuntimeProgress(desktopApi, "antigravity");

  const evaluate = useCallback(async (): Promise<void> => {
    const request = desktopApi?.antigravitySetup;
    if (!request) return;
    // A cache-only read: no discovery, no CLI spawn.
    const listed = await desktopApi?.listAcpAgents?.({ refresh: false });
    const entry = listed?.entries.find((candidate) => candidate.registryId === "antigravity");
    if (!entry || entry.enabled === false) {
      setView({ kind: "loading" });
      return;
    }
    const read = await request({ action: "read" });
    if (!read.ok) return;
    const local = antigravityRuntimeView({ runtime: read.runtime, entry });
    if (local.kind !== "installed" || !local.inUse) {
      setView(local);
      return;
    }
    const checked = await request({ action: "check-update" });
    setView(checked.ok
      ? antigravityRuntimeView({ runtime: checked.runtime ?? read.runtime, release: checked.release, entry })
      : local);
  }, [desktopApi]);
  const evaluateRef = useRef(evaluate);
  evaluateRef.current = evaluate;

  useEffect(() => {
    void evaluate().catch(() => undefined);
    // Discovery may not have named the active Antigravity yet at launch. The
    // Settings pane and Get started raise this after every discovery refresh;
    // main reuses a recent release check, so this costs no extra request.
    const onRefreshed = () => {
      void evaluateRef.current().catch(() => undefined);
    };
    window.addEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, onRefreshed);
    return () => window.removeEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, onRefreshed);
  }, [evaluate]);

  // Settings or another window finished an install: re-read, so the offer for
  // a release that is now installed leaves the screen.
  const readyAt = progress?.phase === "ready" ? progress.updatedAt : undefined;
  useEffect(() => {
    if (readyAt !== undefined) void evaluateRef.current().catch(() => undefined);
  }, [readyAt]);

  const update = useCallback(async () => {
    const request = desktopApi?.antigravitySetup;
    if (!request) return;
    setInstalling(true);
    setInstallError(undefined);
    const result = await request({ action: "install" }).catch(() => ({
      ok: false as const,
      message: "Could not finish setting up Antigravity. Try again or install it manually.",
    }));
    setInstalling(false);
    if (!result.ok) {
      setInstallError(result.message);
      return;
    }
    if (result.runtime?.status === "installed") setInstalledVersion(result.runtime.runtime.version);
    window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
  }, [desktopApi]);

  const latestVersion = antigravityUpdateNoticeVersion(view, dismissedVersion);
  const currentVersion = view.kind === "installed" ? view.version : undefined;
  const notice = useMemo(() => {
    if (installedVersion && !latestVersion) {
      return {
        id: `antigravity-update:installed:${installedVersion}`,
        autoDismiss: true,
        tone: "success" as const,
        title: "Antigravity updated",
        message: `New Antigravity threads use ${installedVersion}. Running threads keep their version.`,
        onDismiss: () => setInstalledVersion(undefined),
      };
    }
    if (!latestVersion || !currentVersion) return undefined;
    return buildAntigravityUpdateNotice({
      latestVersion,
      currentVersion,
      installing,
      body: progress || installError ? (
        <>
          {progress ? <ManagedRuntimeProgressStrip progress={progress} onRetry={installing ? undefined : () => void update()} /> : null}
          {installError && progress?.phase !== "failed" ? (
            <p className="app-notice-toast__suppression-error">{installError}</p>
          ) : null}
        </>
      ) : undefined,
      onUpdate: () => void update(),
      onOpenSettings,
      onDismiss: () => setDismissedVersion(latestVersion),
    });
  }, [currentVersion, installError, installedVersion, installing, latestVersion, onOpenSettings, progress, update]);

  useEffect(() => {
    onNoticeChanged(notice);
  }, [notice, onNoticeChanged]);

  return null;
}

export function buildAntigravityUpdateNotice(params: {
  latestVersion: string;
  currentVersion: string;
  installing: boolean;
  body?: ReactNode;
  onUpdate: () => void;
  onOpenSettings: () => void;
  onDismiss: () => void;
}): AppNoticeToastNotice {
  return {
    id: `antigravity-update:${params.latestVersion}`,
    autoDismiss: false,
    tone: "neutral",
    title: "Antigravity update available",
    message:
      `Antigravity ${params.latestVersion} is available.`
      + ` PwrAgent's install is ${params.currentVersion}.`,
    detail:
      "PwrAgent downloads Google's release, verifies it, and uses it for new"
      + " threads. Running threads keep their version.",
    body: params.body,
    onDismiss: params.onDismiss,
    actions: params.installing
      ? []
      : [
          { label: `Update to ${params.latestVersion}`, onClick: params.onUpdate, tone: "primary" },
          { label: "Open Antigravity settings", onClick: params.onOpenSettings, tone: "secondary" },
        ],
  };
}
