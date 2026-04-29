import { useEffect } from "react";

type ThinkingScannerProps = {
  compact?: boolean;
};

const SCAN_DURATION_MS = 1800;
const FULL_SCAN_TRAVEL_PX = 44;
const MINI_SCAN_TRAVEL_PX = 10;
let activeScannerCount = 0;
let animationFrameId: number | undefined;

function easedPingPong(progress: number): number {
  const linear = progress < 0.5 ? progress * 2 : (1 - progress) * 2;

  return 0.5 - Math.cos(linear * Math.PI) / 2;
}

function setThinkingScannerProgress(timestamp: number) {
  const progress = (timestamp % SCAN_DURATION_MS) / SCAN_DURATION_MS;
  const easedProgress = easedPingPong(progress);
  const rootStyle = document.documentElement.style;

  rootStyle.setProperty("--thinking-scanner-progress", easedProgress.toFixed(4));
  rootStyle.setProperty(
    "--thinking-scanner-full-offset",
    `${(easedProgress * FULL_SCAN_TRAVEL_PX).toFixed(2)}px`
  );
  rootStyle.setProperty(
    "--thinking-scanner-mini-offset",
    `${(easedProgress * MINI_SCAN_TRAVEL_PX).toFixed(2)}px`
  );

  animationFrameId = window.requestAnimationFrame(setThinkingScannerProgress);
}

function startThinkingScannerClock() {
  activeScannerCount += 1;

  if (activeScannerCount === 1) {
    animationFrameId = window.requestAnimationFrame(setThinkingScannerProgress);
  }
}

function stopThinkingScannerClock() {
  activeScannerCount = Math.max(0, activeScannerCount - 1);

  if (activeScannerCount === 0 && animationFrameId !== undefined) {
    window.cancelAnimationFrame(animationFrameId);
    animationFrameId = undefined;
  }
}

export function ThinkingScanner(props: ThinkingScannerProps = {}) {
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof document === "undefined" ||
      typeof window.requestAnimationFrame !== "function" ||
      typeof window.cancelAnimationFrame !== "function"
    ) {
      return;
    }

    startThinkingScannerClock();

    return () => {
      stopThinkingScannerClock();
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className={`thinking-scanner${props.compact ? " thinking-scanner--mini" : ""}`}
    >
      <div className="thinking-scanner__beam" />
    </div>
  );
}
