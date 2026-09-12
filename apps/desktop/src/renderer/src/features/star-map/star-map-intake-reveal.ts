import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";

/**
 * The stand-in `StarMapScreen` uses for this instance until federation
 * health reports its durable id (`health?.instanceId ?? "local"`). A reveal
 * captured under the placeholder must still resolve as local once the
 * durable id lands, the same transition `chatCards.remapOwner` handles for
 * open chat cards.
 */
export const STAR_MAP_LOCAL_INSTANCE_PLACEHOLDER = "local";

/**
 * A thread the [+] intake created, waiting to be revealed on the map.
 *
 * Intake answers with a backend and a thread id, not a
 * `NavigationThreadSummary` — but flying to a card and opening its chat both
 * need the summary. So the reveal cannot happen when the response lands; it
 * waits for the feed that owns the thread to carry it.
 */
export type StarMapIntakeReveal = {
  /** The instance whose [+] ran the intake. */
  instanceId: string;
  threadKey: string;
};

/**
 * The summary to reveal, or undefined while the owning feed has not caught
 * up yet.
 *
 * Which feed matters: a thread created through a remote instance's [+] will
 * never appear in `localThreads`, and searching every feed for a matching
 * key would reveal the wrong instance's thread whenever two instances share
 * a backend thread id. The one exception is the `"local"` placeholder on
 * either side, which only ever stands in for this instance.
 */
export function findStarMapIntakeRevealTarget(params: {
  localInstanceId: string;
  localThreads: readonly NavigationThreadSummary[];
  remoteThreadsByInstance: ReadonlyMap<
    string,
    readonly NavigationThreadSummary[]
  >;
  reveal: StarMapIntakeReveal | undefined;
}): NavigationThreadSummary | undefined {
  const reveal = params.reveal;
  if (!reveal) return undefined;
  // Only a reveal captured UNDER the placeholder needs the tolerance. Also
  // accepting it whenever `localInstanceId` is the placeholder would send a
  // genuinely remote reveal to the local feed every time health drops.
  const isLocal =
    reveal.instanceId === params.localInstanceId
    || reveal.instanceId === STAR_MAP_LOCAL_INSTANCE_PLACEHOLDER;
  const threads = isLocal
    ? params.localThreads
    : params.remoteThreadsByInstance.get(reveal.instanceId) ?? [];
  return threads.find(
    (thread) =>
      buildThreadIdentityKey(thread.source, thread.id) === reveal.threadKey,
  );
}
