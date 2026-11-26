import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import {
  ANTIGRAVITY_CALL_PWRAGENT_TOOL,
  CALL_PWRAGENT_TOOL,
  readPwrAgentCallTarget,
} from "../agent-tools/antigravity-mcp-catalog.js";
import { readAcpToolText } from "./acp-command-extraction.js";
import {
  formatRedactedToolArguments,
  redactSecretStringValue,
} from "../util/redact-mcp-tool-args.js";

const CALL_MCP_TOOL = "call_mcp_tool";
const ANTIGRAVITY_CALL_MCP_TOOL = `mcp_${PWRAGENT_TOOL_NAMESPACE}_${CALL_MCP_TOOL}`;
const DOUBLE_UNDERSCORE_CALL_PWRAGENT_TOOL = `mcp__${PWRAGENT_TOOL_NAMESPACE}__${CALL_PWRAGENT_TOOL}`;
const DOUBLE_UNDERSCORE_CALL_MCP_TOOL = `mcp__${PWRAGENT_TOOL_NAMESPACE}__${CALL_MCP_TOOL}`;
const NON_GRANTABLE_WRAPPED_PWRAGENT_TOOLS = new Set([CALL_PWRAGENT_TOOL, CALL_MCP_TOOL]);
const MAX_GRANT_LABEL_TOOL_LENGTH = 36;

export type AcpSessionMcpServerInfo = {
  /** Names as the agent received them in `session/new` or `session/load`. */
  agentNames: readonly string[];
  /** Names a live registration can vouch for. Absent while awaiting reload. */
  registeredNames?: ReadonlySet<string>;
};

export type AcpMcpHostApprovalTarget = {
  serverName: string;
  toolName: string;
  args: unknown;
};

export type AcpMcpPermissionInspection = {
  /** Display name for `acpMcpToolName` (unwrapped when safely identifiable). */
  displayToolName: string;
  /** Redacted, bounded invocation arguments when available. */
  displayDetail?: string;
  /** Human-readable approval prompt naming the unwrapped target. */
  prompt: string;
  /**
   * True when the backend reported a dispatcher/wrapper tool (such as
   * `mcp_pwragent_call_pwragent_tool`, `mcp_pwragent_call_mcp_tool`, or
   * Grok's `use_tool`). Native `allow_always` MUST be stripped for wrappers
   * so the agent never remembers the dispatcher name itself.
   */
  isWrapper: boolean;
  /**
   * Verified target for `hostApprovesToolCall` (read-only PwrAgent tools,
   * gateway `call_mcp_tool`, forge tools). Undefined when unverified or
   * ambiguous.
   */
  hostApprovalTarget?: AcpMcpHostApprovalTarget;
  /**
   * Internal session grant key (never derived from display text). Undefined
   * when a per-conversation grant cannot be safely scoped or honored (such as
   * `call_mcp_tool`, malformed wrappers, colliding servers, or sessions
   * without `registeredNames`).
   */
  grantKey?: string;
  /** Button label for PwrAgent's conversation-scoped allow option. */
  grantLabel?: string;
};

/**
 * Resolves an Antigravity flattened MCP tool name (`mcp_<server>_<tool>`) to
 * the single session server that could have produced it. Folds `-` to `_` and
 * case when checking for ambiguity, so colliding servers return `undefined`.
 */
export function resolveAntigravityMcpToolTarget(
  reportedName: string,
  serverNames: readonly string[],
): { serverName: string; toolName: string } | undefined {
  const fold = (value: string) => value.replace(/-/gu, "_").toLowerCase();
  const foldedName = fold(reportedName);
  const sources = [...new Set(serverNames)].filter((serverName) => {
    const prefix = `mcp_${fold(serverName)}_`;
    return foldedName.length > prefix.length && foldedName.startsWith(prefix);
  });
  if (sources.length !== 1) return undefined;
  const serverName = sources[0]!;
  const prefix = `mcp_${serverName}_`;
  if (!reportedName.startsWith(prefix)) return undefined;
  return { serverName, toolName: reportedName.slice(prefix.length) };
}

