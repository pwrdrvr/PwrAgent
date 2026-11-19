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

/**
 * Whether a file is the thread's own work: inside one of its directories, or
 * in the scratchpad Claude Code keeps for the session. Claude Code puts that
 * at `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>/<cwd key>/<session id>/scratchpad`,
 * and a PwrAgent Claude thread's id is its session id.
 *
 * `resolved` must already be a real path.
 */
export async function isThreadWorkspaceFile(
  resolved: string,
  thread: AppServerThreadSummary,
  options: { tmpRoot?: string; uid?: number } = {},
): Promise<boolean> {
  const roots = await Promise.all(
    transcriptThreadDirectories(thread).map((directory) => realpath(directory).catch(() => undefined)),
  );
  if (roots.some((root) => root !== undefined && isInside(root, resolved))) return true;
  const uid = options.uid ?? process.getuid?.();
  if (thread.source !== "claude" || uid === undefined) return false;
  const tmpRoot = options.tmpRoot ?? process.env.CLAUDE_CODE_TMPDIR ?? "/tmp";
  const sessions = await realpath(path.join(tmpRoot, `claude-${uid}`)).catch(() => undefined);
  if (!sessions || !isInside(sessions, resolved)) return false;
  const [, sessionId, folder, ...rest] = path.relative(sessions, resolved).split(path.sep);
  return sessionId === thread.id && folder === "scratchpad" && rest.length > 0;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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
