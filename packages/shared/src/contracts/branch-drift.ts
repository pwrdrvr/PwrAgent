export function isBranchDrifted(
  expected: string | undefined,
  observed: string | undefined,
): boolean {
  if (!expected || !observed) return false;
  if (observed === "HEAD") return false;
  return expected !== observed;
}
