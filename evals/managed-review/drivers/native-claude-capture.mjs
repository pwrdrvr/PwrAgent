const commit = /^[0-9a-f]{40}$/;
const sourceKey = /^toolu_[A-Za-z0-9_-]+$/;
const efforts = new Set(["low", "medium", "high", "xhigh", "max"]);

export function nativeClaudeReviewCommand(base, head, effort) {
  if (!commit.test(base) || !commit.test(head) || base === head || !efforts.has(effort)) {
    throw new Error("Native Claude review requires distinct pinned commits and a local review effort.");
  }
  return `/code-review ${effort} ${base}..${head}`;
}

export function isNativeClaudeSourceKey(value) {
  return typeof value === "string" && sourceKey.test(value);
}

export function nativeClaudeCaptureKey(threadId, key) {
  return JSON.stringify([threadId, key]);
}

export function nativeClaudeCapturedRange(payload, cell) {
  const capture = cell?.nativeClaude;
  if (!capture || cell.status !== "completed" || cell.structured !== true
    || cell.arm !== "claude-native" || cell.backend !== "claude"
    || payload.origin !== "automatic" || payload.backend !== "claude"
    || !isNativeClaudeSourceKey(capture.sourceKey) || capture.sourceKey !== payload.sourceKey
    || typeof cell.parentThreadId !== "string" || cell.parentThreadId !== payload.threadId
    || cell.reviewThreadId !== cell.parentThreadId || typeof cell.turnId !== "string" || !cell.turnId
    || !Number.isSafeInteger(cell.prNumber) || cell.prNumber <= 0
    || typeof cell.workspacePath !== "string" || cell.workspacePath !== payload.context?.workspacePath
    || !Number.isSafeInteger(capture.dispatchedAt) || capture.dispatchedAt <= 0
    || !Number.isSafeInteger(payload.createdAt) || payload.createdAt < capture.dispatchedAt) {
    return null;
  }
  try {
    if (capture.command !== nativeClaudeReviewCommand(cell.mergeBaseCommit, cell.headCommit, cell.reasoningEffort)) {
      return null;
    }
  } catch {
    return null;
  }
  return { pr: cell.prNumber, baseCommit: cell.mergeBaseCommit, headCommit: cell.headCommit };
}

export function nativeClaudeCaptureMatchesTranscript(cell, entries) {
  const capture = cell.nativeClaude;
  const turnId = cell.turnId;
  const userMessages = entries.filter((entry) =>
    entry.type === "message" && entry.role === "user" && entry.turn?.id === turnId);
  const artifact = entries.find((entry) => entry.type === "review" && entry.turn?.id === turnId
    && entry.id === capture.sourceKey && entry.reviewer?.backend === "claude"
    && Array.isArray(entry.output?.findings));
  return userMessages.length === 1 && userMessages[0].text === capture.command
    && Number.isSafeInteger(userMessages[0].createdAt) && userMessages[0].createdAt >= capture.dispatchedAt
    && Boolean(artifact && Number.isSafeInteger(artifact.createdAt) && artifact.createdAt >= userMessages[0].createdAt)
    && entries.some((entry) => entry.turnId === turnId && entry.status === "completed");
}
