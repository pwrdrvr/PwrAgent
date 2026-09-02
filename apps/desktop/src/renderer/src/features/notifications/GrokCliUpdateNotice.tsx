import { useCallback, useEffect, useMemo, useState } from "react";
import type { AcpAgentSettingsEntry } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  managedGrokReleaseUrl,
  XAI_GROK_UPDATE_URL,
} from "../../lib/grok-build-channel";
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

  const openUpdatePage = useCallback((url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  // The two channels are mutually exclusive by construction: the managed
  // notice needs a PwrAgent build to be active, and the vendor notice refuses
  // to render for one. Ordering here only decides which wins if that ever
  // stops being true, and the channel PwrAgent owns should win.
  const notice = useMemo(() => (
    buildManagedGrokBuildNotice({
      entry,
      onOpenReleasePage: openUpdatePage,
    })
    ?? buildXaiGrokCliUpdateNotice({
      entry,
      now: clock,
      onOpenUpdatePage: openUpdatePage,
      onDismiss: () => {
        void acknowledge("dismiss");
      },
      onSnooze: () => {
        void acknowledge("snooze");
      },
    })
  ), [acknowledge, clock, entry, openUpdatePage]);

  useEffect(() => {
    onNoticeChanged(notice);
  }, [notice, onNoticeChanged]);

  return null;
}

/**
 * The PwrAgent-built Grok channel has exactly one state worth interrupting
 * for: a newer verified build is installed and something is holding an older
 * one in place for new threads. Every other state resolves itself — PwrAgent
 * downloads and installs the newest build on its own — so a "an update is
 * available" prompt on this channel would ask the operator to do work PwrAgent
 * has already done.
 */
export function buildManagedGrokBuildNotice(params: {
  entry?: AcpAgentSettingsEntry;
  onOpenReleasePage: (url: string) => void;
}): AppNoticeToastNotice | undefined {
  const managed = params.entry?.managedBuild;
  if (
    params.entry?.registryId !== "grok"
    || params.entry.pwrAgentManagedRuntime !== true
    || managed?.pinnedBehind !== true
    || !managed.installedTag
    || !managed.activeTag
  ) {
    return undefined;
  }
  return {
    id: `managed-grok-build:${managed.installedTag}`,
    autoDismiss: false,
    title: "PwrAgent Grok build update not in use",
    message:
      `${managed.installedTag} is verified and installed, but a manual path`
      + ` pins ${managed.activeTag}, so new threads keep using the older build.`,
    detail:
      "Clear the manual path in Settings → AI Providers → Grok to follow the"
      + " newest build. Running threads keep the build they started on.",
    tone: "warning",
    actions: [
      {
        label: "Release notes",
        onClick: () => params.onOpenReleasePage(
          managedGrokReleaseUrl(managed.repository, managed.installedTag ?? ""),
        ),
        tone: "primary",
      },
    ],
  };
}

/**
 * The vendor channel: an xAI install the operator updates themselves from
 * x.ai/build. It must never render against a PwrAgent build — those carry
 * `-pwragent` versions from a different publisher, and pairing one with an xAI
 * version number in the same sentence is the confusion this split exists to
 * end.
 */
export function buildXaiGrokCliUpdateNotice(params: {
  entry?: AcpAgentSettingsEntry;
  now: number;
  onOpenUpdatePage: (url: string) => void;
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
    // The notice is durable (`autoDismiss: false`), so a status that no longer
    // describes the runtime in effect would sit on screen until the operator
    // clicked it. Show it only for a vendor install whose installed version
    // still matches the version the check ran against.
    || params.entry.pwrAgentManagedRuntime === true
    || (params.entry.version !== undefined
      && params.entry.version !== update.currentVersion)
  ) {
    return undefined;
  }
  return {
    id: `acp-update:acp:grok:${update.latestVersion}`,
    autoDismiss: false,
    title: "xAI Grok CLI update available",
    message:
      `xAI Grok ${update.latestVersion} is available;`
      + ` your xAI install is ${update.currentVersion}.`,
    detail:
      "PwrAgent does not update this build. Update it from x.ai/build, then"
      + " restart active Grok sessions.",
    onDismiss: params.onDismiss,
    tone: "warning",
    actions: [
      {
        label: "Open x.ai/build",
        onClick: () => params.onOpenUpdatePage(XAI_GROK_UPDATE_URL),
        tone: "primary",
      },
      { label: "Tomorrow", onClick: params.onSnooze },
    ],
  };
}
