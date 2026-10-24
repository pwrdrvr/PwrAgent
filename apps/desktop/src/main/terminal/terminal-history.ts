import path from "node:path";
import {
  getProcessRuntimeIdentity,
  isProfileRuntimeIdentityLive,
  resolveActiveProfileDir,
  resolveActiveProfileName,
} from "../profile";
import { TerminalHistoryStore } from "./terminal-history-store";

export function createTerminalHistoryStore(namespace: string): TerminalHistoryStore {
  const profileName = resolveActiveProfileName();
  return new TerminalHistoryStore(path.join(resolveActiveProfileDir(), "state", "terminal-history", namespace), {
    runtime: { ...getProcessRuntimeIdentity(), processId: process.pid },
    isRuntimeLive: (identity) => isProfileRuntimeIdentityLive(profileName, identity),
  });
}
