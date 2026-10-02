import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentEvent } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { federationTargetsEqual } from "../../lib/federated-thread-events";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";

/** Every notice id this producer can emit, as prefixes for the host's sweep. */
export const CODEX_CONFIG_WARNING_NOTICE_ID_PREFIXES = [
  "codex-config-warning:",
] as const;

type ConfigWarningNotice = {
  id: string;
  summary: string;
  details?: string | null;
  trustedProjectPath?: string;
  configPath?: string;
};

function noticeFromEvent(event: AgentEvent): ConfigWarningNotice | undefined {
  if (event.backend !== "codex" || event.notification.method !== "configWarning") {
    return undefined;
  }

  const params = event.notification.params as Record<string, unknown>;
  const rawSummary = params.summary;
  const summary = typeof rawSummary === "string" ? rawSummary.trim() : "";
  if (!summary) {
    return undefined;
  }

  const rawTrustedProjectPath = params.trustedProjectPath;
  const rawConfigPath = params.configPath;
  const rawDetails = params.details;
  const trustedProjectPath =
    typeof rawTrustedProjectPath === "string"
      ? rawTrustedProjectPath.trim()
      : undefined;
  const configPath =
    typeof rawConfigPath === "string" ? rawConfigPath.trim() : undefined;
  const details = typeof rawDetails === "string" ? rawDetails : null;
  const id = [
    summary,
    trustedProjectPath ?? "",
    configPath ?? "",
  ].join("\n");

  return {
    id,
    summary,
    ...(details ? { details } : {}),
    ...(trustedProjectPath ? { trustedProjectPath } : {}),
    ...(configPath ? { configPath } : {}),
  };
}

export function CodexConfigWarningNotice(props: {
  desktopApi?: DesktopApi;
  onNoticeChanged: (notice: AppNoticeToastNotice | undefined) => void;
}) {
  const [notice, setNotice] = useState<ConfigWarningNotice | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const [trusting, setTrusting] = useState(false);
  const [trustError, setTrustError] = useState<string | null>(null);
  const { desktopApi, onNoticeChanged } = props;
  const federationTargetInstanceId = readRendererFederationTarget()?.instanceId;

  useEffect(() => {
    if (!desktopApi?.onAgentEvent && !desktopApi?.getLatestCodexConfigWarning) {
      return;
    }

    let cancelled = false;
    const applyEvent = (event: AgentEvent): void => {
      if (cancelled) {
        return;
      }
      const rendererTarget = federationTargetInstanceId
        ? { scope: "remote" as const, instanceId: federationTargetInstanceId }
        : undefined;
      if (!federationTargetsEqual(event.federationTarget, rendererTarget)) {
        return;
      }
      const nextNotice = noticeFromEvent(event);
      if (!nextNotice) {
        return;
      }
      if (dismissedIds.has(nextNotice.id)) {
        return;
      }
      setNotice(nextNotice);
      setTrustError(null);
      setTrusting(false);
    };

    const unsubscribe = desktopApi.onAgentEvent?.(applyEvent);
    void desktopApi.getLatestCodexConfigWarning?.()
      .then((response) => {
        if (response.event) {
          applyEvent(response.event);
        }
      })
      .catch(() => {
        // Live events still cover builds that cannot provide a snapshot.
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi, dismissedIds, federationTargetInstanceId]);

  const actionLabel = useMemo(() => {
    const projectPath = notice?.trustedProjectPath;
    if (!projectPath) {
      return "Trust Project";
    }
    const label = projectPath.split(/[\\/]/).filter(Boolean).at(-1);
    return label ? `Trust ${label}` : "Trust Project";
  }, [notice?.trustedProjectPath]);

  const trustProject = useCallback(async (
    warning: ConfigWarningNotice,
  ): Promise<void> => {
    if (!warning.trustedProjectPath || !desktopApi?.trustCodexProject) {
      setTrustError("Project trust is not available in this build.");
      return;
    }

    setTrusting(true);
    setTrustError(null);
    try {
      await desktopApi.trustCodexProject({
        ...(federationTargetInstanceId
          ? {
              federationTarget: {
                scope: "remote",
                instanceId: federationTargetInstanceId,
              } as const,
            }
          : {}),
        projectPath: warning.trustedProjectPath,
        ...(warning.configPath ? { configPath: warning.configPath } : {}),
      });
      setDismissedIds((current) => new Set(current).add(warning.id));
      setNotice(null);
    } catch (error) {
      setTrustError(error instanceof Error ? error.message : String(error));
      setTrusting(false);
    }
  }, [desktopApi, federationTargetInstanceId]);

  const appNotice = useMemo((): AppNoticeToastNotice | undefined => {
    if (!notice) {
      return undefined;
    }
    return {
      id: `${CODEX_CONFIG_WARNING_NOTICE_ID_PREFIXES[0]}${notice.id}`,
      autoDismiss: false,
      tone: "warning",
      title: "Codex config warning",
      message: notice.summary,
      ...(notice.details ? { detail: notice.details } : {}),
      ...(trustError
        ? { status: { label: trustError, state: "error" as const } }
        : {}),
      ...(notice.trustedProjectPath
        ? {
            actions: [{
              label: trusting ? "Trusting..." : actionLabel,
              onClick: () => {
                void trustProject(notice);
              },
              tone: "primary" as const,
              disabled: trusting,
            }],
          }
        : {}),
      onDismiss: () => {
        // The old Dismiss was disabled through a trust: closed now, a failed
        // trust would report its error to no one.
        if (trusting) return;
        setDismissedIds((current) => new Set(current).add(notice.id));
        setNotice(null);
      },
    };
  }, [actionLabel, notice, trustError, trustProject, trusting]);

  useEffect(() => {
    onNoticeChanged(appNotice);
  }, [appNotice, onNoticeChanged]);

  return null;
}
