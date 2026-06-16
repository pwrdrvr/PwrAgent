import type {
  DesktopApplicationDiscoveryCandidate,
  DesktopApplicationsSnapshot,
} from "@pwragent/shared";

/**
 * Resolve the editor to use for "open in editor" affordances: the
 * operator-configured editor when it can open a workspace, otherwise the
 * first openable editor discovered. Mirrors the resolution used for
 * transcript file links and edited-file opens so every surface agrees on
 * which editor (and therefore which icon) represents "the editor."
 */
export function resolvePreferredEditor(
  applications: DesktopApplicationsSnapshot | undefined,
): DesktopApplicationDiscoveryCandidate | undefined {
  return (
    applications?.editors.find(
      (application) =>
        application.canOpenWorkspace &&
        application.id === applications?.preferredEditorId.value,
    ) ?? applications?.editors.find((application) => application.canOpenWorkspace)
  );
}
