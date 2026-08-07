import type {
  AppServerBackendKind,
  AppServerReadThreadResponse,
  AppServerThreadMessageOrigin,
  AppServerThreadSummary,
  FederationInstanceId,
} from "@pwragent/shared";

type FederatedSourceThreadRef = {
  backend: AppServerBackendKind;
  discoverAcrossInstances: boolean;
  instanceId: FederationInstanceId;
  threadId: string;
};

type ResolvedFederatedSourceThread = {
  instanceId: FederationInstanceId;
  thread: AppServerThreadSummary;
};

type HydratedSourceThread = NonNullable<
  AppServerThreadMessageOrigin["sourceThread"]
>;

/**
 * Makes transcript provenance globally actionable without mounting source
 * threads or subscribing to their navigation events.
 *
 * Older records predate source-thread instance ids. The serving owner is the
 * backwards-compatible first lookup; a resolver may then accept one unique
 * match from another connected instance.
 */
export async function hydrateFederatedThreadMessageOrigins(params: {
  localInstanceId: FederationInstanceId;
  ownerInstanceId: FederationInstanceId;
  response: AppServerReadThreadResponse;
  resolveThread: (
    ref: FederatedSourceThreadRef,
  ) => Promise<ResolvedFederatedSourceThread | undefined>;
}): Promise<AppServerReadThreadResponse> {
  const sources = [
    ...params.response.replay.entries.flatMap((entry) =>
      entry.type === "message" && entry.origin?.sourceThread
        ? [entry.origin.sourceThread]
        : []
    ),
    ...params.response.replay.messages.flatMap((message) =>
      message.origin?.sourceThread ? [message.origin.sourceThread] : []
    ),
  ];
  if (sources.length === 0) {
    return params.response;
  }

  const hydratedByKey = new Map<string, HydratedSourceThread>();
  await Promise.all(
    sources.map(async (source) => {
      const instanceId = source.instanceId ?? params.ownerInstanceId;
      const key = sourceThreadKey({
        backend: source.backend,
        instanceId,
        threadId: source.threadId,
      });
      if (hydratedByKey.has(key)) {
        return;
      }

      // Reserve the key before awaiting so duplicate entry/message views of
      // the same transcript item produce one point lookup.
      hydratedByKey.set(key, normalizeSourceThread({
        localInstanceId: params.localInstanceId,
        source,
        instanceId,
      }));
      let resolved: ResolvedFederatedSourceThread | undefined;
      try {
        resolved = await params.resolveThread({
          backend: source.backend,
          discoverAcrossInstances: source.instanceId === undefined,
          instanceId,
          threadId: source.threadId,
        });
      } catch {
        // Provenance identity is still useful and click-to-mount remains
        // available when a peer cannot hydrate the display title.
      }
      hydratedByKey.set(key, normalizeSourceThread({
        localInstanceId: params.localInstanceId,
        source,
        instanceId: resolved?.instanceId ?? instanceId,
        title: resolved?.thread.title || source.title?.trim(),
      }));
    }),
  );

  const hydrateOrigin = (
    origin: AppServerThreadMessageOrigin | undefined,
  ): AppServerThreadMessageOrigin | undefined => {
    const source = origin?.sourceThread;
    if (!origin || !source) {
      return origin;
    }
    const instanceId = source.instanceId ?? params.ownerInstanceId;
    return {
      ...origin,
      sourceThread:
        hydratedByKey.get(sourceThreadKey({
          backend: source.backend,
          instanceId,
          threadId: source.threadId,
        }))
        ?? source,
    };
  };

  return {
    ...params.response,
    replay: {
      ...params.response.replay,
      entries: params.response.replay.entries.map((entry) =>
        entry.type === "message"
          ? { ...entry, origin: hydrateOrigin(entry.origin) }
          : entry
      ),
      messages: params.response.replay.messages.map((message) => ({
        ...message,
        origin: hydrateOrigin(message.origin),
      })),
    },
  };
}

function normalizeSourceThread(params: {
  localInstanceId: FederationInstanceId;
  source: HydratedSourceThread;
  instanceId: FederationInstanceId;
  title?: string;
}): HydratedSourceThread {
  return {
    backend: params.source.backend,
    ...(params.instanceId === params.localInstanceId
      ? {}
      : { instanceId: params.instanceId }),
    threadId: params.source.threadId,
    ...(params.title ? { title: params.title } : {}),
  };
}

function sourceThreadKey(
  ref: Pick<FederatedSourceThreadRef, "backend" | "instanceId" | "threadId">,
): string {
  return `${ref.instanceId}:${ref.backend}:${ref.threadId}`;
}
