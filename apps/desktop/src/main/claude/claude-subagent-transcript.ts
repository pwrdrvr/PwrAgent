import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadActivityStatus,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
} from "@pwragent/shared";
import { claudeCommandActivity, groupClaudeActivities } from "./claude-activity";
import {
  claudeShellCommand,
  claudeToolCallDetail,
  claudeToolDetail,
  claudeToolResultContent,
} from "./claude-tool-activity";

type ContentBlock = Record<string, unknown> & { type?: unknown };

/** The one turn a sub-agent's transcript is drawn as. */
const SUB_AGENT_TURN = { id: "claude-subagent" };

/**
 * A Claude sub-agent's conversation, as the transcript draws it.
 *
 * The SDK reads the sub-agent's own session file. Its messages carry the
 * Anthropic message shape: the task prompt, assistant text and tool calls,
 * and tool results in user messages. A result completes the row its call
 * opened. Thinking blocks and Claude Code's own meta prompts stay out.
 *
 * Once the sub-agent has ended, a call with no result says nothing about
 * its outcome rather than running forever. That happens: the SDK follows one
 * branch of the conversation, and the results of some parallel calls sit on
 * another.
 */
export function claudeSubAgentTranscriptEntries(
  messages: readonly SessionMessage[],
  options: { running: boolean },
): AppServerThreadEntry[] {
  const entries = new Map<string, AppServerThreadEntry>();
  for (const message of messages) {
    const record = message as SessionMessage & { is_meta?: unknown; timestamp?: unknown };
    if (record.is_meta === true || message.type === "system") continue;
    const createdAt = typeof record.timestamp === "string" ? Date.parse(record.timestamp) || undefined : undefined;
    const body = message.message as { id?: unknown; content?: unknown } | undefined;
    const blocks: ContentBlock[] = typeof body?.content === "string"
      ? [{ type: "text", text: body.content }]
      : Array.isArray(body?.content) ? body.content.filter((block): block is ContentBlock => Boolean(block) && typeof block === "object") : [];
    const text = blocks.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : [])
      .join("\n").trim();
    if (message.type === "user") {
      if (text) addMessage(entries, { id: message.uuid, role: "user", text, createdAt });
      for (const block of blocks) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          completeTool(entries, block.tool_use_id, block.content, block.is_error === true);
        }
      }
      continue;
    }
    // Claude Code records one assistant message per content block, all with
    // the API message's id. Text from the same message reads as one reply.
    if (text) {
      const id = typeof body?.id === "string" ? body.id : message.uuid;
      const previous = entries.get(id);
      addMessage(entries, {
        id, role: "assistant", createdAt: previous?.createdAt ?? createdAt,
        text: previous?.type === "message" ? `${previous.text}\n${text}` : text,
      });
    }
    for (const block of blocks) {
      if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue;
      entries.set(block.id, toolActivity(block.id, block.name, block.input, createdAt));
    }
  }
  const settled = [...entries.values()].map((entry) => options.running || entry.type !== "activity"
    || entry.status !== "in_progress"
    ? entry
    : {
      ...entry, status: "completed" as const,
      details: entry.details.map(({ status: _unknown, ...detail }) => detail),
    });
  return groupClaudeActivities(settled);
}

function addMessage(
  entries: Map<string, AppServerThreadEntry>,
  message: { id: string; role: "user" | "assistant"; text: string; createdAt?: number },
): void {
  const entry: AppServerThreadMessageEntry = {
    type: "message", id: message.id, role: message.role, text: message.text, turn: SUB_AGENT_TURN,
    ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
  };
  entries.set(entry.id, entry);
}

function toolActivity(id: string, name: string, rawInput: unknown, createdAt: number | undefined): AppServerThreadActivityEntry {
  const input = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : {};
  const command = name === "Bash" && typeof input.command === "string" ? input.command : undefined;
  const status = "in_progress" as const;
  if (command !== undefined) {
    return { ...claudeCommandActivity({ id, command, status }), createdAt: createdAt ?? 0, turn: SUB_AGENT_TURN };
  }
  const params = { id, name, input, status };
  const detail = claudeToolDetail(params) ?? claudeToolCallDetail(params);
  return {
    type: "activity", id, summary: detail.label, status, details: [detail],
    createdAt: createdAt ?? 0, turn: SUB_AGENT_TURN,
  };
}

function completeTool(
  entries: Map<string, AppServerThreadEntry>, toolUseId: string, content: unknown, isError: boolean,
): void {
  const entry = entries.get(toolUseId);
  if (entry?.type !== "activity") return;
  const status: AppServerThreadActivityStatus = isError ? "failed" : "completed";
  const { text: output, images } = claudeToolResultContent(content, entry.summary);
  const first = entry.details[0];
  const command = claudeShellCommand(first);
  if (command !== undefined) {
    const details = claudeCommandActivity({ id: entry.id, command, status, output }).details;
    entries.set(toolUseId, {
      ...entry, status, details: images.length ? [{ ...details[0], images }, ...details.slice(1)] : details,
    });
    return;
  }
  if (first?.command?.source === "tool") {
    entries.set(toolUseId, {
      ...entry, status,
      details: [{
        ...first, status,
        command: { ...first.command, ...(output ? { output } : {}) },
        ...(images.length ? { images } : {}),
      }, ...entry.details.slice(1)],
    });
    return;
  }
  const outputId = `${entry.id}:output`;
  entries.set(toolUseId, {
    ...entry, status,
    details: [
      ...entry.details.filter((detail) => detail.id !== outputId).map((detail) => ({ ...detail, status })),
      {
        id: outputId, kind: first?.kind ?? "read", label: `${entry.summary} output`,
        ...(output || !images.length ? { markdown: output } : {}),
        ...(images.length ? { images } : {}),
        status,
      },
    ],
  });
}
