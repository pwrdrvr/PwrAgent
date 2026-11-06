// Utility-process entry for openClaudeSessionReader. The main process starts
// it with the environment Claude launches with, so the SDK reads the sessions
// of that CLAUDE_CONFIG_DIR.
import { getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { answerClaudeSessionRead, type ClaudeSessionReadRequest } from "./claude-session-reader.js";

process.parentPort?.on("message", (event: { data: ClaudeSessionReadRequest }) => {
  void answerClaudeSessionRead(event.data, { getSessionInfo, getSessionMessages })
    .then((reply) => process.parentPort?.postMessage(reply));
});
