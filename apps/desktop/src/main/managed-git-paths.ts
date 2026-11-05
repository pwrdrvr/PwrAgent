import path from "node:path";
import { resolvePwragentRoot } from "./profile";

/**
 * Where PwrAgent keeps the PwrDrvr Git releases the operator downloaded.
 * One root per PwrAgent root, shared by every profile; PwrGit keeps its own.
 */
export function managedGitRoot(): string {
  return path.join(resolvePwragentRoot(), "runtimes", "git");
}
