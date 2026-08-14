import type {
  AppServerBackendKind,
  ThreadToolAccounting,
  ThreadToolAnalysisCoverage,
  ThreadToolInvocationRecord,
} from "./normalized-app-server";

export type OpenToolOutputIncidentExplorerWindowRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  title: string;
};

export type OpenToolOutputIncidentExplorerWindowResponse = {
  opened: true;
};

export type AnalyzeThreadToolHistoryRequest = {
  backend: AppServerBackendKind;
  threadId: string;
};

export type AnalyzeThreadToolHistoryResponse = {
  accounting: ThreadToolAccounting;
  coverage: ThreadToolAnalysisCoverage;
};

export function buildThreadToolIncidentPrompt(params: {
  invocation: ThreadToolInvocationRecord;
  reason: string;
}): string {
  const invocation = params.invocation;
  const identity = invocation.normalizedCommand ?? invocation.toolName;
  const timestamp = new Date(invocation.observedAt).toLocaleString();
  const exitState = invocation.exitCode !== undefined
    ? `${invocation.status} (exit ${invocation.exitCode})`
    : invocation.status;
  const outputState = invocation.outputState
    ?? (invocation.outputTruncated ? "truncated" : "available");
  const evidence = [
    `Invocation: ${identity}`,
    `Observed: ${timestamp}`,
    `Status: ${exitState}`,
    `Output: ${invocation.outputChars.toLocaleString()} characters (~${invocation.estimatedOutputTokens.toLocaleString()} tokens)`,
    `Output state: ${outputState}`,
    `Why flagged: ${params.reason}`,
  ].join("\n");
  return [
    "Reduce the replay-amplifying tool use identified below.",
    evidence,
    guidanceForInvocation(invocation),
    "Report the exact command/tool identity, exit state, concise result, failures or warnings, and only a bounded tail or targeted fields needed for the next decision.",
  ].join("\n\n");
}

function guidanceForInvocation(invocation: ThreadToolInvocationRecord): string {
  if (invocation.category === "file-io") {
    return "For file reads, narrow the file set and request only the specific line ranges needed.";
  }
  if (invocation.category === "search") {
    return "For search, constrain paths and patterns, then cap the number and size of returned matches.";
  }
  if (
    invocation.category === "build-test"
    || invocation.category === "package-manager"
  ) {
    return "For tests, lint, or builds, redirect complete stdout/stderr to a local log and return only failures, warnings, a concise summary, and a bounded tail.";
  }
  if (invocation.category === "polling") {
    return "Stop polling in the main thread. Use PwrAgent's create_monitor_delegation tool with the durable command, cwd, log/status files, cadence, and terminal success/failure conditions.";
  }
  if (invocation.category === "mcp") {
    return "For MCP calls, request only targeted fields and use pagination or a bounded result limit.";
  }
  return "Redirect complete output to a local log and retrieve only targeted sections or a bounded tail when more detail is needed.";
}
