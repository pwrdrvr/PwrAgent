import type { AppServerThreadActivityDetail, AppServerThreadActivityEntry } from "@pwragent/shared";
import { formatToolIdentifier, formatToolInvocation } from "../../../../shared/tool-activity";
import type { VoiceActionRow } from "./native-voice-controller";

/**
 * A run of tool receipts with nothing said between them, as the activity
 * entry a thread's transcript draws for its tool calls: one collapsed
 * "Used N tools" row, each call expanding to its invocation and result.
 * A single call is its own summary, so it expands straight to that call.
 */
export function voiceToolActivity(rows: VoiceActionRow[]): AppServerThreadActivityEntry {
  const first = rows[0]!;
  const details = rows.map(voiceToolDetail);
  const failed = rows.filter((row) => !row.ok).length;
  const summary = rows.length === 1
    ? details[0]!.label
    : [`Used ${rows.length} tools`, failed ? `${failed} failed` : ""].filter(Boolean).join(" · ");
  return {
    type: "activity",
    id: `voice-tools-${first.seq}`,
    createdAt: first.at,
    summary,
    status: failed ? "failed" : "completed",
    details,
  };
}

/** What the call was about reads in its label; the call itself is one click away. */
function voiceToolDetail(row: VoiceActionRow): AppServerThreadActivityDetail {
  const identifier = formatToolIdentifier(row.namespace, row.tool);
  const label = [
    row.tool,
    row.target ? `: ${row.target}` : "",
    row.instance ? ` on ${row.instance}` : "",
    row.outcome ? ` - ${row.outcome}` : "",
  ].join("");
  return {
    id: `voice-tool-${row.seq}`,
    kind: "command",
    label,
    ...(row.arguments || row.output
      ? {
          command: {
            displayCommand: formatToolInvocation(identifier, row.arguments),
            rawCommand: identifier,
            source: "tool" as const,
            ...(row.output ? { output: row.output } : {}),
          },
        }
      : {}),
    status: row.ok ? "completed" : "failed",
  };
}
