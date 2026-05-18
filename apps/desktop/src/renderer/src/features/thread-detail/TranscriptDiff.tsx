import { useEffect, useMemo, useState } from "react";
import type { AppServerThreadActivityDetail } from "@pwragent/shared";
import {
  buildDiffView,
  getFocusedDiffEligibility,
  parseUnifiedDiff,
  summarizeHunksForFocus,
  type DiffView
} from "../../../../shared/diff-focus";
import { useDesktopApi } from "../../lib/desktop-api";

type TranscriptDiffProps = {
  detail: AppServerThreadActivityDetail;
  /**
   * When the parent already shows the file path and additions/removals
   * stats (e.g. the LiveWorkRail's expanded file row), pass `true` to
   * hide the redundant `transcript-diff__path` + stats in the diff
   * header. The zoom toggle still renders.
   */
  compact?: boolean;
};

export function TranscriptDiff(props: TranscriptDiffProps) {
  const [isZoomedIn, setIsZoomedIn] = useState(false);
  const [focusedView, setFocusedView] = useState<DiffView | null>(null);
  const diff = props.detail.fileDiff;
  const desktopApi = useDesktopApi();
  const parsed = useMemo(() => parseUnifiedDiff(diff?.diff ?? ""), [diff?.diff]);
  const eligibility = useMemo(() => getFocusedDiffEligibility(parsed), [parsed]);
  const hunkSummaries = useMemo(() => summarizeHunksForFocus(parsed), [parsed]);
  const fullView = useMemo(() => buildDiffView(parsed, { mode: "full" }), [parsed]);

  useEffect(() => {
    setIsZoomedIn(false);
    setFocusedView(null);
  }, [diff?.diff, props.detail.path]);

  useEffect(() => {
    if (!diff || !eligibility.eligible || !desktopApi?.analyzeFocusedDiff) {
      return;
    }

    let active = true;

    void desktopApi
      .analyzeFocusedDiff({
        filePath: props.detail.path,
        diff: diff.diff,
        hunks: hunkSummaries
      })
      .then((response) => {
        if (!active || response.mode !== "focused" || response.hiddenHunkIndices.length === 0) {
          return;
        }

        setFocusedView(
          buildDiffView(parsed, {
            mode: "condensed",
            hiddenHunkIndices: response.hiddenHunkIndices
          })
        );
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setFocusedView(null);
      });

    return () => {
      active = false;
    };
  }, [desktopApi, diff, eligibility.eligible, hunkSummaries, parsed, props.detail.path]);

  const defaultView = useMemo(() => {
    if (!eligibility.eligible) {
      return fullView;
    }

    return focusedView ?? buildDiffView(parsed, { mode: "condensed" });
  }, [eligibility.eligible, focusedView, fullView, parsed]);
  const visibleView = isZoomedIn ? fullView : defaultView;

  if (!diff || fullView.rows.length === 0) {
    return null;
  }

  const hiddenSummary = !isZoomedIn ? formatHiddenSummary(defaultView) : null;

  return (
    <div className="transcript-diff">
      {props.detail.path && !props.compact ? (
        <p className="transcript-diff__path" title={props.detail.path}>
          {props.detail.path}
        </p>
      ) : null}

      <div className="transcript-diff__toolbar">
        <div className="transcript-diff__meta">
          {props.compact ? null : (
            <div className="transcript-diff__stats" aria-label="Diff summary">
              <span className="transcript-diff__stat transcript-diff__stat--removed">
                -{diff.removals}
              </span>
              <span className="transcript-diff__stat transcript-diff__stat--added">
                +{diff.additions}
              </span>
            </div>
          )}
          {hiddenSummary ? (
            <span className="transcript-diff__summary">{hiddenSummary}</span>
          ) : null}
        </div>
        {defaultView.hasHiddenContent ? (
          <button
            type="button"
            className="button button--ghost transcript-diff__toggle"
            onClick={() => {
              setIsZoomedIn((current) => !current);
            }}
          >
            {isZoomedIn ? "Zoom out" : "Zoom in"}
          </button>
        ) : null}
      </div>

      <div className="transcript-diff__rows" role="table" aria-label={`${props.detail.label} diff`}>
        {visibleView.rows.map((row, index) => {
          if (row.kind === "separator") {
            return (
              <div
                key={`separator-${index}`}
                className="transcript-diff__separator"
                role="row"
              >
                {row.count} unmodified line{row.count === 1 ? "" : "s"} skipped
              </div>
            );
          }

          if (row.kind === "hunk") {
            return (
              <div key={`hunk-${index}`} className="transcript-diff__hunk" role="row">
                {row.text}
              </div>
            );
          }

          const oldNumber = row.kind === "added" ? undefined : row.oldNumber;
          const newNumber = row.kind === "removed" ? undefined : row.newNumber;

          return (
            <div
              key={`${row.kind}-${oldNumber ?? "na"}-${newNumber ?? "na"}-${index}`}
              className={`transcript-diff__row transcript-diff__row--${row.kind}`}
              role="row"
            >
              <span className="transcript-diff__line-number">
                {formatLineNumber(oldNumber)}
              </span>
              <span className="transcript-diff__line-number">
                {formatLineNumber(newNumber)}
              </span>
              <span className="transcript-diff__symbol" aria-hidden="true">
                {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}
              </span>
              <code className="transcript-diff__text">{row.text || " "}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatLineNumber(value: number | undefined): string {
  if (typeof value !== "number") {
    return "";
  }
  return String(value);
}

function formatHiddenSummary(view: DiffView): string | null {
  const parts: string[] = [];

  if (view.hiddenHunkCount > 0) {
    parts.push(`${view.hiddenHunkCount} hunk${view.hiddenHunkCount === 1 ? "" : "s"} hidden`);
  }

  if (view.hiddenContextLineCount > 0) {
    parts.push(
      `${view.hiddenContextLineCount} line${view.hiddenContextLineCount === 1 ? "" : "s"} skipped`
    );
  }

  return parts.length > 0 ? parts.join(", ") : null;
}
