import type {
  AppServerReviewFinding,
  AppServerReviewOutput,
  AppServerThreadReviewEntry,
  DesktopApplicationsSnapshot,
  MarkdownFileViewerContext,
} from "@pwragent/shared";
import { formatPathRelativeToDirectories } from "@pwragent/shared";
import { useCallback, useMemo, type MouseEvent } from "react";
import { normalizeReviewDisplayText } from "../../../../shared/review-command";
import { formatBackendLabel } from "../../lib/backend-label";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ThreadLinkSource } from "../../lib/thread-links";
import { ReviewProvenance } from "./ReviewProvenance";
import { ThreadMarkdown } from "./ThreadMarkdown";

type TranscriptReviewProps = {
  applications?: DesktopApplicationsSnapshot;
  directoryPaths?: string[];
  desktopApi?: Pick<
    DesktopApi,
    "openApplication" | "openMarkdownFileViewer" | "readMarkdownFile"
  >;
  entry: AppServerThreadReviewEntry;
  fileViewerContext?: MarkdownFileViewerContext;
  threadLinkSource?: ThreadLinkSource;
};

/**
 * The percentage is fused into the verdict badge rather than standing beside it
 * as its own pill. Alone, "98% confidence" names no subject: a reader can take
 * it for a quality score on the code just as easily as for the reviewer's
 * confidence in its own verdict. Printed inside the verdict, it can only modify
 * the verdict.
 *
 * `normalizeReviewConfidenceScore` has already dropped values that cannot mean
 * anything, so an absent score here means the reviewer reported none and the
 * verdict is shown without a number.
 */
function formatVerdict(
  correctness: AppServerReviewOutput["overall_correctness"] | undefined,
  confidence: number | undefined,
): string | undefined {
  if (!correctness) {
    return undefined;
  }
  const verdict =
    correctness === "patch is correct" ? "Patch correct" : "Patch needs work";
  return confidence === undefined
    ? verdict
    : `${verdict} · ${Math.round(confidence * 100)}%`;
}

function formatVerdictTooltip(
  correctness: AppServerReviewOutput["overall_correctness"],
  confidence: number | undefined,
  reviewer: AppServerThreadReviewEntry["reviewer"],
): string {
  const verdict =
    correctness === "patch is correct"
      ? "the patch is correct"
      : "the patch needs work";
  const who = reviewer?.model?.trim() || "The reviewer";
  if (confidence === undefined) {
    return `${who} judged that ${verdict}. It reported no confidence in that judgement.`;
  }
  return `How sure ${who} is that its own verdict — ${verdict} — is right. It is not a score for the code, and not a judgement about whether the change is ready to merge.`;
}

function formatPath(path: string, directoryPaths: string[] | undefined): string {
  return formatPathRelativeToDirectories(normalizePath(path), directoryPaths);
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

/**
 * The transcript scrolls, so the CSS pseudo-element tooltip would be clipped
 * against the scroll container for any card near its top edge. The portalled
 * tooltip escapes it, and `aria-describedby` is what makes the explanation
 * reachable to a screen reader — the badge's own text is the verdict, and
 * folding the explanation into its label would rename the thing rather than
 * describe it.
 */
function ReviewVerdictBadge(props: {
  confidence: number | undefined;
  correctness: NonNullable<AppServerReviewOutput["overall_correctness"]>;
  reviewer: AppServerThreadReviewEntry["reviewer"];
  verdict: string;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const text = formatVerdictTooltip(
    props.correctness,
    props.confidence,
    props.reviewer
  );

  return (
    <>
      <span
        aria-describedby={tooltip.visible ? tooltip.tooltipId : undefined}
        className={`transcript-review__badge transcript-review__badge--${
          props.correctness === "patch is correct" ? "success" : "danger"
        }`}
        tabIndex={0}
        onBlur={tooltip.hide}
        onFocus={(event) => tooltip.show(event.currentTarget, text)}
        onMouseEnter={(event) =>
          tooltip.showAfterDelay(event.currentTarget, text)
        }
        onMouseLeave={tooltip.hide}
      >
        {props.verdict}
      </span>
      {tooltip.tooltipNode}
    </>
  );
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
  const verdict = formatVerdict(
    output?.overall_correctness,
    output?.overall_confidence_score,
  );
  const reviewer = props.entry.reviewer;

  return (
    <aside className="transcript-review" role="group" aria-label="Code review">
      <header className="transcript-review__header">
        <div className="transcript-review__copy">
          <p className="transcript-review__eyebrow">Review</p>
          <p className="transcript-review__summary">{summary}</p>
          {props.entry.context ? (
            <ReviewProvenance context={props.entry.context} />
          ) : null}
          {body ? (
            <ThreadMarkdown
              applications={props.applications}
              className="transcript-review__body"
              desktopApi={props.desktopApi}
              fileViewerContext={props.fileViewerContext}
              text={body}
              threadLinkSource={props.threadLinkSource}
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
          {verdict ? (
            <ReviewVerdictBadge
              confidence={output.overall_confidence_score}
              correctness={output.overall_correctness}
              reviewer={reviewer}
              verdict={verdict}
            />
          ) : null}
          <span className="transcript-review__badge">
            {findingCount} {findingCount === 1 ? "finding" : "findings"}
          </span>
        </div>
      ) : null}

      {reviewer ? (
        <div className="transcript-review__meta" aria-label="Review runtime">
          <span className="transcript-review__badge">
            {formatBackendLabel(reviewer.backend)}
          </span>
          {reviewer.model ? (
            <span className="transcript-review__badge">{reviewer.model}</span>
          ) : null}
          {reviewer.reasoningEffort ? (
            <span className="transcript-review__badge">
              {reviewer.reasoningEffort}
            </span>
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
                  fileViewerContext={props.fileViewerContext}
                  text={finding.body}
                  threadLinkSource={props.threadLinkSource}
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

function fileHref(path: string, line: number): string {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `file://${encodedPath}:${line}`;
}