/**
 * Inspects an ACP `session/request_permission` `toolCall` across all ACP
 * backends (Antigravity, Grok `use_tool`/`UseTool`, Kimi, Gemini, Qwen, etc.)
 * to classify MCP tool calls, unwrap wrapper dispatchers for display, and
 * compute strictly scoped host-approval and conversation-grant identities.
 */
export function inspectAcpMcpPermission(params: {
  backendId: string;
  requesterName: string;
  toolCall: Record<string, unknown>;
  servers?: AcpSessionMcpServerInfo;
}): AcpMcpPermissionInspection | undefined {
  const { backendId, requesterName, toolCall, servers } = params;
  const rawInput = asRecord(toolCall.rawInput);
  const xaiMeta = asRecord(asRecord(toolCall._meta)?.["x.ai/tool"]);

  // Case 1: Grok's `use_tool` / `UseTool` MCP dispatcher.
  if (
    backendId === "acp:grok"
    && (toolCall.kind === undefined || toolCall.kind === "other")
    && (readString(rawInput, "variant") === "UseTool"
      || readString(xaiMeta, "name") === "use_tool")
  ) {
    return inspectGrokUseToolPermission({ requesterName, toolCall, rawInput, servers });
  }

  // Case 2: Flattened MCP tool name (`mcp_<server>_<tool>` or `mcp__<server>__<tool>`).
  if (toolCall.kind !== "other") {
    return undefined;
  }
  const reportedName = readReportedMcpToolName(toolCall);
  if (!reportedName) {
    return undefined;
  }

  return inspectFlattenedMcpPermission({
    requesterName,
    toolCall,
    rawInput,
    reportedName,
    servers,
  });
}

