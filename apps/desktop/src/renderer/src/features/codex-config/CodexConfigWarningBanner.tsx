import { useEffect, useMemo, useState } from "react";
import type { AgentEvent } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

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

export function CodexConfigWarningBanner(props: { desktopApi?: DesktopApi }) {
  const [notice, setNotice] = useState<ConfigWarningNotice | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const [trusting, setTrusting] = useState(false);
  const [trustError, setTrustError] = useState<string | null>(null);
  const desktopApi = props.desktopApi;

  useEffect(() => {
    if (!desktopApi?.onAgentEvent && !desktopApi?.getLatestCodexConfigWarning) {
      return;
    }

    let cancelled = false;
    const applyEvent = (event: AgentEvent): void => {
      if (cancelled) {
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
  }, [desktopApi, dismissedIds]);

  const actionLabel = useMemo(() => {
    const projectPath = notice?.trustedProjectPath;
    if (!projectPath) {
      return "Trust Project";
    }
    const label = projectPath.split(/[\\/]/).filter(Boolean).at(-1);
    return label ? `Trust ${label}` : "Trust Project";
  }, [notice?.trustedProjectPath]);

  if (!notice) {
    return null;
  }

  const trustProject = async (): Promise<void> => {
    if (!notice.trustedProjectPath || !desktopApi?.trustCodexProject) {
      setTrustError("Project trust is not available in this build.");
      return;
    }

    setTrusting(true);
    setTrustError(null);
    try {
      await desktopApi.trustCodexProject({
        projectPath: notice.trustedProjectPath,
        ...(notice.configPath ? { configPath: notice.configPath } : {}),
      });
      setDismissedIds((current) => new Set(current).add(notice.id));
      setNotice(null);
    } catch (error) {
      setTrustError(error instanceof Error ? error.message : String(error));
      setTrusting(false);
    }
  };

  const dismiss = (): void => {
    setDismissedIds((current) => new Set(current).add(notice.id));
    setNotice(null);
  };

  return (
    <aside className="codex-config-warning-banner" role="alert">
      <div className="codex-config-warning-banner__content">
        <p className="codex-config-warning-banner__eyebrow">Codex config warning</p>
        <p className="codex-config-warning-banner__message">{notice.summary}</p>
        {notice.details ? (
          <p className="codex-config-warning-banner__detail">{notice.details}</p>
        ) : null}
        {trustError ? (
          <p className="codex-config-warning-banner__error">{trustError}</p>
        ) : null}
      </div>
      <div className="codex-config-warning-banner__actions">
        {notice.trustedProjectPath ? (
          <button
            className="button button--primary"
            type="button"
            disabled={trusting}
            onClick={() => {
              void trustProject();
            }}
          >
            {trusting ? "Trusting..." : actionLabel}
          </button>
        ) : null}
        <button
          className="button button--ghost"
          type="button"
          disabled={trusting}
          onClick={dismiss}
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
