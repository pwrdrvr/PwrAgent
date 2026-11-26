import path from "node:path";

const localPath = /(?<![\w./-])\/(?:Users|home|root|private|tmp|var|Volumes|mnt|etc|opt|workspaces?)(?=\/|$)[^\s"'`<>)\]]*|(?<![\w])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'`<>)\]]*/gi;
const quotedUnixPath = /(["'`])\/(?:Users|home|root|private|tmp|var|Volumes|mnt|etc|opt|workspaces?)(?:\/[^\r\n]*?)?\1/gi;

export function sanitizeText(value) {
  return typeof value === "string"
    ? value.replace(quotedUnixPath, "$1<local-path>$1").replace(localPath, "<local-path>").trim()
    : "";
}

export function containsMachinePath(value) {
  if (typeof value === "string") return sanitizeText(value) !== value.trim();
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => containsMachinePath(key) || containsMachinePath(child));
}

function relativeLocation(value, roots) {
  if (typeof value !== "string" || !value) return null;
  const windows = /^[A-Za-z]:|^\\\\/.test(value);
  const normalized = value.replace(/\\/g, "/");
  let relative = normalized;
  if (windows || path.posix.isAbsolute(normalized)) {
    relative = "";
    for (const root of roots) {
      if (typeof root !== "string" || !root) continue;
      const prefix = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
      const matches = windows
        ? normalized.toLowerCase().startsWith(prefix.toLowerCase())
        : normalized.startsWith(prefix);
      if (matches) {
        relative = normalized.slice(prefix.length);
        break;
      }
    }
  }
  if (!relative || containsMachinePath(relative)) return null;
  const clean = path.posix.normalize(relative);
  return clean === "." || clean === ".." || clean.startsWith("../") || path.posix.isAbsolute(clean) ? null : clean;
}

const line = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;

export function sanitizeItems(rawItems, context = {}) {
  const roots = [context.workspacePath, context.repositoryPath];
  return (Array.isArray(rawItems) ? rawItems : []).map((item, index) => ({
    id: item.id || "item-" + (index + 1),
    title: sanitizeText(item.title),
    body: sanitizeText(item.body),
    priority: typeof item.priority === "number" ? item.priority : null,
    status: item.status || "open",
    file: relativeLocation(item.codeLocation?.absolute_file_path ?? item.codeLocation?.absoluteFilePath
      ?? item.file ?? item.location?.file, roots),
    startLine: line(item.codeLocation?.line_range?.start ?? item.codeLocation?.lineRange?.start
      ?? item.startLine ?? item.location?.startLine),
    endLine: line(item.codeLocation?.line_range?.end ?? item.codeLocation?.lineRange?.end
      ?? item.endLine ?? item.location?.endLine),
  }));
}

export function baselineProvenance(payload) {
  // Automatic imports come from completed provider artifacts. Managed review
  // artifacts use "managed-review:<turnId>:result" regardless of the parent.
  // Codex native exit items carry UUIDs. Claude ReportFindings uses its tool ID.
  if (payload.origin !== "automatic" || typeof payload.sourceKey !== "string") return null;
  if (payload.backend === "codex" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(payload.sourceKey)) {
    return { backend: "codex", reviewMode: "codex-native" };
  }
  if (payload.backend === "claude" && /^toolu_[A-Za-z0-9_-]+$/.test(payload.sourceKey)) {
    return { backend: "claude", reviewMode: "claude-code-review" };
  }
  return null;
}

export function hasVerifiedBaselineRange(baseline) {
  return baseline.reviewedRangeVerified === true
    && ((baseline.reviewMode === "codex-native" && baseline.rangeEvidence === "codex-pr-snapshot")
      || (baseline.reviewMode === "claude-code-review" && baseline.rangeEvidence === "claude-native-dispatch"));
}

export function capturedRange(context) {
  if (context.reviewedTree || (context.pullRequests?.length ?? 0) > 1
    || (context.pullRequestSnapshots?.length ?? 0) > 1) return null;
  const snapshot = context.pullRequestSnapshot;
  if (!snapshot) return null;
  const match = /^https:\/\/github\.com\/pwrdrvr\/PwrAgent\/pull\/([1-9]\d*)\/?$/i.exec(snapshot.pullRequest?.url ?? "");
  const { mergeBaseCommit: baseCommit, headCommit } = snapshot;
  const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
  if (!match || !sha(snapshot.baseCommit) || !sha(baseCommit) || !sha(headCommit) || baseCommit === headCommit
    || (context.baseCommit && context.baseCommit !== baseCommit)
    || (context.headCommit && context.headCommit !== headCommit)) return null;
  return { pr: Number(match[1]), baseCommit, headCommit };
}
