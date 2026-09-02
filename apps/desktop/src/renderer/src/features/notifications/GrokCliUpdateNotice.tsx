import { useCallback, useEffect, useMemo, useState } from "react";
import type { AcpAgentSettingsEntry } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  managedGrokReleaseUrl,
  XAI_GROK_UPDATE_URL,
} from "../../lib/grok-build-channel";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

/**
 * Every durable notice id this producer can emit, as prefixes. The host sweeps
 * these before showing the current notice, so a notice whose condition has
 * cleared leaves the screen. A new id family that is not listed here would
 * never be swept and would outlive the state it describes.
 */
export const GROK_UPDATE_NOTICE_ID_PREFIXES = [
  "acp-update:acp:grok:",
  "managed-grok-build:",
] as const;

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

  // The vendor-update event above never fires on a machine running a PwrAgent
  // build — `refreshGrokUpdateStatusInBackground` returns before emitting it
  // for exactly those runtimes — so the managed-build notice would otherwise
  // evaluate only at mount, and could neither appear when a pin arises nor
  // clear when the operator fixes one. The settings pane raises this event
  // after every discovery refresh, which is what "Use newest build", "Check
  // for updates" and the build toggle all run.
  useEffect(() => {
    const onRefreshed = () => {
      void refresh().catch(() => undefined);
    };
    window.addEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, onRefreshed);
    return () => {
      window.removeEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, onRefreshed);
    };
  }, [refresh]);

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

  // The managed channel has no persisted acknowledgement of its own — the
  // vendor notice's `dismissedAt`/`snoozedUntil` live on `AcpAgentUpdateStatus`,
  // which describes the other channel. Without this, closing the toast would
  // only drop it from the host's in-memory list and the next refresh would
  // upsert the identical id straight back. Held per tag, so a newer verified
  // build asks again; held in memory, so an unresolved pin asks again at the
  // next launch.
  const [dismissedManagedTag, setDismissedManagedTag] = useState<string>();

  // The two channels are mutually exclusive by construction: the managed
  // notice needs a PwrAgent build to be active, and the vendor notice refuses
  // to render for one. Ordering here only decides which wins if that ever
  // stops being true, and the channel PwrAgent owns should win.
  const notice = useMemo(() => (
    buildManagedGrokBuildNotice({
      dismissedTag: dismissedManagedTag,
      entry,
      onDismiss: setDismissedManagedTag,
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
  ), [acknowledge, clock, dismissedManagedTag, entry, openUpdatePage]);

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
  /** Tag the operator has already closed this notice for, this session. */
  dismissedTag?: string;
  entry?: AcpAgentSettingsEntry;
  onDismiss: (tag: string) => void;
  onOpenReleasePage: (url: string) => void;
}): AppNoticeToastNotice | undefined {
  const managed = params.entry?.managedBuild;
  const installedTag = managed?.installedTag;
  const activeTag = managed?.activeTag;
  if (
    params.entry?.registryId !== "grok"
    || params.entry.pwrAgentManagedRuntime !== true
    || managed?.pinnedBehind !== true
    || !installedTag
    || !activeTag
    || installedTag === params.dismissedTag
  ) {
    return undefined;
  }
  return {
    id: `managed-grok-build:${installedTag}`,
    autoDismiss: false,
    title: "PwrAgent Grok build update not in use",
    message:
      `${installedTag} is verified and installed, but a manual path`
      + ` pins ${activeTag}, so new threads keep using the older build.`,
    detail:
      "Clear the manual path in Settings → AI Providers → Grok to follow the"
      + " newest build. Running threads keep the build they started on.",
    onDismiss: () => params.onDismiss(installedTag),
    tone: "warning",
    actions: [
      {
        label: "Release notes",
        onClick: () => params.onOpenReleasePage(
          managedGrokReleaseUrl(managed.repository, installedTag),
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
