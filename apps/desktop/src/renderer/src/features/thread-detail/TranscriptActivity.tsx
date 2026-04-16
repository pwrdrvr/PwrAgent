import type { AppServerThreadActivityEntry } from "@pwragnt/shared";

type TranscriptActivityProps = {
  entry: AppServerThreadActivityEntry;
};

export function TranscriptActivity(props: TranscriptActivityProps) {
  return (
    <aside className="transcript-activity">
      <header className="transcript-activity__header">
        <span className="transcript-activity__label">{props.entry.summary}</span>
        {props.entry.createdAt ? (
          <time className="transcript-activity__time">
            {new Intl.DateTimeFormat(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit"
            }).format(props.entry.createdAt)}
          </time>
        ) : null}
      </header>

      {props.entry.details.length > 0 ? (
        <ul className="transcript-activity__details">
          {props.entry.details.map((detail) => (
            <li key={detail.id} className="transcript-activity__detail">
              {detail.label}
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}
