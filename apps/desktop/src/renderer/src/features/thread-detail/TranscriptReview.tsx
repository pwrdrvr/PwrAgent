import type {
  AppServerReviewFinding,
  AppServerThreadReviewEntry,
  DesktopApplicationsSnapshot,
} from "@pwragent/shared";
import { useCallback, useMemo, type MouseEvent } from "react";
import { normalizeReviewDisplayText } from "../../../../shared/review-command";
import type { DesktopApi } from "../../lib/desktop-api";
import { ThreadMarkdown } from "./ThreadMarkdown";

type TranscriptReviewProps = {
  applications?: DesktopApplicationsSnapshot;
  directoryPaths?: string[];
  desktopApi?: Pick<DesktopApi, "openApplication">;
  entry: AppServerThreadReviewEntry;
};

function formatConfidence(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return `${Math.round(value * 100)}% confidence`;
}

function formatPath(path: string, directoryPaths: string[] | undefined): string {
  const normalized = normalizePath(path);
  const matchingDirectory = normalizedDirectoryPaths(directoryPaths)
    .filter(
      (directoryPath) =>
        normalized === directoryPath || normalized.startsWith(`${directoryPath}/`)
    )
    .sort((left, right) => right.length - left.length)[0];

  if (!matchingDirectory) {
    return normalized || path;
  }

  return normalized.slice(matchingDirectory.length).replace(/^\//, "") || normalized;
}

function priorityLabel(priority: number | undefined): string {
  return typeof priority === "number" ? `P${priority}` : "P?";
}

function priorityClassName(priority: number | undefined): string {
  const normalizedPriority =
    typeof priority === "number" && priority >= 0 && priority <= 3
      ? `p${priority}`
      : "unknown";

  return `transcript-review__priority transcript-review__priority--${normalizedPriority}`;
}

function shouldHideReviewBody(summary: string, review: string): boolean {
  const trimmedReview = review.trim();
  return (
    trimmedReview === "" ||
    trimmedReview === summary.trim() ||
    normalizeReviewDisplayText(trimmedReview) === summary.trim()
  );
}

function parsePlainReview(review: string): {
  explanation: string;
  findings: AppServerReviewFinding[];
} {
  const [rawExplanation, rawComments] = review.split(
    /\n\s*(?:Full\s+)?Review comments?:\s*\n/i
  );
  if (!rawComments) {
    return {
      explanation: review,
      findings: [],
    };
  }

  const findingPattern =
    /(?:^|\n)- \[P(\d+)\] ([^\n—]+?)\s+—\s+(.+?):(\d+)(?:-(\d+))?\n([\s\S]*?)(?=\n- \[P\d+\] |\n*$)/g;
  const findings: AppServerReviewFinding[] = [];

  for (const match of rawComments.matchAll(findingPattern)) {
    const priority = Number.parseInt(match[1] ?? "", 10);
    const title = match[2]?.trim();
    const absoluteFilePath = match[3]?.trim();
    const start = Number.parseInt(match[4] ?? "", 10);
    const end = Number.parseInt(match[5] ?? match[4] ?? "", 10);
    const body = match[6]?.trim();

    if (
      !title ||
      !absoluteFilePath ||
      !body ||
      !Number.isInteger(priority) ||
      !Number.isInteger(start) ||
      !Number.isInteger(end)
    ) {
      continue;
    }

    findings.push({
      title,
      body,
      priority,
      confidence_score: 0,
      code_location: {
        absolute_file_path: absoluteFilePath,
        line_range: {
          start,
          end,
        },
      },
    });
  }

  return {
    explanation: rawExplanation.trim(),
    findings,
  };
}

export function TranscriptReview(props: TranscriptReviewProps) {
  const editorApplication = useMemo(
    () =>
      props.applications?.editors.find(
        (application) =>
          application.canOpenWorkspace &&
          application.id === props.applications?.preferredEditorId.value
      ) ?? props.applications?.editors.find((application) => application.canOpenWorkspace),
    [props.applications]
  );
  const openLocalFile = useCallback(
    (
      event: MouseEvent<HTMLAnchorElement>,
      targetPath: string,
      targetLine: number
    ): void => {
      if (!editorApplication || !props.desktopApi?.openApplication) {
        return;
      }

      event.preventDefault();
      void props.desktopApi
        .openApplication({
          applicationId: editorApplication.id,
          kind: "editor",
          targetPath,
          targetLine,
        })
        .catch((error: unknown) => {
          console.error("Failed to open review file link", error);
        });
    },
    [editorApplication, props.desktopApi]
  );
  const output = props.entry.output;
  const plainReview = output ? undefined : parsePlainReview(props.entry.review);
  const findings = output?.findings ?? plainReview?.findings ?? [];
  const findingCount = output?.findings.length;
  const summary =
    props.entry.displayText ??
    (findingCount === undefined
      ? "Code review"
      : `${findingCount} review ${findingCount === 1 ? "finding" : "findings"}`);
  const body =
    output?.overall_explanation ??
    (shouldHideReviewBody(summary, props.entry.review)
      ? ""
      : plainReview?.explanation ?? props.entry.review);
  const confidence = formatConfidence(output?.overall_confidence_score);
  const correctness =
    output?.overall_correctness === "patch is correct"
      ? "Patch correct"
      : output?.overall_correctness === "patch is incorrect"
        ? "Patch needs work"
        : undefined;

  return (
    <aside className="transcript-review" role="group" aria-label="Code review">
      <header className="transcript-review__header">
        <div className="transcript-review__copy">
          <p className="transcript-review__eyebrow">Review</p>
          <p className="transcript-review__summary">{summary}</p>
          {body ? (
            <ThreadMarkdown
              applications={props.applications}
              className="transcript-review__body"
              desktopApi={props.desktopApi}
              text={body}
            />
          ) : null}
        </div>
        {props.entry.createdAt ? (
          <time className="transcript-message__time">
            {new Intl.DateTimeFormat(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }).format(props.entry.createdAt)}
          </time>
        ) : null}
      </header>

      {output ? (
        <div className="transcript-review__meta" aria-label="Review summary">
          {correctness ? (
            <span
              className={`transcript-review__badge transcript-review__badge--${
                output.overall_correctness === "patch is correct" ? "success" : "danger"
              }`}
            >
              {correctness}
            </span>
          ) : null}
          <span className="transcript-review__badge">
            {findingCount} {findingCount === 1 ? "finding" : "findings"}
          </span>
          {confidence ? (
            <span className="transcript-review__badge">{confidence}</span>
          ) : null}
        </div>
      ) : null}

      {findings.length > 0 ? (
        <ol className="transcript-review__findings">
          {findings.map((finding, index) => {
            const range = finding.code_location.line_range;
            const absoluteFilePath = normalizePath(finding.code_location.absolute_file_path);
            const displayPath = formatPath(absoluteFilePath, props.directoryPaths);
            return (
              <li
                className="transcript-review__finding"
                key={`${finding.code_location.absolute_file_path}:${range.start}:${index}`}
              >
                <div className="transcript-review__finding-head">
                  <span className={priorityClassName(finding.priority)}>
                    {priorityLabel(finding.priority)}
                  </span>
                  <span className="transcript-review__finding-title">
                    {finding.title}
                  </span>
                </div>
                <ThreadMarkdown
                  applications={props.applications}
                  className="transcript-review__finding-body"
                  desktopApi={props.desktopApi}
                  text={finding.body}
                />
                <div className="transcript-review__location">
                  <a
                    className="transcript-review__location-path"
                    href={fileHref(absoluteFilePath, range.start)}
                    onClick={(event) => {
                      openLocalFile(event, absoluteFilePath, range.start);
                    }}
                    rel="noopener noreferrer"
                    target="_blank"
                    title={`${absoluteFilePath}:${range.start}`}
                  >
                    {displayPath}
                  </a>
                  <span className="transcript-review__location-line">
                    {range.start === range.end
                      ? `Line ${range.start}`
                      : `Lines ${range.start}-${range.end}`}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      ) : output ? (
        <p className="transcript-review__empty">No findings.</p>
      ) : null}
    </aside>
  );
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizedDirectoryPaths(paths: string[] | undefined): string[] {
  return (paths ?? [])
    .map((path) => normalizePath(path))
    .filter((path) => path.startsWith("/"));
}

function fileHref(path: string, line: number): string {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `file://${encodedPath}:${line}`;
}
