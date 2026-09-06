import { useCallback, useEffect, useRef } from "react";
import type { AppServerBackendKind, NavigationQueryPage } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { NavigationMetadataBudget, NAVIGATION_METADATA_MAX_RETAINED_BYTES } from "./navigation-metadata-budget";
import { readNavigationQueryRange } from "./read-navigation-query-range";

const previewBudget = new NavigationMetadataBudget();
let nextPreview = 0;

/** Explicit operator preview: read compact metadata through the shared query pool. */
async function readSettingsMetadata(
  api: DesktopApi,
  kind: "directory-index" | "model-inventory",
  backend?: AppServerBackendKind,
  signal?: AbortSignal,
): Promise<NavigationQueryPage> {
  if (!api.getNavigationQueryPage || !api.releaseNavigationQuery) {
    throw new Error("Settings previews require bounded navigation support. Upgrade this instance.");
  }
  const consumerId = `settings-preview:${++nextPreview}`;
  const lease = previewBudget.begin(consumerId);
  const release = () => { void api.releaseNavigationQuery!(consumerId).catch(() => {}); };
  signal?.addEventListener("abort", release, { once: true });
  try {
    const page = await readNavigationQueryRange({
      request: { protocol: 2, consumer: "settings", backend, query: { kind }, pageSize: 100 },
      read: (request) => api.getNavigationQueryPage!(request, consumerId),
      isCancelled: () => signal?.aborted ?? false,
      maxBytes: NAVIGATION_METADATA_MAX_RETAINED_BYTES,
      reserveBytes: lease.reserve,
      releaseBytes: lease.unreserve,
    });
    if (page.coverage.state !== "complete") throw new Error("Provider inventory is incomplete. Retry after providers finish loading.");
    if (kind === "model-inventory" && !page.modelGroups) throw new Error("The owner is missing model inventory support. Upgrade that instance.");
    return page;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Settings preview cancelled.", "AbortError");
    throw error;
  } finally {
    signal?.removeEventListener("abort", release);
    release();
    lease.dispose();
  }
}

export async function readNavigationLaunchpadKeys(api: DesktopApi, backend?: AppServerBackendKind, signal?: AbortSignal): Promise<string[]> {
  const page = await readSettingsMetadata(api, "directory-index", undefined, signal);
  return (page.directories ?? [])
    .filter((directory) => directory.launchpadPresent && (!backend || directory.launchpadBackend === backend))
    .map((directory) => directory.key);
}

export async function readNavigationModelInventory(api: DesktopApi, backend: AppServerBackendKind, signal?: AbortSignal) {
  const page = await readSettingsMetadata(api, "model-inventory", backend, signal);
  return page.modelGroups ?? [];
}


export function isNavigationPreviewCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Each settings surface admits one preview and releases it when replaced or closed. */
export function useNavigationSettingsPreview(api?: DesktopApi) {
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { pending.current?.abort(); }, [api]);
  const begin = useCallback(() => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    return controller.signal;
  }, []);
  const readLaunchpadKeys = useCallback(async (backend?: AppServerBackendKind) => {
    if (!api) throw new Error("Settings previews require the desktop bridge.");
    return readNavigationLaunchpadKeys(api, backend, begin());
  }, [api, begin]);
  const readModelInventory = useCallback(async (backend: AppServerBackendKind) => {
    if (!api) throw new Error("Settings previews require the desktop bridge.");
    return readNavigationModelInventory(api, backend, begin());
  }, [api, begin]);
  return { readLaunchpadKeys, readModelInventory };
}
