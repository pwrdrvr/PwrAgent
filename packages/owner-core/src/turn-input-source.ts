import type { AppServerThreadMessageOrigin } from "@pwragent/shared/contracts/normalized-app-server";

const TURN_INPUT_SOURCES = ["desktop", "federation", "messaging", "automation", "agent", "mixed", "unknown"] as const;

/** The owner-attested category of the input that started a turn. */
export type TurnInputSource = (typeof TURN_INPUT_SOURCES)[number];

export function resolveTurnInputSource(params: {
  turnInputSource?: TurnInputSource;
  messageOrigin?: AppServerThreadMessageOrigin;
  origin?: string;
  agentMessages?: readonly { origin?: AppServerThreadMessageOrigin }[];
}): TurnInputSource {
  if (params.turnInputSource !== undefined) {
    return TURN_INPUT_SOURCES.includes(params.turnInputSource) ? params.turnInputSource : "unknown";
  }
  if (params.origin === "automation" || params.origin === "scheduled") return "automation";
  if (params.agentMessages) return combinedTurnInputSource(params.agentMessages.map(({ origin }) => ({ messageOrigin: origin })));
  switch (params.messageOrigin?.kind) {
    case "agent":
    case "sub-agent":
      return "agent";
    case "automation":
    case "pwragent":
      return "automation";
    case "messaging":
      return "messaging";
    default:
      return "unknown";
  }
}

export function combinedTurnInputSource(members: readonly Parameters<typeof resolveTurnInputSource>[0][]): TurnInputSource {
  const sources = new Set(members.map(resolveTurnInputSource));
  // Missing evidence cannot establish the source of the whole input.
  if (sources.has("unknown")) return "unknown";
  if (sources.size > 1) return "mixed";
  return sources.values().next().value ?? "unknown";
}
