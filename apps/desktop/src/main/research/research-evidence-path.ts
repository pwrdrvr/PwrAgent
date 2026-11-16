import { realpath } from "node:fs/promises";
import path from "node:path";

/** Resolve stored evidence within its author's actual workspace, including symlinks. */
export async function resolveResearchEvidencePath(workspace: string, relativePath: string): Promise<string> {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((s) => !s || s === "." || s === "..")) throw new Error("Invalid evidence path");
  const [root, file] = await Promise.all([realpath(workspace), realpath(path.resolve(workspace, relativePath))]);
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Evidence is outside its worker workspace");
  return file;
}
