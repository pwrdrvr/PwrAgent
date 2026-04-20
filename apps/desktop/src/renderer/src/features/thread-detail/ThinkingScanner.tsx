type ThinkingScannerProps = {
  compact?: boolean;
};

export function ThinkingScanner(props: ThinkingScannerProps = {}) {
  return (
    <div
      aria-hidden="true"
      className={`thinking-scanner${props.compact ? " thinking-scanner--mini" : ""}`}
    >
      <div className="thinking-scanner__beam" />
    </div>
  );
}
