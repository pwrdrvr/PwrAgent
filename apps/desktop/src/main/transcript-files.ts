import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isFilePreviewPath,
  navigationWorkingStatePath,
  transcriptFileReference,
  type AppServerThreadSummary,
  type ResolveTranscriptFilesRequest,
  type ResolveTranscriptFilesResponse,
} from "@pwragent/shared";

export function transcriptThreadDirectories(thread: AppServerThreadSummary): string[] {
  return [...new Set([
    navigationWorkingStatePath(thread),
    thread.projectKey,
    ...thread.linkedDirectories.flatMap((directory) => [directory.worktreePath, directory.path]),
  ].filter((directory): directory is string => Boolean(directory && path.isAbsolute(directory))))];
}

/** Metadata only: never read file contents or persist hydration in SQLite. */
export async function resolveTranscriptFiles(
  request: ResolveTranscriptFilesRequest,
  directories: string[],
  restrictToDirectories = false,
): Promise<ResolveTranscriptFilesResponse> {
  if (!Array.isArray(request.references) || request.references.length > 128
    || request.references.some((reference) => typeof reference !== "string")) {
    throw new Error("At most 128 file references may be resolved at once.");
  }
  directories = directories.filter((directory) => path.isAbsolute(directory));
  const roots = restrictToDirectories
    ? await Promise.all(directories.map((directory) => realpath(directory).catch(() => undefined)))
    : [];
  const files: ResolveTranscriptFilesResponse["files"] = [];
  // Bounded sequential stats avoid a filesystem fan-out on a large transcript.
  for (const reference of new Set(request.references)) {
    const candidate = transcriptFileReference(reference);
    if (!candidate) continue;
    const expanded = candidate.path.startsWith("~/") || candidate.path.startsWith("~\\")
      ? path.join(os.homedir(), candidate.path.slice(2))
      : candidate.path;
    const target = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : directories[0] ? path.resolve(directories[0], expanded) : undefined;
    if (!target) continue;
    try {
      const resolved = await realpath(target);
      if (restrictToDirectories && !roots.some((root) => {
        if (!root) return false;
        const relative = path.relative(root, resolved);
        return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      })) continue;
      if (!(await stat(resolved)).isFile()) continue;
      files.push({
        ...candidate,
        reference,
        path: target,
        previewable: isFilePreviewPath(target) && isFilePreviewPath(resolved),
      });
    } catch {
      // Missing files and directories retain their original inline-code rendering.
    }
  }
  return { files };
}
