/**
 * Codex reports one requirement problem twice: once as the app-server
 * `configWarning` banner and again as a thread-scoped `warning` toast with
 * the same text. Both surfaces share `experimental.codexConfigWarningsDismissed`
 * so one "Don't show again" silences the text on either surface.
 *
 * Each saved id is a JSON tuple:
 * `[summary, details, trustedProjectPath, configPath, remoteInstanceId]`.
 * A thread warning carries only its message, so it saves the tuple with the
 * middle fields empty, and it matches any saved id with the same summary and
 * instance (`isCodexWarningSuppressed`). The banner matches its exact id or
 * that summary-only id.
 */
export function codexWarningSuppressionId(params: {
  summary: string;
  details?: string | null;
  trustedProjectPath?: string;
  configPath?: string;
  remoteInstanceId?: string;
}): string {
  return JSON.stringify([
    params.summary,
    params.details ?? "",
    params.trustedProjectPath ?? "",
    params.configPath ?? "",
    params.remoteInstanceId ?? "",
  ]);
}

export function isCodexWarningSuppressed(
  dismissedIds: readonly string[] | undefined,
  summary: string,
  remoteInstanceId?: string,
): boolean {
  if (!dismissedIds?.length) {
    return false;
  }
  return dismissedIds.some((id) => {
    const parsed = parseSuppressionId(id);
    return parsed !== undefined
      && parsed.summary === summary
      && parsed.remoteInstanceId === (remoteInstanceId ?? "");
  });
}

function parseSuppressionId(
  id: string,
): { summary: string; remoteInstanceId: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(id);
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") {
      return undefined;
    }
    return {
      summary: parsed[0],
      remoteInstanceId: typeof parsed[4] === "string" ? parsed[4] : "",
    };
  } catch {
    return undefined;
  }
}
