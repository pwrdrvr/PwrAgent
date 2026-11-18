import type { AppServerThreadMessageOrigin } from "./contracts/normalized-app-server";

type CausalMessagingContext = Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">;

/**
 * The contact behind work that several requests caused. One contact keeps
 * its latest source; a mix of contacts, or of a contact and the local
 * operator, is ambiguous, which grants no contact's authority.
 */
export function mergeCausalMessagingContext<T extends CausalMessagingContext>(
  origins: Array<T | undefined>,
): CausalMessagingContext {
  const sources = origins.flatMap((origin) => origin?.causalMessagingSource ? [origin.causalMessagingSource] : []);
  if (!sources.length && !origins.some((origin) => origin?.causalMessagingAmbiguous)) return {};
  const first = sources[0];
  const ambiguous = origins.some((origin) => origin?.causalMessagingAmbiguous)
    || sources.length !== origins.length
    || sources.some((source) => source.ownerId !== first?.ownerId
      || (source.requestId !== first?.requestId
        && (!source.surfaceSelector || source.surfaceSelector !== first?.surfaceSelector)));
  return ambiguous ? { causalMessagingSource: undefined, causalMessagingAmbiguous: true }
    : { causalMessagingSource: sources[sources.length - 1], causalMessagingAmbiguous: undefined };
}
