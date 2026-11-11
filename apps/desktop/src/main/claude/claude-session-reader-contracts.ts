import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";



/**
 * The SDK session reads a rewind needs. `dir` is the only option they pass,
 * because the reads may cross a process boundary.
 */
export type ClaudeSessionReads = {
  getSessionMessages(sessionId: string, options?: { dir?: string }): Promise<SessionMessage[]>;
  getSessionInfo(sessionId: string, options?: { dir?: string }): Promise<SDKSessionInfo | undefined>;
  /** One sub-agent's conversation, by the parent session and the agent's id. */
  getSubagentMessages(sessionId: string, agentId: string, options?: { dir?: string }): Promise<SessionMessage[]>;
};


export type ClaudeSessionReader = ClaudeSessionReads & { close(): void };


export type ClaudeSessionReadRequest = {
  id: number;
  method: keyof ClaudeSessionReads;
  sessionId: string;
  /** The sub-agent `getSubagentMessages` reads. */
  agentId?: string;
  options?: { dir?: string };
};


export type ClaudeSessionReadReply = { id: number; result?: unknown; error?: string };


/** The utility process, as far as the reader uses it. */
export type ClaudeSessionReaderChild = {
  postMessage(message: ClaudeSessionReadRequest): void;
  on(event: "message", listener: (reply: ClaudeSessionReadReply) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
};
