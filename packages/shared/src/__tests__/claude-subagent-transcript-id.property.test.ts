import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX,
  claudeSubAgentTranscriptThreadId,
  claudeSubAgentTranscriptThreadIdForMonitor,
  parseClaudeSubAgentTranscriptThreadId,
} from "../subagent-kind";

/**
 * Rule: a Claude sub-agent's transcript id names exactly one parent thread
 * and one task, and reads back as them. Any other thread id is not one, so a
 * real thread is never read as a sub-agent.
 */

// Claude's task ids are alphanumeric; a parent id is any non-empty string.
const taskId = fc.stringMatching(/^[a-z0-9]{1,20}$/u);
const parentThreadId = fc.string({ minLength: 1, maxLength: 60 });

describe("Claude sub-agent transcript ids", () => {
  it("round-trips the parent thread and the task", () => {
    fc.assert(fc.property(parentThreadId, taskId, (parent, task) => {
      expect(parseClaudeSubAgentTranscriptThreadId(claudeSubAgentTranscriptThreadId(parent, task)))
        .toEqual({ parentThreadId: parent, taskId: task });
      expect(claudeSubAgentTranscriptThreadIdForMonitor(`${CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX}${task}`, parent))
        .toBe(claudeSubAgentTranscriptThreadId(parent, task));
    }));
  });

  it("reads no other id as a sub-agent transcript", () => {
    fc.assert(fc.property(fc.string(), (threadId) => {
      fc.pre(!threadId.startsWith("claude-subagent:"));
      expect(parseClaudeSubAgentTranscriptThreadId(threadId)).toBeUndefined();
    }));
    expect(parseClaudeSubAgentTranscriptThreadId("claude-subagent:")).toBeUndefined();
    expect(parseClaudeSubAgentTranscriptThreadId("claude-subagent:parent:")).toBeUndefined();
    expect(parseClaudeSubAgentTranscriptThreadId("claude-subagent::task")).toBeUndefined();
    // The task id names a file; a path never reads as one.
    expect(parseClaudeSubAgentTranscriptThreadId("claude-subagent:parent:../../x")).toBeUndefined();
    expect(parseClaudeSubAgentTranscriptThreadId("claude-subagent:parent:a/b")).toBeUndefined();
    expect(claudeSubAgentTranscriptThreadIdForMonitor("codex-native:019dde61", "parent")).toBeUndefined();
  });
});
