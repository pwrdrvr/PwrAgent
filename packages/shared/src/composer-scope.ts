import type { ComposerThreadOwner } from "./contracts/composer-drafts";
import { isAppServerBackendKind } from "./contracts/navigation";

const PREFIX = "thread:v2:";

/** Explicit local/remote ownership is part of the storage identity, including same-id peers. */
export function buildOwnedComposerScopeKey(owner: ComposerThreadOwner): string {
  if (!owner || typeof owner.backend !== "string" || !isAppServerBackendKind(owner.backend)
    || typeof owner.threadId !== "string" || !owner.threadId
    || !owner.target || (owner.target.scope !== "local" && owner.target.scope !== "remote")
    || (owner.target.scope === "remote" && (typeof owner.target.instanceId !== "string" || !owner.target.instanceId))) {
    throw new Error("A composer scope requires an explicit valid thread owner.");
  }
  return PREFIX + encodeURIComponent(JSON.stringify([
    owner.target.scope === "remote" ? owner.target.instanceId : null, owner.backend, owner.threadId,
  ]));
}

export function parseOwnedComposerScopeKey(scopeKey: string): ComposerThreadOwner | undefined {
  if (!scopeKey.startsWith(PREFIX)) return undefined;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(scopeKey.slice(PREFIX.length)));
    if (!Array.isArray(value) || value.length !== 3) return undefined;
    const [instanceId, backend, threadId] = value;
    if ((instanceId !== null && (typeof instanceId !== "string" || !instanceId))
      || !isAppServerBackendKind(backend) || typeof threadId !== "string" || !threadId) return undefined;
    return { backend, threadId, target: instanceId === null ? { scope: "local" } : { scope: "remote", instanceId } };
  } catch { return undefined; }
}
