import type { AppServerBackendKind, NavigationDirectorySummary, NavigationLaunchpadConfiguration, NavigationLaunchpadDefaults, NavigationSnapshot } from "@pwragent/shared";
import type { MessagingBrowseSelectedProject } from "@pwragent/messaging-interface";
import type { MessagingBackendBridge } from "./messaging-adapter";

export type MessagingLaunchpadDirectory = Pick<NavigationDirectorySummary,
  "key" | "kind" | "label" | "path" | "gitStatus" | "localAvailability"
> & { launchpad?: NavigationLaunchpadConfiguration };

/** Configuration for one selected project, without navigation membership or draft text. */
export type MessagingLaunchpadContext = {
  kind: "launchpad";
  launchpadDefaults: NavigationLaunchpadDefaults;
  directory?: MessagingLaunchpadDirectory;
};

export type MessagingNewThreadNavigation = MessagingLaunchpadContext | NavigationSnapshot;

export function isMessagingLaunchpadContext(value: MessagingNewThreadNavigation): value is MessagingLaunchpadContext {
  return "kind" in value && value.kind === "launchpad";
}

export async function readMessagingLaunchpadContext(params: {
  backend: Pick<MessagingBackendBridge, "getNavigationQueryPage" | "getNavigationLaunchpadConfig" | "ensureDirectoryLaunchpad">;
  project?: MessagingBrowseSelectedProject;
  ensureBackend?: AppServerBackendKind;
}): Promise<MessagingLaunchpadContext> {
  const readConfig = params.backend.getNavigationLaunchpadConfig;
  const readPage = params.backend.getNavigationQueryPage;
  if (!readConfig || (params.project && !readPage)) throw new Error("Upgrade this instance to load selected launchpad configuration.");
  const target = params.project?.federationTarget;
  if (params.project && !params.project.directoryKey && params.project.path) {
    const page = await readPage!.call(params.backend, { protocol: 2, consumer: "messaging-browse", federationTarget: target,
      query: { kind: "directory-index", paths: [params.project.path] }, pageSize: 2 });
    if (page.protocol !== 2 || page.unchanged || !page.complete || page.directories?.length !== 1) {
      throw new Error("Select the project again to resolve its exact owner directory identity.");
    }
    return readMessagingLaunchpadContext({ ...params, project: { ...params.project, directoryKey: page.directories[0]!.key } });
  }
  const key = params.project?.directoryKey ?? params.project?.path;
  if (params.project && !key) throw new Error("Select the project again to resolve its owner directory identity.");
  const [configuration, page] = await Promise.all([
    readConfig.call(params.backend, { protocol: 2, directoryKey: key, federationTarget: target }),
    key ? readPage!.call(params.backend, { protocol: 2, consumer: "messaging-browse", federationTarget: target, query: { kind: "directory-index", keys: [key] }, pageSize: 1 }) : undefined,
  ]);
  if (configuration.protocol !== 2 || configuration.unchanged || !configuration.defaults || configuration.directoryKey !== key) {
    throw new Error("Selected launchpad configuration is not ready. Refresh the project before continuing.");
  }
  const descriptor = page?.directories?.find((directory) => directory.key === key);
  if (key && (page?.protocol !== 2 || page.unchanged || !page.complete || !descriptor || descriptor.localAvailability === "unconfigured")) {
    throw new Error("The selected project is no longer available on its owning instance.");
  }
  if (configuration.launchpad && configuration.launchpad.directoryKey !== key) throw new Error("Launchpad configuration belongs to another project.");
  if (params.ensureBackend && descriptor) {
    if (!params.backend.ensureDirectoryLaunchpad) throw new Error("This instance cannot prepare the selected launchpad.");
    await params.backend.ensureDirectoryLaunchpad({ ...(target ? { federationTarget: target } : {}), directoryKey: descriptor.key, directoryKind: descriptor.kind,
      directoryLabel: descriptor.label, directoryPath: descriptor.path, preferredBackend: params.ensureBackend });
    return readMessagingLaunchpadContext({ backend: params.backend, project: params.project });
  }
  return { kind: "launchpad", launchpadDefaults: configuration.defaults,
    directory: descriptor ? { key: descriptor.key, kind: descriptor.kind, label: descriptor.label, path: descriptor.path,
      localAvailability: descriptor.localAvailability, gitStatus: configuration.directoryGitStatus, launchpad: configuration.launchpad } : undefined };
}
