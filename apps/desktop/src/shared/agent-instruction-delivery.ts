/**
 * How an Agent's instructions reach the model on each backend.
 *
 * - **Claude.** Appended to the `claude_code` system prompt. The prompt is
 *   fixed when the Claude process starts, so a changed text relaunches the
 *   session before the next turn.
 * - **Codex.** Sent as `developerInstructions` on `thread/start` and on every
 *   `thread/resume`. Codex keeps them for the loaded session and shows them to
 *   the model on the first turn and again after each compaction. A changed
 *   text reloads the thread and is announced with one developer message.
 * - **ACP.** The protocol has no instruction field, so the text travels as a
 *   marked text block at the front of a prompt: the first prompt of an agent
 *   session, and the first after the text changes. A session loaded again
 *   keeps the block in its history and is not sent it a second time.
 *
 * An Agent whose own workspace holds its instructions in a file the backend
 * reads (`instructionsDelivery: "workspace-file"`) gets nothing from here, so
 * that it receives the text once.
 */

type DeliverableAgent = {
  instructions?: string;
  instructionsDelivery?: "workspace-file";
};

/** The instruction text PwrAgent itself must send to the provider, if any. */
export function providerDeliveredAgentInstructions(
  agent: DeliverableAgent | null | undefined,
): string | undefined {
  if (!agent || agent.instructionsDelivery === "workspace-file") {
    return undefined;
  }
  return agent.instructions?.trim() || undefined;
}

/**
 * The developer message that tells a Codex thread its instructions changed.
 * Codex shows developer instructions to the model only when it builds a full
 * context, so without this an edit would wait for the next compaction.
 */
export function buildCodexAgentInstructionUpdate(instructions: string | undefined): string {
  const text = instructions?.trim();
  return text
    ? [
        "The operator changed this Agent's instructions. From now on follow the instructions below. They replace every earlier version of this Agent's instructions.",
        text,
      ].join("\n\n")
    : "The operator removed this Agent's instructions. Earlier Agent instructions for this thread no longer apply.";
}

/**
 * Delimiters around the Agent instruction block PwrAgent puts at the front of
 * an ACP prompt. ACP agents echo every prompt back as a `user_message_chunk`,
 * so the transcript filter (`stripAcpAgentInstructionBlock`) removes the block
 * by these exact strings. Change one and the block renders as a user message.
 */
export const ACP_AGENT_INSTRUCTIONS_OPEN_MARKER =
  "[PwrAgent Agent instructions — standing instructions for this thread]";
export const ACP_AGENT_INSTRUCTIONS_CLOSE_MARKER =
  "[End PwrAgent Agent instructions]";

/** The marked block for an ACP prompt. Empty instructions withdraw earlier ones. */
export function buildAcpAgentInstructionBlock(instructions: string | undefined, orientation?: string): string {
  if (instructions === undefined && orientation) {
    return [ACP_AGENT_INSTRUCTIONS_OPEN_MARKER, orientation, ACP_AGENT_INSTRUCTIONS_CLOSE_MARKER].join("\n\n");
  }
  const text = instructions?.trim();
  return [
    ACP_AGENT_INSTRUCTIONS_OPEN_MARKER,
    ...(orientation ? [orientation] : []),
    text
      ? "The operator set these instructions for this Agent. Follow them on every turn of this thread. They replace any earlier PwrAgent Agent instructions."
      : "The operator removed this Agent's instructions. Earlier PwrAgent Agent instructions for this thread no longer apply.",
    ...(text ? [text] : []),
    ACP_AGENT_INSTRUCTIONS_CLOSE_MARKER,
  ].join("\n\n");
}

/**
 * Removes the Agent instruction block from prompt text meant for display and
 * returns the operator's own text. Handles a block split across streamed
 * chunks: a chunk with only the opening half drops its tail, and a chunk with
 * only the closing half drops everything up to and including the close marker.
 */
export function stripAcpAgentInstructionBlock(value: string): string {
  const start = value.indexOf(ACP_AGENT_INSTRUCTIONS_OPEN_MARKER);
  const closeAt = value.indexOf(
    ACP_AGENT_INSTRUCTIONS_CLOSE_MARKER,
    start === -1 ? 0 : start,
  );
  if (start === -1) {
    return closeAt === -1
      ? value
      : value.slice(closeAt + ACP_AGENT_INSTRUCTIONS_CLOSE_MARKER.length).trim();
  }
  const end =
    closeAt === -1
      ? value.length
      : closeAt + ACP_AGENT_INSTRUCTIONS_CLOSE_MARKER.length;
  return `${value.slice(0, start)}${value.slice(end)}`.trim();
}

/**
 * `stripAcpAgentInstructionBlock` for one chunk of a streamed message.
 * `insideBlock` says an earlier chunk opened a block that has not closed yet;
 * a chunk between the two markers carries neither and is dropped whole. The
 * caller clears the state when the user message ends, so a block that never
 * closes cannot swallow later messages.
 */
export function stripAcpAgentInstructionChunk(
  value: string,
  insideBlock: boolean,
): { text: string; insideBlock: boolean } {
  let rest = value;
  if (insideBlock) {
    const closeAt = rest.indexOf(ACP_AGENT_INSTRUCTIONS_CLOSE_MARKER);
    if (closeAt === -1) {
      return { text: "", insideBlock: true };
    }
    rest = rest.slice(closeAt + ACP_AGENT_INSTRUCTIONS_CLOSE_MARKER.length);
  }
  const start = rest.indexOf(ACP_AGENT_INSTRUCTIONS_OPEN_MARKER);
  return {
    text: stripAcpAgentInstructionBlock(rest),
    insideBlock: start !== -1
      && rest.indexOf(ACP_AGENT_INSTRUCTIONS_CLOSE_MARKER, start) === -1,
  };
}
