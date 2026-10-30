import type { TerminalOutputSource } from "./terminal-output-reader";

/** Combine services on ONE authenticated owning instance, never viewer aliases
 * or a remote instance selected by tool arguments. */
export function combineTerminalOutputSources(
  ownerInstanceId: () => string,
  sources: TerminalOutputSource[],
): TerminalOutputSource {
  const assertOwners = () => {
    if (sources.some((source) => source.ownerInstanceId() !== ownerInstanceId())) {
      throw new Error("Terminal source belongs to a different owning instance.");
    }
  };
  return {
    ownerInstanceId,
    list: async (context) => {
      assertOwners();
      const sessions = (await Promise.all(sources.map((source) => source.list(context)))).flat();
      const ids = new Set<string>();
      for (const session of sessions) {
        if (ids.has(session.sessionId)) throw new Error("Ambiguous terminal identity on owning instance.");
        ids.add(session.sessionId);
      }
      return sessions.sort((a, b) => a.createdAt - b.createdAt);
    },
    replay: (context, terminalId) => {
      assertOwners();
      for (const source of sources) {
        const replay = source.replay(context, terminalId);
        if (replay) return replay;
      }
      return undefined;
    },
    snapshot: async (context, terminalId) => {
      assertOwners();
      for (const source of sources) {
        const snapshot = await source.snapshot(context, terminalId);
        if (snapshot) return snapshot;
      }
      return undefined;
    },
  };
}
