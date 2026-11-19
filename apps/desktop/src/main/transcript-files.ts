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
 * in a scratchpad Claude Code kept for a session run in one of them. Claude
 * Code puts that at
 * `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>/<cwd key>/<session id>/scratchpad`.
 * The session id is matched loosely: a rewound, restarted or forked thread
 * runs under a new one.
 *
 * `resolved` must already be a real path.
 */
export async function isThreadWorkspaceFile(
  resolved: string,
  thread: AppServerThreadSummary,
  options: { tmpRoot?: string; uid?: number } = {},
): Promise<boolean> {
  const directories = transcriptThreadDirectories(thread);
  const roots = await Promise.all(directories.map((directory) => realpath(directory).catch(() => undefined)));
  if (roots.some((root) => root !== undefined && isInside(root, resolved))) return true;
  const uid = options.uid ?? process.getuid?.();
  if (thread.source !== "claude" || uid === undefined) return false;
  const tmpRoot = options.tmpRoot ?? process.env.CLAUDE_CODE_TMPDIR ?? "/tmp";
  const sessions = await realpath(path.join(tmpRoot, `claude-${uid}`)).catch(() => undefined);
  if (!sessions || !isInside(sessions, resolved)) return false;
  const [cwdKey = "", , folder, ...rest] = path.relative(sessions, resolved).split(path.sep);
  if (folder !== "scratchpad" || rest.length === 0) return false;
  const cwds = [...directories, ...roots].filter((cwd): cwd is string => Boolean(cwd));
  return cwds.some((cwd) => matchesClaudeCwdKey(cwdKey, cwd));
}

/** Claude Code names a cwd's folders with every non-alphanumeric as `-`, cut and hashed past 200. */
function matchesClaudeCwdKey(key: string, cwd: string): boolean {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return key === sanitized
    || (sanitized.length > 200 && key.startsWith(`${sanitized.slice(0, 200)}-`));
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
      if (restrictToDirectories && !roots.some((root) => root !== undefined && isInside(root, resolved))) continue;
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