function inspectGrokUseToolPermission(params: {
  requesterName: string;
  toolCall: Record<string, unknown>;
  rawInput: Record<string, unknown> | undefined;
  servers?: AcpSessionMcpServerInfo;
}): AcpMcpPermissionInspection {
  const { requesterName, toolCall, rawInput, servers } = params;
  const rawToolName = readString(rawInput, "tool_name");
  const innerInput = rawInput?.tool_input;
  const innerInputRecord = asRecord(innerInput);
  const hasRegisteredServers = Boolean(
    servers?.registeredNames && servers.registeredNames.size > 0,
  );
  const pwragentRegistered = Boolean(servers?.registeredNames?.has(PWRAGENT_TOOL_NAMESPACE));
  const onlyPwrAgentServer =
    pwragentRegistered
    && servers !== undefined
    && new Set(servers.agentNames).size === 1;

  if (!rawToolName) {
    return {
      displayToolName: "use_tool",
      displayDetail: formatRedactedToolArguments(omitKeys(rawInput, ["variant"])),
      prompt: buildMcpPrompt(`${requesterName} wants to use an MCP tool.`, toolCall, "use_tool", rawInput),
      isWrapper: true,
    };
  }

  const split = splitGrokToolName(rawToolName);
  const isPwrAgentNamespace = split?.serverName === PWRAGENT_TOOL_NAMESPACE;
  const effectiveTool = split?.toolName ?? rawToolName;
  const isVerifiedPwrAgentWrapper = isPwrAgentNamespace || (!split && onlyPwrAgentServer);

  // Nested `call_mcp_tool` inside Grok's `use_tool`.
  if (effectiveTool === CALL_MCP_TOOL && isVerifiedPwrAgentWrapper) {
    const gatewayTarget = readGatewayCallTarget(innerInputRecord);
    const displayToolName = gatewayTarget
      ? formatExternalMcpDisplayName(gatewayTarget.connectionId, gatewayTarget.toolName)
      : rawToolName;
    const headline = gatewayTarget
      ? externalMcpHeadline(requesterName, gatewayTarget.connectionId, gatewayTarget.toolName)
      : `${requesterName} wants to use an MCP tool.`;
    return {
      displayToolName,
      displayDetail: formatRedactedToolArguments(
        gatewayTarget ? gatewayTarget.args : omitKeys(innerInputRecord, ["toolSummary"]),
      ),
      prompt: buildMcpPrompt(headline, toolCall, rawToolName, innerInputRecord),
      isWrapper: true,
      ...(pwragentRegistered
        ? {
            hostApprovalTarget: {
              serverName: PWRAGENT_TOOL_NAMESPACE,
              toolName: CALL_MCP_TOOL,
              args: innerInput,
            },
          }
        : {}),
      // Never grant `call_mcp_tool` at the ACP layer; the MCP gateway owns upstream grants.
    };
  }

  // Nested `call_pwragent_tool` inside Grok's `use_tool`.
  if (effectiveTool === CALL_PWRAGENT_TOOL && isVerifiedPwrAgentWrapper) {
    const target = readPwrAgentCallTarget(innerInput);
    if (target && !NON_GRANTABLE_WRAPPED_PWRAGENT_TOOLS.has(target.name)) {
      return {
        displayToolName: target.name,
        displayDetail: formatRedactedToolArguments(target.args),
        prompt: buildMcpPrompt(
          `${requesterName} wants to use the PwrAgent tool ${target.name}.`,
          toolCall,
          rawToolName,
          innerInputRecord,
        ),
        isWrapper: true,
        ...(pwragentRegistered
          ? {
              hostApprovalTarget: {
                serverName: PWRAGENT_TOOL_NAMESPACE,
                toolName: CALL_PWRAGENT_TOOL,
                args: innerInput,
              },
              grantKey: isPwrAgentNamespace
                ? `use_tool:pwragent_wrapped:${target.name}`
                : `use_tool:bare_pwragent_wrapped:${target.name}`,
              grantLabel: formatConversationGrantLabel(target.name),
            }
          : {}),
      };
    }
    return {
      displayToolName: rawToolName,
      displayDetail: formatRedactedToolArguments(omitKeys(innerInputRecord, ["toolSummary"])),
      prompt: buildMcpPrompt(`${requesterName} wants to use an MCP tool.`, toolCall, rawToolName, innerInputRecord),
      isWrapper: true,
    };
  }

  // Direct PwrAgent or external tool invoked through Grok's `use_tool`.
  if (isPwrAgentNamespace && split) {
    return {
      displayToolName: split.toolName,
      displayDetail: formatRedactedToolArguments(omitKeys(innerInputRecord, ["toolSummary"])),
      prompt: buildMcpPrompt(
        `${requesterName} wants to use the PwrAgent tool ${split.toolName}.`,
        toolCall,
        rawToolName,
        innerInputRecord,
      ),
      isWrapper: true,
      ...(pwragentRegistered
        ? {
            hostApprovalTarget: {
              serverName: PWRAGENT_TOOL_NAMESPACE,
              toolName: split.toolName,
              args: innerInput,
            },
            grantKey: `use_tool:pwragent:${split.toolName}`,
            grantLabel: formatConversationGrantLabel(split.toolName),
          }
        : {}),
    };
  }

  if (split) {
    return {
      displayToolName: formatExternalMcpDisplayName(split.serverName, split.toolName),
      displayDetail: formatRedactedToolArguments(omitKeys(innerInputRecord, ["toolSummary"])),
      prompt: buildMcpPrompt(
        externalMcpHeadline(requesterName, split.serverName, split.toolName),
        toolCall,
        rawToolName,
        innerInputRecord,
      ),
      isWrapper: true,
      ...(hasRegisteredServers
        ? {
            grantKey: `use_tool:namespaced:${rawToolName}`,
            grantLabel: formatConversationGrantLabel(split.toolName),
          }
        : {}),
    };
  }

  return {
    displayToolName: rawToolName,
    displayDetail: formatRedactedToolArguments(omitKeys(innerInputRecord, ["toolSummary"])),
    prompt: buildMcpPrompt(
      `${requesterName} wants to use the MCP tool ${rawToolName}.`,
      toolCall,
      rawToolName,
      innerInputRecord,
    ),
    isWrapper: true,
    ...(onlyPwrAgentServer
      ? {
          hostApprovalTarget: {
            serverName: PWRAGENT_TOOL_NAMESPACE,
            toolName: rawToolName,
            args: innerInput,
          },
        }
      : {}),
    ...(hasRegisteredServers && !NON_GRANTABLE_WRAPPED_PWRAGENT_TOOLS.has(rawToolName)
      ? {
          grantKey: `use_tool:bare:${rawToolName}`,
          grantLabel: formatConversationGrantLabel(rawToolName),
        }
      : {}),
  };
}

