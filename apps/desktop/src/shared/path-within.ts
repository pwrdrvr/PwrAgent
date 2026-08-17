import path from "node:path";

/**
 * True when `candidate` is a strict descendant of `root`.
 *
 * `root` itself is not "within" itself, and neither operand is resolved
 * against the filesystem — pass realpaths when symlinks must not escape the
 * boundary.
 */
export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0
    && !relative.startsWith("..")
    && !path.isAbsolute(relative)
  );
}
