import { useEffect, useId, useRef, useState } from "react";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type {
  HandoffThreadWorkspaceRequest,
  ThreadWorkspaceHandoffStrategy,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { DesktopApi } from "../../lib/desktop-api";
import type { NavigationDirectoryView as NavigationDirectorySummary } from "../../lib/navigation-loaded-rows";
import { useNavigationQueryResource } from "../../lib/useNavigationQueryResource";

// "fresh-from-base" starts a new worktree at another branch and moves nothing.
type LocalHandoffStrategy = ThreadWorkspaceHandoffStrategy | "fresh-from-base";

export function useComposerWorkspaceHandoffState({
  desktopApi,
  filesystemFederationTarget,
  filesystemAuthorityKey,
}: {
  desktopApi?: DesktopApi;
  filesystemFederationTarget?: FederationTarget;
  filesystemAuthorityKey: string;
}) {
  const [handoffDialog, setHandoffDialog] = useState<
    HandoffThreadWorkspaceRequest["direction"] | undefined
  >();
  const [localHandoffStrategy, setLocalHandoffStrategy] =
    useState<LocalHandoffStrategy>("detached-changes");
  // Handoff to Local: keep the main checkout's branch (the default), or move
  // the worktree's branch into it as before.
  const [worktreeHandoffStrategy, setWorktreeHandoffStrategy] =
    useState<"keep-local-branch" | "move-branch">("keep-local-branch");
  const [leaveLocalBranch, setLeaveLocalBranch] = useState("");
  const [newLocalBranch, setNewLocalBranch] = useState("");
  // Empty until the operator picks one; the default follows the branch list.
  const [pickedFreshBaseRef, setFreshBaseRef] = useState("");
  const [freshBranchName, setFreshBranchName] = useState("");
  const [projectTargetPath, setProjectTargetPath] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const projectDestinations = useNavigationQueryResource({
    desktopApi,
    active: handoffDialog === "to-project",
    request: {
      protocol: 2,
      consumer: "mentions",
      query: { kind: "directory-index", filter: projectSearch },
      pageSize: 10,
      federationTarget: filesystemFederationTarget,
    },
  });
  const destinationOwner = projectDestinations.state?.request.federationTarget;
  const destinationOwnerKey = destinationOwner?.scope === "remote"
    ? `remote:${destinationOwner.instanceId}` : "local";
  const projectDestinationsLoaded = destinationOwnerKey === filesystemAuthorityKey
    && projectDestinations.state?.page !== undefined;
  // A new search resets the resource to a page-less state, so keep the
  // owner's last answer on screen until the next one lands. The combobox
  // narrows it by the typed text meanwhile, instead of the list blanking on
  // every keystroke while a peer answers.
  const settledProjectDirectoriesRef = useRef<{
    authorityKey: string;
    directories: NavigationDirectorySummary[];
  } | undefined>(undefined);
  if (projectDestinationsLoaded) {
    settledProjectDirectoriesRef.current = {
      authorityKey: filesystemAuthorityKey,
      directories: projectDestinations.state?.page?.directories ?? [],
    };
  }
  const projectDirectories = projectDestinationsLoaded
    ? settledProjectDirectoriesRef.current?.directories ?? []
    : settledProjectDirectoriesRef.current?.authorityKey === filesystemAuthorityKey
      ? settledProjectDirectoriesRef.current.directories
      : [];
  const projectDestinationInputId = useId();
  useEffect(() => {
    setHandoffDialog(undefined);
    setProjectTargetPath("");
  }, [filesystemAuthorityKey]);

  const [handoffError, setHandoffError] = useState<string | undefined>();
  const [handoffSubmitting, setHandoffSubmitting] = useState(false);

  return {
    handoffDialog,
    setHandoffDialog,
    localHandoffStrategy,
    setLocalHandoffStrategy,
    worktreeHandoffStrategy,
    setWorktreeHandoffStrategy,
    leaveLocalBranch,
    setLeaveLocalBranch,
    newLocalBranch,
    setNewLocalBranch,
    pickedFreshBaseRef,
    setFreshBaseRef,
    freshBranchName,
    setFreshBranchName,
    projectTargetPath,
    setProjectTargetPath,
    setProjectSearch,
    projectDestinations,
    projectDestinationsLoaded,
    projectDirectories,
    projectDestinationInputId,
    handoffError,
    setHandoffError,
    handoffSubmitting,
    setHandoffSubmitting,
  };
}
