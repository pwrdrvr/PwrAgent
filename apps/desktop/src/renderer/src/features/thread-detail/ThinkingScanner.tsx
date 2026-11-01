type ThinkingScannerProps = {
  compact?: boolean;
};

/**
 * A running turn's mark: a lit beam held at the centre of its track, which
 * makes one scan — out to the right edge, across to the left, back to centre —
 * every few seconds and then holds still.
 *
 * Still between scans, on purpose. The former sweep looped forever, and a
 * running compositor animation costs work on every frame of the display even
 * where its stepped output does not change: the compositor still wakes on each
 * vsync to tick it. A stopped beam costs nothing. The held pose (`app.css`) is
 * the bright, centred one, so a scanner between scans still reads as running
 * against its idle counterpart, the empty `.signal-count__dormant-scanner`.
 *
 * One timer for the whole window, not one animation per beam. When a scan is
 * due, every visible beam starts a finite Web Animation in the same task, so
 * they share one start time and every beam moves in the same frames. The timer
 * is aligned to the wall clock, so other windows scan in the same frames too.
 * There is no registry of mounted beams: each scan reads the live set from the
 * DOM, so an unmounted beam cannot leak, and the timer stops once no beam is
 * left. A mount restarts it.
 */
export const THINKING_SCAN_PERIOD_MS = 4500;
export const THINKING_SCAN_DURATION_MS = 1800;
/** Named for the rendering capture's animation allowlist. */
export const THINKING_SCAN_ANIMATION_ID = "pwragent-thinking-scanner-scan";

// ~30 position changes a second while moving, the cadence #3102 set for the
// former sweep: a quarter of the scan out, half across, a quarter back.
const SCAN_STEPS = { out: 14, across: 27, back: 14 } as const;

const keyframesByTravel = new Map<number, Keyframe[]>();

/**
 * Pixel keyframes for one track width, read once per width from the beam's
 * `--thinking-scanner-travel`. Each step is then a plain transform on the
 * beam's existing layer: no paint and no raster during a scan.
 */
function scanKeyframes(travel: number): Keyframe[] {
  let keyframes = keyframesByTravel.get(travel);
  if (!keyframes) {
    const centre = `translateX(${travel / 2}px)`;
    keyframes = [
      { offset: 0, transform: centre, easing: `steps(${SCAN_STEPS.out}, end)` },
      { offset: 0.25, transform: `translateX(${travel}px)`, easing: `steps(${SCAN_STEPS.across}, end)` },
      { offset: 0.75, transform: "translateX(0px)", easing: `steps(${SCAN_STEPS.back}, end)` },
      { offset: 1, transform: centre },
    ];
    keyframesByTravel.set(travel, keyframes);
  }
  return keyframes;
}

const reducedMotion = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)")
  : null;

// The held pose IS the reduced-motion pose, so the preference only has to stop
// new scans. One already moving is cancelled back to the pose at once rather
// than left to finish.
reducedMotion?.addEventListener("change", () => {
  if (!reducedMotion.matches || typeof document.getAnimations !== "function") {
    return;
  }
  for (const animation of document.getAnimations()) {
    if (animation.id === THINKING_SCAN_ANIMATION_ID) {
      animation.cancel();
    }
  }
});

let scanTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleNextScan(): void {
  if (scanTimer !== undefined) {
    return;
  }
  scanTimer = setTimeout(runScan, THINKING_SCAN_PERIOD_MS - (Date.now() % THINKING_SCAN_PERIOD_MS));
}

function isOnScreen(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0
    && rect.height > 0
    && rect.bottom > 0
    && rect.right > 0
    && rect.top < window.innerHeight
    && rect.left < window.innerWidth;
}

function runScan(): void {
  scanTimer = undefined;
  const beams = document.querySelectorAll<HTMLElement>(".thinking-scanner__beam");
  if (beams.length === 0) {
    return;
  }

  // A hidden or occluded window, or an offscreen beam, would tick for frames
  // that are never drawn. The next scan finds any beam that has come back.
  if (document.visibilityState === "visible" && !reducedMotion?.matches) {
    for (const beam of beams) {
      if (typeof beam.animate !== "function" || !isOnScreen(beam)) {
        continue;
      }
      const travel = Number.parseFloat(getComputedStyle(beam).getPropertyValue("--thinking-scanner-travel"));
      if (!Number.isFinite(travel)) {
        continue;
      }
      beam.animate(scanKeyframes(travel), {
        duration: THINKING_SCAN_DURATION_MS,
        id: THINKING_SCAN_ANIMATION_ID,
      });
    }
  }
  scheduleNextScan();
}

function startScanning(element: HTMLDivElement | null): void {
  if (element) {
    scheduleNextScan();
  }
}

export function ThinkingScanner(props: ThinkingScannerProps = {}) {
  return (
    <div
      aria-hidden="true"
      className={`thinking-scanner${props.compact ? " thinking-scanner--mini" : ""}`}
    >
      <div className="thinking-scanner__beam" ref={startScanning} />
    </div>
  );
}
