import { createGitHandoffService } from "@pwragent/federation/git-instance-handoff";
import { runGitCommand } from "./git-executable";

export const { handoffRepositoryIdentity, exportGitHandoff, assertGitHandoffUnchanged, prepareGitHandoff, importGitHandoff } = createGitHandoffService(
  (cwd, args, options) => runGitCommand(cwd, args, options),
);
