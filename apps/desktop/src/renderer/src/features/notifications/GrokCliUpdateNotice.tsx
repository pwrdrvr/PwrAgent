import { useCallback, useEffect, useMemo, useState } from "react";
import type { AcpAgentSettingsEntry } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export function GrokCliUpdateNotice(props: {
  desktopApi?: DesktopApi;
  now?: () => number;
  onNoticeChanged: (notice: AppNoticeToastNotice | undefined) => void;
}) {
  const [entry, setEntry] = useState<AcpAgentSettingsEntry>();
  const [clock, setClock] = useState(() => props.now?.() ?? Date.now());
  const desktopApi = props.desktopApi;
  const now = props.now ?? Date.now;
  const onNoticeChanged = props.onNoticeChanged;

  const refresh = useCallback(async () => {
    const response = await desktopApi?.listAcpAgents?.({ refresh: false });
    setEntry(
      response?.entries.find((candidate) => candidate.registryId === "grok"),
    );
  }, [desktopApi]);

  useEffect(() => {
    void refresh().catch(() => undefined);
    return desktopApi?.onAgentEvent?.((event) => {
      if (
        event.backend === "acp:grok"
        && event.notification.method === "backend/acpUpdateStatus/updated"
      ) {
        void refresh().catch(() => undefined);
      }
    });
  }, [desktopApi, refresh]);

  const snoozedUntil = entry?.update?.snoozedUntil;
  useEffect(() => {
    if (!snoozedUntil || snoozedUntil <= clock) return;
    const timeout = window.setTimeout(
      () => setClock(now()),
      Math.min(snoozedUntil - clock, 2_147_483_647),
    );
    return () => window.clearTimeout(timeout);
  }, [clock, now, snoozedUntil]);

  const acknowledge = useCallback(
    async (action: "dismiss" | "snooze") => {
      const latestVersion = entry?.update?.latestVersion;
      if (!latestVersion) return;
      const response = await desktopApi?.acknowledgeAcpAgentUpdate?.({
        action,
        backendId: "acp:grok",
        latestVersion,
      });
      if (response?.applied && response.update) {
        setEntry((current) =>
          current ? { ...current, update: response.update } : current,
        );
        setClock(now());
      }
    },
    [desktopApi, entry?.update?.latestVersion, now],
  );

  const notice = useMemo(() => buildGrokCliUpdateNotice({
    entry,
    now: clock,
    onCopy: () => {
      void desktopApi?.copyText?.("grok update");
    },
    onDismiss: () => {
      void acknowledge("dismiss");
    },
    onSnooze: () => {
      void acknowledge("snooze");
    },
  }), [acknowledge, clock, desktopApi, entry]);

  useEffect(() => {
    onNoticeChanged(notice);
  }, [notice, onNoticeChanged]);

  return null;
}

export function buildGrokCliUpdateNotice(params: {
  entry?: AcpAgentSettingsEntry;
  now: number;
  onCopy: () => void;
  onDismiss: () => void;
  onSnooze: () => void;
}): AppNoticeToastNotice | undefined {
  const update = params.entry?.update;
  if (
    params.entry?.registryId !== "grok"
    || update?.status !== "available"
    || !update.latestVersion
    || update.dismissedAt !== undefined
    || (update.snoozedUntil ?? 0) > params.now
  ) {
    return undefined;
  }
  return {
    id: `acp-update:acp:grok:${update.latestVersion}`,
    autoDismiss: false,
    title: "Grok update available",
    message: `Grok ${update.latestVersion} is available; ${update.currentVersion} is installed.`,
    detail: "Run grok update in a terminal, then restart active Grok sessions.",
    copyText: "grok update",
    tone: "warning",
    actions: [
      { label: "Copy command", onClick: params.onCopy, tone: "primary" },
      { label: "Tomorrow", onClick: params.onSnooze },
      { label: "Dismiss version", onClick: params.onDismiss },
    ],
  };
}
