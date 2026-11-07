import type { NavigationThreadSummary } from "@pwragent/shared";

/**
 * The machine a search row lives on, named relative to another owner (a
 * to-do card's, or a waiting thread's): `{}` for that owner itself,
 * `{ instanceId }` for another machine, or nothing when this window cannot
 * name it. That happens for a thread on this machine while the owner is a
 * peer and this window does not know its own machine id.
 *
 * A row names its owner relative to this window (`federation.ref.target`, or
 * nothing for this machine). `ownerInstanceId` names the other owner the same
 * way: absent for this machine.
 */
export function threadMachineFrom(
  thread: NavigationThreadSummary,
  ownerInstanceId: string | undefined,
  localInstanceId: string | undefined,
): { instanceId?: string } | undefined {
  const ref = thread.federation?.ref.target;
  const instanceId = ref?.scope === "remote" ? ref.instanceId : localInstanceId;
  if (ownerInstanceId && !instanceId) return undefined;
  const elsewhere = instanceId !== ownerInstanceId && (ownerInstanceId !== undefined || ref?.scope === "remote");
  return elsewhere && instanceId ? { instanceId } : {};
}
