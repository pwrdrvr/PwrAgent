import { useEffect, useState } from "react";
import type { FederationThreadTarget } from "./federation-thread-targets";
import type { FederationTargetProjectState } from "./FederationTargetMenuSection";
import type { ProjectIdentity } from "../../lib/federation-project-match";

export type FederationProjectDirectory = ProjectIdentity;

export type CheckFederationTargetProject = (
  instanceId: string,
  directory: FederationProjectDirectory,
) => Promise<boolean>;

/**
 * Ask each reachable peer, once per menu opening, whether it has the
 * project the menu was opened from. Workspaces always exist, so a
 * Workspaces row, or no directory at all, asks nothing.
 *
 * A failed check reads as `present`: the open resolves the project again
 * and reports a real miss, while a menu that greyed out a machine because
 * one query timed out would block a launch that would have worked.
 */
export function useFederationProjectStates(params: {
  check?: CheckFederationTargetProject;
  directory?: FederationProjectDirectory;
  open: boolean;
  targets: readonly FederationThreadTarget[];
}): Record<string, FederationTargetProjectState> | undefined {
  const { check, directory, open, targets } = params;
  const [states, setStates] = useState<
    Record<string, FederationTargetProjectState> | undefined
  >();
  const scoped = Boolean(open && check && directory && directory.kind !== "workspace");
  const directoryLabel = directory?.label;
  const directoryPath = directory?.path;
  const directoryKind = directory?.kind;
  const directoryRepositoryKey = directory?.repositoryKey;
  const availableIds = targets
    .filter((target) => target.availability === "available")
    .map((target) => target.instanceId)
    .join("\n");

  useEffect(() => {
    if (!scoped || !check || directoryLabel === undefined || !directoryKind) {
      setStates(undefined);
      return;
    }
    const ids = availableIds ? availableIds.split("\n") : [];
    const project: FederationProjectDirectory = {
      kind: directoryKind,
      label: directoryLabel,
      ...(directoryPath !== undefined ? { path: directoryPath } : {}),
      ...(directoryRepositoryKey !== undefined
        ? { repositoryKey: directoryRepositoryKey }
        : {}),
    };
    let cancelled = false;
    setStates(Object.fromEntries(ids.map((id) => [id, "checking" as const])));
    for (const id of ids) {
      void check(id, project)
        .then((present) => (present ? "present" as const : "missing" as const))
        .catch(() => "present" as const)
        .then((state) => {
          if (cancelled) return;
          setStates((current) => ({ ...current, [id]: state }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [
    availableIds,
    check,
    directoryKind,
    directoryLabel,
    directoryPath,
    directoryRepositoryKey,
    scoped,
  ]);

  return states;
}
