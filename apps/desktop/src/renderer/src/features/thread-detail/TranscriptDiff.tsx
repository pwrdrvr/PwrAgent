import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { AppServerThreadActivityDetail } from "@pwragent/shared/contracts/normalized-app-server";
import { parseUnifiedDiff } from "../../../../shared/unified-diff";
import { useDesktopApi } from "../../lib/desktop-api";
import { useTranscriptScrollportHeight } from "./transcript-scroll-fit";

type TranscriptDiffProps = {
  detail: AppServerThreadActivityDetail;
  /**
   * When the parent already shows the file path and additions/removals
   * stats (e.g. the LiveWorkRail's expanded file row), pass `true` to
   * hide the redundant `transcript-diff__path` + stats in the diff
   * header.
   */
  compact?: boolean;
};

export const TranscriptDiff = memo(function TranscriptDiff(props: TranscriptDiffProps) {
  const [fetchedDiff, setFetchedDiff] = useState<{
    refKey?: string;
    diff?: string;
    omittedReason?: string;
    loading: boolean;
  }>({ loading: false });
  const diff = props.detail.fileDiff;
  const desktopApi = useDesktopApi();
  const rowsRef = useRef<HTMLDivElement>(null);
  const diffRefs = useMemo(
    () => diff?.diffRefs ?? (diff?.diffRef ? [diff.diffRef] : []),
    [diff?.diffRef, diff?.diffRefs],
  );
  const diffRefKey = diffRefs.map((ref) => ref.key).join("|");
  const inlineDiffText = diff?.omittedReason ? "" : diff?.diff ?? "";
  const shouldFetchDiff = Boolean(
    diffRefs.length > 0 && !diff?.diff && !diff?.omittedReason,
  );
  const diffText = shouldFetchDiff ? fetchedDiff.diff ?? "" : inlineDiffText;
  const omittedReason = diff?.omittedReason ?? fetchedDiff.omittedReason;
  const rows = useMemo(() => parseUnifiedDiff(diffText), [diffText]);

  useEffect(() => {
    if (diffRefs.length === 0 || !shouldFetchDiff) {
      setFetchedDiff((current) =>
        !current.loading && !current.refKey && !current.diff && !current.omittedReason
          ? current
          : { loading: false },
      );
      return;
    }

    const getThreadFileDiff = desktopApi?.getThreadFileDiff;
    if (!getThreadFileDiff) {
      setFetchedDiff({
        refKey: diffRefKey,
        loading: false,
        omittedReason: "Diff is unavailable in this renderer.",
      });
      return;
    }

    let active = true;
    setFetchedDiff({ refKey: diffRefKey, loading: true });
    void Promise.all(diffRefs.map((ref) => getThreadFileDiff({ ref })))
      .then((responses) => {
        if (!active) {
          return;
        }
        const omitted = responses.find((response) => response.omittedReason);
        setFetchedDiff({
          refKey: diffRefKey,
          diff: omitted
            ? undefined
            : responses
                .map((response) => response.diff)
                .filter((value): value is string => Boolean(value))
                .join("\n"),
          omittedReason: omitted?.omittedReason,
          loading: false,
        });
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setFetchedDiff({
          refKey: diffRefKey,
          loading: false,
          omittedReason: "Diff is unavailable for this thread entry.",
        });
      });

    return () => {
      active = false;
    };
  }, [desktopApi, diffRefKey, diffRefs, shouldFetchDiff]);

  // The rows mount only once the diff has loaded.
  useTranscriptScrollportHeight(
    rowsRef,
    Boolean(
      diff
        && !omittedReason
        && !(shouldFetchDiff && fetchedDiff.loading)
        && rows.length > 0,
    ),
  );

  if (!diff) {
    return null;
  }

  if (omittedReason) {
    return (
      <div className="transcript-diff transcript-diff--omitted">
        {props.detail.path && !props.compact ? (
          <p className="transcript-diff__path" title={props.detail.path}>
            {props.detail.path}
          </p>
        ) : null}
        <p className="transcript-diff__omitted">{omittedReason}</p>
      </div>
    );
  }

  if (fetchedDiff.loading && fetchedDiff.refKey === diffRefKey) {
    return (
      <div className="transcript-diff transcript-diff--omitted">
        {props.detail.path && !props.compact ? (
          <p className="transcript-diff__path" title={props.detail.path}>
            {props.detail.path}
          </p>
        ) : null}
        <p className="transcript-diff__omitted">Loading diff...</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className={`transcript-diff${props.compact ? " transcript-diff--compact" : ""}`}>
      {props.detail.path && !props.compact ? (
        <p className="transcript-diff__path" title={props.detail.path}>
          {props.detail.path}
        </p>
      ) : null}

      {!props.compact ? (
        <div className="transcript-diff__toolbar">
          <div className="transcript-diff__stats" aria-label="Diff summary">
            <span className="transcript-diff__stat transcript-diff__stat--removed">
              -{diff.removals}
            </span>
            <span className="transcript-diff__stat transcript-diff__stat--added">
              +{diff.additions}
            </span>
          </div>
        </div>
      ) : null}

      <div
        ref={rowsRef}
        className="transcript-diff__rows"
        role="table"
        aria-label={`${props.detail.label} diff`}
        tabIndex={0}
      >
        {rows.map((row, index) => {
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
});

function formatLineNumber(value: number | undefined): string {
  if (typeof value !== "number") {
    return "";
  }
  return String(value);
}
