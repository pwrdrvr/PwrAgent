import { useRef } from "react";
import type { CSSProperties } from "react";

type ThinkingScannerProps = {
  compact?: boolean;
};

const SCAN_DURATION_MS = 1800;

type ThinkingScannerStyle = CSSProperties & {
  "--thinking-scanner-delay": string;
};

function getThinkingScannerPhaseMs(): number {
  if (typeof performance === "undefined" || typeof performance.now !== "function") {
    return 0;
  }

  return performance.now() % SCAN_DURATION_MS;
}

export function ThinkingScanner(props: ThinkingScannerProps = {}) {
  const phaseMsRef = useRef<number | undefined>(undefined);
  if (phaseMsRef.current === undefined) {
    phaseMsRef.current = getThinkingScannerPhaseMs();
  }

  const style: ThinkingScannerStyle = {
    "--thinking-scanner-delay": `${-phaseMsRef.current}ms`,
  };

  return (
    <div
      aria-hidden="true"
      className={`thinking-scanner${props.compact ? " thinking-scanner--mini" : ""}`}
      style={style}
    >
      <div className="thinking-scanner__beam" />
    </div>
  );
}
