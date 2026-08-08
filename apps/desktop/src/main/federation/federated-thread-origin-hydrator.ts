import type {
  AppServerBackendKind,
  AppServerReadThreadResponse,
  AppServerThreadMessageOrigin,
  AppServerThreadSummary,
  CelestialIconId,
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

type ResolvedFederatedSourceInstance = {
  label: string;
  celestialIcon?: CelestialIconId;
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
  resolveInstance: (
    instanceId: FederationInstanceId,
  ) => ResolvedFederatedSourceInstance | undefined;
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

  const sourcesByKey = new Map<
    string,
    {
      discoverAcrossInstances: boolean;
      fallbackCelestialIcon?: CelestialIconId;
      fallbackInstanceLabel?: string;
      fallbackTitle?: string;
      instanceId: FederationInstanceId;
      source: HydratedSourceThread;
    }
  >();
  for (const source of sources) {
    const instanceId = source.instanceId ?? params.ownerInstanceId;
    const key = sourceThreadKey({
      backend: source.backend,
      instanceId,
      threadId: source.threadId,
    });
    const existing = sourcesByKey.get(key);
    if (existing) {
      existing.discoverAcrossInstances ||= source.instanceId === undefined;
      existing.fallbackInstanceLabel ||= source.instanceLabel?.trim();
      existing.fallbackCelestialIcon ||= source.celestialIcon;
      existing.fallbackTitle ||= source.title?.trim();
      continue;
    }
    sourcesByKey.set(key, {
      discoverAcrossInstances: source.instanceId === undefined,
      fallbackCelestialIcon: source.celestialIcon,
      fallbackInstanceLabel: source.instanceLabel?.trim() || undefined,
      fallbackTitle: source.title?.trim() || undefined,
      instanceId,
      source,
    });
  }

  const hydratedByKey = new Map<string, HydratedSourceThread>();
  await Promise.all(
    [...sourcesByKey].map(async ([key, sourceGroup]) => {
      let resolved: ResolvedFederatedSourceThread | undefined;
      try {
        resolved = await params.resolveThread({
          backend: sourceGroup.source.backend,
          discoverAcrossInstances: sourceGroup.discoverAcrossInstances,
          instanceId: sourceGroup.instanceId,
          threadId: sourceGroup.source.threadId,
        });
      } catch {
        // Provenance identity is still useful and click-to-mount remains
        // available when a peer cannot hydrate the display title.
      }
      const instanceId = resolved?.instanceId ?? sourceGroup.instanceId;
      let instance: ResolvedFederatedSourceInstance | undefined;
      try {
        instance = params.resolveInstance(instanceId);
      } catch {
        // Preserve any already-hydrated identity metadata when peer metadata
        // is temporarily unavailable.
      }
      hydratedByKey.set(key, normalizeSourceThread({
        localInstanceId: params.localInstanceId,
        source: sourceGroup.source,
        instanceId,
        instanceLabel: instance?.label ?? sourceGroup.fallbackInstanceLabel,
        celestialIcon:
          instance?.celestialIcon ?? sourceGroup.fallbackCelestialIcon,
        title: resolved?.thread.title || sourceGroup.fallbackTitle,
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
  instanceLabel?: string;
  celestialIcon?: CelestialIconId;
  title?: string;
}): HydratedSourceThread {
  const remote = params.instanceId !== params.localInstanceId;
  return {
    backend: params.source.backend,
    ...(remote ? { instanceId: params.instanceId } : {}),
    ...(remote && params.instanceLabel
      ? { instanceLabel: params.instanceLabel }
      : {}),
    ...(remote && params.celestialIcon
      ? { celestialIcon: params.celestialIcon }
      : {}),
    threadId: params.source.threadId,
    ...(params.title ? { title: params.title } : {}),
  };
}

function sourceThreadKey(
  ref: Pick<FederatedSourceThreadRef, "backend" | "instanceId" | "threadId">,
): string {
  return `${ref.instanceId}:${ref.backend}:${ref.threadId}`;
}
