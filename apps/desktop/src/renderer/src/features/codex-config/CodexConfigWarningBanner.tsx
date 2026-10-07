import { useEffect, useMemo, useState } from "react";
import type { AgentEvent } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { federationTargetsEqual } from "../../lib/federated-thread-events";

const EMPTY_DISMISSED_WARNING_IDS: readonly string[] = [];

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
  const id = JSON.stringify([
    summary,
    details ?? "",
    trustedProjectPath ?? "",
    configPath ?? "",
    event.federationTarget?.scope === "remote"
      ? event.federationTarget.instanceId
      : "",
  ]);

  return {
    id,
    summary,
    ...(details ? { details } : {}),
    ...(trustedProjectPath ? { trustedProjectPath } : {}),
    ...(configPath ? { configPath } : {}),
  };
}

export function CodexConfigWarningBanner(props: {
  desktopApi?: DesktopApi;
  preferencesLoaded?: boolean;
  dismissedWarningIds?: readonly string[];
  onSuppressWarning?: (id: string) => Promise<boolean>;
}) {
  const [notice, setNotice] = useState<ConfigWarningNotice | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const [trusting, setTrusting] = useState(false);
  const [trustError, setTrustError] = useState<string | null>(null);
  const [savingWarningId, setSavingWarningId] = useState<string | null>(null);
  const [suppressionErrorId, setSuppressionErrorId] = useState<string | null>(null);
  // The checkbox records a choice; Dismiss applies it. Keyed by notice id so
  // a newer warning never inherits the previous warning's choice.
  const [suppressOnDismissId, setSuppressOnDismissId] = useState<string | null>(null);
  const desktopApi = props.desktopApi;
  const preferencesLoaded = props.preferencesLoaded !== false;
  const dismissedWarningIds = props.dismissedWarningIds ?? EMPTY_DISMISSED_WARNING_IDS;
  const federationTargetInstanceId = readRendererFederationTarget()?.instanceId;

  useEffect(() => {
    if (!preferencesLoaded) {
      return;
    }
    setNotice((current) => current && dismissedWarningIds.includes(current.id)
      ? null
      : current);
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
      if (dismissedIds.has(nextNotice.id) || dismissedWarningIds.includes(nextNotice.id)) {
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
  }, [desktopApi, dismissedIds, dismissedWarningIds, federationTargetInstanceId, preferencesLoaded]);

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
        ...(federationTargetInstanceId
          ? {
              federationTarget: {
                scope: "remote",
                instanceId: federationTargetInstanceId,
              } as const,
            }
          : {}),
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

  const suppressOnDismiss = suppressOnDismissId === notice.id;

  const suppressWarningAndDismiss = async (): Promise<void> => {
    const id = notice.id;
    setSavingWarningId(id);
    setSuppressionErrorId(null);
    try {
      const saved = await props.onSuppressWarning?.(id);
      if (saved) {
        setDismissedIds((current) => new Set(current).add(id));
        setNotice((current) => current?.id === id ? null : current);
      } else {
        setSuppressionErrorId(id);
      }
    } catch {
      setSuppressionErrorId(id);
    } finally {
      setSavingWarningId((current) => current === id ? null : current);
    }
  };

  const dismiss = (): void => {
    if (suppressOnDismiss) {
      void suppressWarningAndDismiss();
      return;
    }
    setDismissedIds((current) => new Set(current).add(notice.id));
    setNotice(null);
  };
  const suppressionSaving = savingWarningId === notice.id;

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
        {suppressionErrorId === notice.id ? (
          <p className="codex-config-warning-banner__error">
            Could not save this preference.
          </p>
        ) : null}
      </div>
      <div className="codex-config-warning-banner__actions">
        {props.onSuppressWarning ? (
          <label className="composer__checkbox codex-config-warning-banner__suppress">
            <input
              type="checkbox"
              checked={suppressOnDismiss}
              disabled={trusting || suppressionSaving}
              onChange={(event) => {
                setSuppressOnDismissId(event.currentTarget.checked ? notice.id : null);
                setSuppressionErrorId(null);
              }}
            />
            Don't show again
          </label>
        ) : null}
        {notice.trustedProjectPath ? (
          <button
            className="button button--primary"
            type="button"
            disabled={trusting || suppressionSaving}
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
          disabled={trusting || suppressionSaving}
          onClick={dismiss}
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
