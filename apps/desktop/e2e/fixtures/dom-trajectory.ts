// A history of a few DOM attributes, for failures that are only legible as
// a SEQUENCE.
//
// The Windows lane produces failures whose symptom is a value that was
// correct when the spec checked it and wrong a few hundred milliseconds
// later. Reading the attribute again after the throw — which is what
// `star-map-composer-attachments.spec.ts` did — samples two instants and
// reports them as if they bounded the interval. They do not: a value that
// changed and changed back is invisible to both reads, and that is exactly
// the shape of the failures this recorder exists for.
//
// Electron traces carry no DOM snapshots, so a trajectory has to be
// collected while the app is alive or not at all.
//
// **Mutation-driven, not sampled.** The first version of this polled every
// 25ms, and on Windows it reported a Star Map composer that never left
// `detail:none` — while the spec's own `toBeEditable()` barrier passed in
// 5ms, which it cannot do against a blocked composer. The poller had been
// starved: the 271ms it was meant to cover is exactly when the spec drives
// three attachments (canvas encode, `DataTransfer`, a filesystem read) and
// saturates the renderer's main thread, so the timer fired either side of
// the window and the two identical samples collapsed into one. A
// `MutationObserver` cannot be starved that way — it delivers on a
// microtask after the DOM changes — and observing `childList` alongside
// the attributes covers the case a bare attribute observer misses, a node
// arriving with the values already on it (which is how a remount looks).
//
// The interval stays as a coarse liveness backstop only. Consecutive
// identical snapshots collapse, so a quiet surface costs a handful of lines
// however long it is watched.
import type { Page } from "@playwright/test";

/** Backstop only; every real transition arrives through the observer. */
const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_MAX_SAMPLES = 2_000;

/**
 * The renderer reloaded: every page-side global went with it, this one
 * included. Distinguishing that from "the element was never there" is the
 * whole reason the recorder plants a sentinel rather than just reading
 * attributes on demand.
 */
export const RECORDER_LOST =
  "<no trajectory: the page-side recorder is gone, so this renderer reloaded"
  + " (or navigated) after the recorder was installed>";

export type DomTrajectoryRecorder = {
  /** Deduped samples, oldest first, each already formatted for an error. */
  read: () => Promise<string[]>;
  /** One indented block, ready to append to a thrown message. */
  report: () => Promise<string>;
  stop: () => Promise<void>;
};

export async function recordDomTrajectory(
  page: Page,
  params: {
    /** The element whose attributes are sampled; the FIRST match is used. */
    selector: string;
    attributes: readonly string[];
    /**
     * Reported as `editable=`, from the first match inside the document.
     * Tiptap publishes the composer's live authorization here and nowhere
     * else, and it is a different element from the one carrying the
     * attributes above.
     */
    editableSelector?: string;
    intervalMs?: number;
    maxSamples?: number;
  },
): Promise<DomTrajectoryRecorder> {
  const key = `__pwragentDomTrajectory_${Math.random().toString(36).slice(2)}`;
  const options = {
    attributes: [...params.attributes],
    editableSelector: params.editableSelector ?? null,
    intervalMs: params.intervalMs ?? DEFAULT_INTERVAL_MS,
    key,
    maxSamples: params.maxSamples ?? DEFAULT_MAX_SAMPLES,
    selector: params.selector,
  };

  await page.evaluate((config) => {
    const host = globalThis as unknown as Record<string, unknown>;
    const samples: string[] = [];
    const origin = performance.now();
    let previous: string | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;

    const sample = (why: string): void => {
      const element = document.querySelector(config.selector);
      const editable = config.editableSelector
        ? document.querySelector(config.editableSelector)
        : undefined;
      const fields = [
        `present=${element ? "yes" : "no"}`,
        ...config.attributes.map(
          (name) => `${name}=${element?.getAttribute(name) ?? "<absent>"}`,
        ),
        ...(config.editableSelector
          ? [
            `editable=${
              editable?.getAttribute("contenteditable") ?? "<no editor>"
            }`,
          ]
          : []),
        `focus=${document.hasFocus()}`,
        `visibility=${document.visibilityState}`,
      ].join(" ");
      if (fields === previous) return;
      previous = fields;
      samples.push(
        `+${Math.round(performance.now() - origin)}ms ${why} ${fields}`,
      );
      if (samples.length >= config.maxSamples) {
        stop();
        samples.push("<recorder stopped: reached its sample cap>");
      }
    };

    const observer = new MutationObserver(() => {
      sample("changed");
    });
    const stop = (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      observer.disconnect();
    };

    sample("armed");
    observer.observe(document.documentElement, {
      attributeFilter: [
        ...config.attributes,
        "contenteditable",
        "class",
      ],
      attributes: true,
      childList: true,
      subtree: true,
    });
    timer = setInterval(() => {
      sample("backstop");
    }, config.intervalMs);
    host[config.key] = { read: () => [...samples], stop };
  }, options);

  const read = async (): Promise<string[]> => {
    try {
      return await page.evaluate((recorderKey) => {
        const recorder = (globalThis as unknown as Record<string, unknown>)[
          recorderKey
        ] as { read: () => string[] } | undefined;
        return recorder?.read();
      }, key) ?? [RECORDER_LOST];
    } catch (error) {
      // The page can be gone entirely by the time a failure is reported.
      // That is still a fact worth printing, not a second failure to raise.
      return [
        `<trajectory unreadable: ${
          error instanceof Error ? error.message : String(error)
        }>`,
      ];
    }
  };

  return {
    read,
    report: async () => (await read()).map((line) => `    ${line}`).join("\n"),
    stop: async () => {
      await page
        .evaluate((recorderKey) => {
          const recorder = (globalThis as unknown as Record<string, unknown>)[
            recorderKey
          ] as { stop: () => void } | undefined;
          recorder?.stop();
        }, key)
        .catch(() => undefined);
    },
  };
}
