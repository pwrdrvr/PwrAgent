import { useEffect, useMemo, useState } from "react";
import type { FederationThreadTarget } from "./federation-thread-targets";
import type { FederationTargetProjectState } from "./FederationTargetMenuSection";
import type { ProjectIdentity } from "../../lib/federation-project-match";

export type FederationProjectDirectory = ProjectIdentity;

export type CheckFederationTargetProject = (
  instanceId: string,
  directory: FederationProjectDirectory,
) => Promise<boolean>;

/**
 * A check may say more than present or missing: a line the menu shows for
 * the machine, such as the branch a worktree there starts from, and a
 * longer explanation for its tooltip.
 */
export type FederationProjectCheckResult =
  | boolean
  | { present: boolean; detail?: string; title?: string };

export type FederationProjectCheck = {
  state: FederationTargetProjectState;
  detail?: string;
  title?: string;
};

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
  const checks = useFederationProjectChecks(params);
  return useMemo(
    () => checks
      && Object.fromEntries(
        Object.entries(checks).map(([id, check]) => [id, check.state]),
      ),
    [checks],
  );
}

/** `useFederationProjectStates`, keeping each check's detail line. */
export function useFederationProjectChecks(params: {
  check?: (
    instanceId: string,
    directory: FederationProjectDirectory,
  ) => Promise<FederationProjectCheckResult>;
  directory?: FederationProjectDirectory;
  open: boolean;
  targets: readonly Pick<FederationThreadTarget, "availability" | "instanceId">[];
}): Record<string, FederationProjectCheck> | undefined {
  const { check, directory, open, targets } = params;
  const [states, setStates] = useState<
    Record<string, FederationProjectCheck> | undefined
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
    setStates(Object.fromEntries(ids.map((id) => [id, { state: "checking" as const }])));
    for (const id of ids) {
      void check(id, project)
        .then((result): FederationProjectCheck => {
          if (typeof result === "boolean") {
            return { state: result ? "present" : "missing" };
          }
          return {
            state: result.present ? "present" : "missing",
            ...(result.detail !== undefined ? { detail: result.detail } : {}),
            ...(result.title !== undefined ? { title: result.title } : {}),
          };
        })
        .catch((): FederationProjectCheck => ({ state: "present" }))
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
