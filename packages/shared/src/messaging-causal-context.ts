import type { AppServerThreadMessageOrigin, MessagingCausalSourceRef } from "./contracts/normalized-app-server";

/** The messaging contact behind a turn, or the mark that it had more than one. */
export type CausalMessagingContext = Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">;

export function sameCausalMessagingSource(
  source: MessagingCausalSourceRef,
  other: MessagingCausalSourceRef | undefined,
): boolean {
  return source.ownerId === other?.ownerId
    && source.connectionId === other.connectionId
    && (source.requestId === other.requestId
      || Boolean(source.surfaceSelector && source.surfaceSelector === other.surfaceSelector));
}

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
    || sources.some((source) => !sameCausalMessagingSource(source, first));
  return ambiguous ? { causalMessagingSource: undefined, causalMessagingAmbiguous: true }
    : { causalMessagingSource: sources[sources.length - 1], causalMessagingAmbiguous: undefined };
}