function inspectFlattenedMcpPermission(params: {
  requesterName: string;
  toolCall: Record<string, unknown>;
  rawInput: Record<string, unknown> | undefined;
  reportedName: string;
  servers?: AcpSessionMcpServerInfo;
}): AcpMcpPermissionInspection {
  const { requesterName, toolCall, rawInput, reportedName, servers } = params;
  const resolution = servers
    ? resolveFlattenedMcpTargetWithAmbiguity(reportedName, servers.agentNames)
    : { matchCount: 0 as const, target: undefined };
  const resolvedTarget = resolution.target;
  const ambiguous = resolution.matchCount > 1;
  const hasRegisteredServers = Boolean(servers?.registeredNames && servers.registeredNames.size > 0);
  const resolvedIsRegistered = Boolean(
    resolvedTarget && servers?.registeredNames?.has(resolvedTarget.serverName),
  );
  const isPwrAgentWrapper =
    reportedName === ANTIGRAVITY_CALL_PWRAGENT_TOOL
    || reportedName === DOUBLE_UNDERSCORE_CALL_PWRAGENT_TOOL;
  const isGatewayWrapper =
    reportedName === ANTIGRAVITY_CALL_MCP_TOOL
    || reportedName === DOUBLE_UNDERSCORE_CALL_MCP_TOOL;
  // Unwrap for display unless a colliding server or another matched server
  // could own the flattened name.
  const targetsPwrAgentForDisplay =
    !ambiguous
    && (resolution.matchCount === 0 || resolvedTarget?.serverName === PWRAGENT_TOOL_NAMESPACE);
  const verifiedPwrAgent =
    resolvedIsRegistered && resolvedTarget?.serverName === PWRAGENT_TOOL_NAMESPACE;

  // Subcase 2a: `call_pwragent_tool` wrapper.
  if (isPwrAgentWrapper) {
    const target = targetsPwrAgentForDisplay ? readPwrAgentCallTarget(rawInput) : undefined;
    if (target && !NON_GRANTABLE_WRAPPED_PWRAGENT_TOOLS.has(target.name)) {
      return {
        displayToolName: target.name,
        displayDetail: formatRedactedToolArguments(target.args),
        prompt: buildMcpPrompt(
          `${requesterName} wants to use the PwrAgent tool ${target.name}.`,
          toolCall,
          reportedName,
          rawInput,
        ),
        isWrapper: true,
        ...(verifiedPwrAgent
          ? {
              hostApprovalTarget: {
                serverName: PWRAGENT_TOOL_NAMESPACE,
                toolName: CALL_PWRAGENT_TOOL,
                args: toolCall.rawInput,
              },
              grantKey: `pwragent_wrapped:${target.name}`,
              grantLabel: formatConversationGrantLabel(target.name),
            }
          : {}),
      };
    }
    return {
      displayToolName: reportedName,
      displayDetail: formatRedactedToolArguments(omitKeys(rawInput, ["toolSummary"])),
      prompt: buildMcpPrompt(`${requesterName} wants to use an MCP tool.`, toolCall, reportedName, rawInput),
      isWrapper: true,
    };
  }

  // Subcase 2b: `call_mcp_tool` gateway wrapper.
  if (isGatewayWrapper) {
    const gatewayTarget = targetsPwrAgentForDisplay ? readGatewayCallTarget(rawInput) : undefined;
    const displayToolName = gatewayTarget
      ? formatExternalMcpDisplayName(gatewayTarget.connectionId, gatewayTarget.toolName)
      : reportedName;
    const headline = gatewayTarget
      ? externalMcpHeadline(requesterName, gatewayTarget.connectionId, gatewayTarget.toolName)
      : `${requesterName} wants to use an MCP tool.`;
    return {
      displayToolName,
      displayDetail: formatRedactedToolArguments(
        gatewayTarget ? gatewayTarget.args : omitKeys(rawInput, ["toolSummary"]),
      ),
      prompt: buildMcpPrompt(headline, toolCall, reportedName, rawInput),
      isWrapper: true,
      ...(verifiedPwrAgent
        ? {
            hostApprovalTarget: {
              serverName: PWRAGENT_TOOL_NAMESPACE,
              toolName: CALL_MCP_TOOL,
              args: toolCall.rawInput,
            },
          }
        : {}),
      // Never grant `call_mcp_tool` at the ACP layer; the MCP gateway owns upstream grants.
    };
  }

  // Subcase 2c: Direct (non-wrapper) MCP tool.
  const doubleSplit = splitDoubleUnderscoreMcpName(reportedName);
  const displayDetail = formatRedactedToolArguments(omitKeys(rawInput, ["toolSummary"]));
  const hostApprovalTarget: AcpMcpHostApprovalTarget | undefined =
    resolvedIsRegistered && resolvedTarget
      ? {
          serverName: resolvedTarget.serverName,
          toolName: resolvedTarget.toolName,
          args: toolCall.rawInput,
        }
      : undefined;

  let displayToolName = reportedName;
  let headline = `${requesterName} wants to use an MCP tool.`;
  let grantToolForLabel: string | undefined;

  if (resolvedTarget) {
    if (resolvedTarget.serverName === PWRAGENT_TOOL_NAMESPACE) {
      displayToolName = resolvedTarget.toolName;
      headline = `${requesterName} wants to use the PwrAgent tool ${resolvedTarget.toolName}.`;
      grantToolForLabel = resolvedTarget.toolName;
    } else {
      displayToolName = formatExternalMcpDisplayName(resolvedTarget.serverName, resolvedTarget.toolName);
      headline = externalMcpHeadline(requesterName, resolvedTarget.serverName, resolvedTarget.toolName);
      grantToolForLabel = resolvedTarget.toolName;
    }
  } else if (resolution.matchCount === 0 && doubleSplit) {
    if (doubleSplit.serverName === PWRAGENT_TOOL_NAMESPACE) {
      displayToolName = doubleSplit.toolName;
      headline = `${requesterName} wants to use the PwrAgent tool ${doubleSplit.toolName}.`;
      grantToolForLabel = doubleSplit.toolName;
    } else {
      displayToolName = formatExternalMcpDisplayName(doubleSplit.serverName, doubleSplit.toolName);
      headline = externalMcpHeadline(requesterName, doubleSplit.serverName, doubleSplit.toolName);
      grantToolForLabel = doubleSplit.toolName;
    }
  }

  return {
    displayToolName,
    displayDetail,
    prompt: buildMcpPrompt(headline, toolCall, reportedName, rawInput),
    isWrapper: false,
    ...(hostApprovalTarget ? { hostApprovalTarget } : {}),
    ...(hasRegisteredServers
      ? {
          grantKey: `direct:${reportedName}`,
          grantLabel: grantToolForLabel
            ? formatConversationGrantLabel(grantToolForLabel)
            : "Allow for this conversation",
        }
      : {}),
  };
}

