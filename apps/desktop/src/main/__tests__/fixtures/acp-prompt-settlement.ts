import type { AcpAgentClient, AcpAgentClientOptions } from "../../acp/acp-client";

// Await the real terminal callbacks. A prompt can settle successfully or
// through onPromptError, and the client clears the active turn before either.
export function createAcpPromptSettlement() {
  let sequence = 0;
  const pending = new Map<string, { sessionId: string; finish: () => void }>();
  const settle = ({ sessionId, turnId }: { sessionId: string; turnId?: string }) => {
    const entry = turnId ? pending.get(turnId) : undefined;
    if (entry?.sessionId === sessionId) entry.finish();
  };
  const callbacks: Pick<AcpAgentClientOptions, "onSessionUpdate" | "onPromptError"> = {
    onSessionUpdate(event) {
      if (event.update.kind === "turn_finished") settle(event);
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
