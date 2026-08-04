type ThinkingScannerProps = {
  compact?: boolean;
};

function syncThinkingScannerAnimation(element: HTMLDivElement | null): void {
  if (!element || typeof element.getAnimations !== "function") {
    return;
  }

  for (const animation of element.getAnimations()) {
    // CSS animations normally start when their element's styles resolve. That
    // leaves scanners mounted during separate, busy renderer commits with
    // permanently different phases. Pin each animation to the document
    // timeline's origin instead: the compositor advances every scanner from
    // one shared epoch without a React tick or a root-level style mutation.
    animation.startTime = 0;
  }
}

export function ThinkingScanner(props: ThinkingScannerProps = {}) {
  return (
    <div
      aria-hidden="true"
      className={`thinking-scanner${props.compact ? " thinking-scanner--mini" : ""}`}
    >
      <div className="thinking-scanner__beam" ref={syncThinkingScannerAnimation} />
    </div>
  );
}
