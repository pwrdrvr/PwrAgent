import type { AcpAgentClient, AcpAgentClientOptions } from "../../acp/acp-client";

// Await the prompt reply or onPromptError. An agent can publish turn_finished
// while the client's replay still has an active prompt awaiting its reply.
export function createAcpPromptSettlement() {
  let sequence = 0;
  const pending = new Map<string, { sessionId: string; finish: () => void }>();
  const settle = ({ sessionId, turnId }: { sessionId: string; turnId?: string }) => {
    const entry = turnId ? pending.get(turnId) : undefined;
    if (entry?.sessionId === sessionId) entry.finish();
  };
  const callbacks: Pick<AcpAgentClientOptions, "onSessionUpdate" | "onPromptError"> = {
    onSessionUpdate(event) {
      if (event.update.kind === "turn_finished" && event.replay.threadStatus !== "active") settle(event);
    },
    onPromptError: settle,
  };

  return {
    callbacks,
    async finish(client: AcpAgentClient, params: Omit<Parameters<AcpAgentClient["startPrompt"]>[0], "turnId">) {
      const turnId = `test-turn-${++sequence}`;
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      pending.set(turnId, { sessionId: params.sessionId, finish: resolve });
      const timeout = setTimeout(() => reject(new Error(`ACP prompt ${turnId} did not settle`)), 1_000);
      try {
        client.startPrompt({ ...params, turnId });
        await promise;
      } finally {
        clearTimeout(timeout);
        pending.delete(turnId);
      }
    },
  };
}