function readReportedMcpToolName(toolCall: Record<string, unknown>): string | undefined {
  const direct = readString(toolCall, "name");
  if (direct !== undefined) {
    return /^mcp_[A-Za-z0-9_.-]+$/u.test(direct) ? direct : undefined;
  }
  const title = readString(toolCall, "title");
  if (title) {
    const match = /^Run\s+(mcp_[A-Za-z0-9_.-]+)$/u.exec(title);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function resolveFlattenedMcpTargetWithAmbiguity(
  reportedName: string,
  serverNames: readonly string[],
): { matchCount: number; target?: { serverName: string; toolName: string } } {
  const fold = (value: string) => value.replace(/-/gu, "_").toLowerCase();
  const doubleSplit = splitDoubleUnderscoreMcpName(reportedName);
  if (doubleSplit) {
    const matches = [...new Set(serverNames)].filter(
      (name) => fold(name) === fold(doubleSplit.serverName),
    );
    if (matches.length === 1 && matches[0] === doubleSplit.serverName) {
      return { matchCount: 1, target: doubleSplit };
    }
    if (matches.length > 1) {
      return { matchCount: matches.length };
    }
  }
  const foldedName = fold(reportedName);
  const sources = [...new Set(serverNames)].filter((serverName) => {
    const prefix = `mcp_${fold(serverName)}_`;
    return foldedName.length > prefix.length && foldedName.startsWith(prefix);
  });
  if (sources.length !== 1) {
    return { matchCount: sources.length };
  }
  const serverName = sources[0]!;
  const prefix = `mcp_${serverName}_`;
  return reportedName.startsWith(prefix)
    ? { matchCount: 1, target: { serverName, toolName: reportedName.slice(prefix.length) } }
    : { matchCount: 1 };
}

function splitDoubleUnderscoreMcpName(
  reportedName: string,
): { serverName: string; toolName: string } | undefined {
  const match = /^mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_.-]+)$/u.exec(reportedName);
  return match?.[1] && match[2]
    ? { serverName: match[1], toolName: match[2] }
    : undefined;
}

