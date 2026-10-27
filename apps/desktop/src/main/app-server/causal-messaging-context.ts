import type { AppServerThreadMessageOrigin } from "@pwragent/shared";

export function mergeCausalMessagingContext(
  origins: Array<AppServerThreadMessageOrigin | undefined>,
): Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous"> {
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
