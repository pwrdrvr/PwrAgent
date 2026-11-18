import {
  DECISION_PROVIDER_IDS,
  type DecisionProviderId,
  type DesktopSettingsSnapshot,
} from "@pwragent/shared";
import {
  DECISION_PROVIDER_FOCUS,
  DECISION_PROVIDER_NAMES,
  decisionSecrets,
} from "./DecisionModelSettings";
import {
  OPENAI_DECISIONS_FOCUS,
  openAIDecisionsKeyState,
} from "./OpenAIDecisionsSettings";

/**
 * The kinds of AI provider, in the order the Settings nav and the AI
 * Providers page list them. Both group their rows under these headings, so
 * the providers that are not agent harnesses can be found without scrolling
 * the AI Providers page to its end.
 */
export type ProviderKind = "harness" | "local" | "direct-api";

export const PROVIDER_KINDS: ReadonlyArray<{
  kind: ProviderKind;
  label: string;
  description: string;
}> = [
  {
    kind: "harness",
    label: "Harnesses",
    description: "Agent programs that run threads",
  },
  {
    kind: "local",
    label: "On this computer",
    description: "A model server on loopback; nothing leaves this computer",
  },
  {
    kind: "direct-api",
    label: "Direct API",
    description: "Hosted APIs called with your key",
  },
];

/** The local decision model must listen on loopback (see
 *  `decisionLocalEndpointProblem`); Jev is a hosted API. A new decision
 *  provider fails typecheck here until it is given a kind. */
const DECISION_PROVIDER_KIND: Record<
  DecisionProviderId,
  Exclude<ProviderKind, "harness">
> = {
  local: "local",
  jev: "direct-api",
};

/** A provider that is not an agent harness: it has its own AI Providers
 *  screen under `focus`, but runs no threads. */
export type ModelServiceEntry = {
  focus: string;
  name: string;
  kind: Exclude<ProviderKind, "harness">;
  /** False only when the provider needs an API key and has none. */
  keyReady: boolean;
  decisionProvider?: DecisionProviderId;
};

/** Every non-harness provider, in display order. The nav and the AI
 *  Providers page both read this list, so one cannot gain a row the other
 *  lacks. */
export function modelServiceEntries(
  snapshot: DesktopSettingsSnapshot,
): ModelServiceEntry[] {
  const decisions = DECISION_PROVIDER_IDS.map((provider): ModelServiceEntry => ({
    focus: DECISION_PROVIDER_FOCUS[provider],
    name: DECISION_PROVIDER_NAMES[provider],
    kind: DECISION_PROVIDER_KIND[provider],
    keyReady:
      provider === "local" || decisionSecrets(snapshot).jevApiKey.configured,
    decisionProvider: provider,
  }));
  const services: ModelServiceEntry[] = [
    ...decisions,
    {
      focus: OPENAI_DECISIONS_FOCUS,
      name: "OpenAI Decisions",
      kind: "direct-api",
      keyReady: openAIDecisionsKeyState(snapshot).configured,
    },
  ];
  // Stable sort into kind order, so a group's rows stay contiguous.
  const rank = (kind: ProviderKind) =>
    PROVIDER_KINDS.findIndex((entry) => entry.kind === kind);
  return services.sort((a, b) => rank(a.kind) - rank(b.kind));
}
