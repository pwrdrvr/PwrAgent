import { useCallback, useEffect, useState } from "react";
import type {
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  getComposerMentionNavigationRevision,
  notifyComposerMentionNavigationChanged,
} from "../../lib/composer-mention-navigation-revision";

/**
 * How long a fetched population stays good enough for an autocomplete.
 *
 * The popover is not a view of the thread list — it is a picker, and a
 * thread created in the last few seconds is not worth a bridge round trip
 * per keystroke. Long enough that one composing burst reuses a single
 * fetch, short enough that a card opened minutes later sees a list the
 * operator recognizes.
 */
const NAVIGATION_STALE_MS = 10_000;

type NavigationPopulation = {
  directories: readonly NavigationDirectorySummary[];
  threads: readonly NavigationThreadSummary[];
};

const EMPTY_POPULATION: NavigationPopulation = {
  directories: [],
  threads: [],
};

/**
 * Module-level, not per hook instance: the star map can have a dozen chat
 * cards open, every one of them able to open an `@` or `#` popover, and
 * every one of them wants the same local snapshot. A per-card fetch would
 * turn one operator typing `@` into N identical bridge calls.
 */
let cachedPopulation: NavigationPopulation | undefined;
let cachedAt = 0;
let cachedRevision = -1;
let inFlight: Promise<void> | undefined;
const subscribers = new Set<(population: NavigationPopulation) => void>();
const eventSubscriptions = new Map<
  DesktopApi,
  { refCount: number; unsubscribe: () => void }
>();

function retainNavigationChangedSubscription(
  desktopApi: DesktopApi | undefined,
): () => void {
  const subscribe = desktopApi?.onNavigationMentionSourcesChanged;
  if (!desktopApi || !subscribe) {
    return () => undefined;
  }
  const existing = eventSubscriptions.get(desktopApi);
  if (existing) {
    existing.refCount += 1;
  } else {
    eventSubscriptions.set(desktopApi, {
      refCount: 1,
      unsubscribe: subscribe(() => {
        notifyComposerMentionNavigationChanged();
        // Registration is rare and operator-driven. Refresh immediately so
        // an already-open picker in this window sees the new project without
        // another keystroke; every mounted card shares this one bridge call.
        beginPopulationLoad(desktopApi);
      }),
    });
  }
  return () => {
    const current = eventSubscriptions.get(desktopApi);
    if (!current) {
      return;
    }
    current.refCount -= 1;
    if (current.refCount === 0) {
      current.unsubscribe();
      eventSubscriptions.delete(desktopApi);
    }
  };
}

/** Test seam: drop the shared cache so specs do not leak into each other. */
export function resetComposerMentionSourcesCache(): void {
  cachedPopulation = undefined;
  cachedAt = 0;
  cachedRevision = -1;
  inFlight = undefined;
}

async function loadPopulation(desktopApi: DesktopApi | undefined): Promise<void> {
  const getNavigationSnapshot = desktopApi?.getNavigationSnapshot;
  if (!getNavigationSnapshot) {
    return;
  }

  const requestedRevision = getComposerMentionNavigationRevision();
  try {
    const snapshot = await getNavigationSnapshot();
    cachedPopulation = {
      directories: snapshot.directories,
      threads: snapshot.threads,
    };
    cachedAt = Date.now();
    // Capture the generation from request start. If a directory is registered
    // while this bridge call is in flight, the response may predate it and the
    // next picker open must fetch again.
    cachedRevision = requestedRevision;
    for (const subscriber of subscribers) {
      subscriber(cachedPopulation);
    }
  } catch {
    // A failed load leaves the popover with whatever it already had. An
    // autocomplete that cannot reach the bridge should offer nothing and
    // let the trigger stay literal, not raise an error over a transcript.
  }
}

function beginPopulationLoad(desktopApi: DesktopApi | undefined): void {
  if (inFlight || !desktopApi?.getNavigationSnapshot) {
    return;
  }
  const requestedRevision = getComposerMentionNavigationRevision();
  inFlight = loadPopulation(desktopApi).finally(() => {
    inFlight = undefined;
    // A registration can land while the old snapshot is in flight. Its
    // generation must receive its own fetch instead of waiting for the TTL.
    if (requestedRevision !== getComposerMentionNavigationRevision()) {
      beginPopulationLoad(desktopApi);
    }
  });
}

/**
 * The tracked directories and local threads a compact composer's `@` and
 * `#` popovers pick from.
 *
 * Deliberately lazy and deliberately shared. Lazy because a chat card that
 * never types a trigger should cost nothing beyond its transcript; shared
 * because several cards are open at once and they all want one snapshot.
 * `ensureLoaded` is what a popover calls when it opens — the hook itself
 * fetches nothing on mount.
 *
 * Skills are NOT served from here. They are scoped to a thread's linked
 * directories, so two cards genuinely have different skill lists and
 * `useThreadSkills` already owns that per-thread fetch and its
 * `skills/changed` invalidation.
 */
export function useComposerMentionSources(params: {
  desktopApi?: DesktopApi;
}): {
  directories: readonly NavigationDirectorySummary[];
  ensureLoaded: () => void;
  threads: readonly NavigationThreadSummary[];
} {
  const { desktopApi } = params;
  const [population, setPopulation] = useState<NavigationPopulation>(
    () => cachedPopulation ?? EMPTY_POPULATION,
  );

  useEffect(() => {
    const subscriber = (next: NavigationPopulation): void => {
      setPopulation(next);
    };
    subscribers.add(subscriber);
    // A card mounted after another already loaded starts from the cache
    // rather than waiting for the next `ensureLoaded`.
    if (cachedPopulation) {
      setPopulation(cachedPopulation);
    }
    return () => {
      subscribers.delete(subscriber);
    };
  }, []);

  useEffect(
    () => retainNavigationChangedSubscription(desktopApi),
    [desktopApi],
  );

  const ensureLoaded = useCallback((): void => {
    // Both guards are load-bearing, and not only against redundant work: a
    // host builds its sources object from the population this returns, so a
    // completed load changes that object's identity and re-runs whatever
    // effect asked for the load. Unguarded, that is a fetch loop rather
    // than a one-shot.
    if (
      inFlight
      || (
        cachedRevision === getComposerMentionNavigationRevision()
        && Date.now() - cachedAt < NAVIGATION_STALE_MS
      )
    ) {
      return;
    }
    beginPopulationLoad(desktopApi);
  }, [desktopApi]);

  return {
    directories: population.directories,
    ensureLoaded,
    threads: population.threads,
  };
}
