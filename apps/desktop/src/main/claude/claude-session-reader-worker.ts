// Node child-process entry for openClaudeSessionReader. The main process starts
// it with the environment Claude launches with, so the SDK reads the sessions
// of that CLAUDE_CONFIG_DIR.
import { getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { answerClaudeSessionRead, type ClaudeSessionReadRequest } from "./claude-session-reader.js";

process.on("message", (request: ClaudeSessionReadRequest) => {
  void answerClaudeSessionRead(request, { getSessionInfo, getSessionMessages })
    .then((reply) => process.send?.(reply));
});

// IPC lifetime is ownership: a crashed host must not leave a read/cleanup running.
process.once("disconnect", () => process.exit(0));