function splitGrokToolName(
  toolName: string,
): { serverName: string; toolName: string } | undefined {
  const mcpDouble = splitDoubleUnderscoreMcpName(toolName);
  if (mcpDouble) {
    return mcpDouble;
  }
  const doubleMatch = /^([A-Za-z0-9_-]+?)__([A-Za-z0-9_.-]+)$/u.exec(toolName);
  if (doubleMatch?.[1] && doubleMatch[2]) {
    return { serverName: doubleMatch[1], toolName: doubleMatch[2] };
  }
  return undefined;
}

function readGatewayCallTarget(
  rawInput: Record<string, unknown> | undefined,
): { connectionId?: string; toolName: string; args?: unknown } | undefined {
  if (!rawInput) return undefined;
  const toolName = readString(rawInput, "toolName");
  if (!toolName) return undefined;
  const connectionId = readString(rawInput, "connectionId");
  const args = rawInput.arguments;
  return {
    ...(connectionId ? { connectionId } : {}),
    toolName,
    ...(args !== undefined ? { args } : {}),
  };
}

function formatExternalMcpDisplayName(connectionId: string | undefined, toolName: string): string {
  return connectionId ? `${connectionId} / ${toolName}` : toolName;
}

function externalMcpHeadline(
  requesterName: string,
  connectionId: string | undefined,
  toolName: string,
): string {
  return connectionId
    ? `${requesterName} wants to use the MCP tool ${toolName} on ${connectionId}.`
    : `${requesterName} wants to use the MCP tool ${toolName}.`;
}

export function formatConversationGrantLabel(toolName: string): string {
  const trimmed = toolName.trim();
  if (trimmed && trimmed.length <= MAX_GRANT_LABEL_TOOL_LENGTH) {
    return `Allow ${trimmed} for this conversation`;
  }
  return "Allow this tool for this conversation";
}

function buildMcpPrompt(
  headline: string,
  toolCall: Record<string, unknown>,
  reportedName: string,
  rawInput: Record<string, unknown> | undefined,
): string {
  const title = readAcpToolText(toolCall.title);
  const content = readAcpToolText(toolCall.content);
  const summary = readString(rawInput, "toolSummary");
  const details = [title, summary, content]
    .filter((text): text is string =>
      Boolean(
        text
        && text !== reportedName
        && text !== `Run ${reportedName}`
        && text !== "use_tool"
        && text !== "UseTool",
      ),
    )
    .map(redactSecretStringValue);
  return [headline, ...new Set(details)].join("\n\n");
}

function omitKeys(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (!record) return undefined;
  const omitted = new Set(keys);
  const entries = Object.entries(record).filter(([key]) => !omitted.has(key));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
