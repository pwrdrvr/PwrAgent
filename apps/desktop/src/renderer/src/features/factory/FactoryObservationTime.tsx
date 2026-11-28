export function FactoryObservationTime({ label, value }: { label: string; value: number }) {
  const date = new Date(value);
  return (
    <span className="factory-context">
      {label} <time dateTime={date.toISOString()}>{date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>
    </span>
  );
}
