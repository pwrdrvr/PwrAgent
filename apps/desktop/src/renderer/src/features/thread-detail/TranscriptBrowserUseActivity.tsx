import { useId, type ReactNode } from "react";
import {
  formatBrowserHandoffLabel,
  formatBrowserUrlDisplay,
} from "@pwragent/shared/codex-browser-use";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadBrowserUsePresentation,
  AppServerThreadImagePart,
} from "@pwragent/shared/contracts/normalized-app-server";
import { GlobeIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { TranscriptCopyButton } from "./TranscriptCopyButton";
import { TranscriptImage } from "./TranscriptImage";

type TranscriptBrowserUseActivityProps = {
  browserUse: AppServerThreadBrowserUsePresentation;
  copyText: string;
  desktopApi?: Pick<DesktopApi, "copyText">;
  detailsContent?: ReactNode;
  detailsId?: string;
  displaySummary: string;
  entry: AppServerThreadActivityEntry;
  hasDetails: boolean;
  imagesContent?: ReactNode;
  isExpanded: boolean;
  onOpenImage?: (image: AppServerThreadImagePart) => void;
  onToggleExpanded: () => void;
};

function isHttpUrl(url: string | undefined): url is string {
  return Boolean(url && /^https?:\/\//i.test(url));
}

export function buildBrowserUseCopyText(
  entry: AppServerThreadActivityEntry,
  browserUse: AppServerThreadBrowserUsePresentation,
): string {
  const lines: string[] = [entry.summary];
  const metaParts = [
    browserUse.surfaceLabel,
    browserUse.handoffReason ? formatBrowserHandoffLabel(browserUse.handoffReason) : undefined,
    browserUse.url,
  ].filter((value): value is string => Boolean(value));
  if (metaParts.length > 0) {
    lines.push(metaParts.join(" · "));
  }
  for (const detail of entry.details) {
    if (detail.label.trim()) {
      lines.push(detail.label);
    }
  }
  return lines.join("\n");
}

export function TranscriptBrowserUseActivity(props: TranscriptBrowserUseActivityProps) {
  const fallbackDetailsId = useId();
  const detailsId = props.detailsId ?? fallbackDetailsId;
  const { browserUse, entry } = props;
  const handoffLabel = browserUse.handoffReason
    ? formatBrowserHandoffLabel(browserUse.handoffReason)
    : undefined;
  const url = isHttpUrl(browserUse.url) ? browserUse.url : undefined;
  const webMcpTools = browserUse.webMcpTools;
  const hasMeta = !browserUse.standalone && Boolean(
    browserUse.surfaceLabel
    || handoffLabel
    || url
    || browserUse.stepCount > 1
    || webMcpTools?.length,
  );
  const existingImageUrls = new Set(
    entry.details.flatMap((detail) => (detail.images ?? []).map((image) => image.url)),
  );
  const previewImage: AppServerThreadImagePart | undefined =
    browserUse.screenshotUrl && !existingImageUrls.has(browserUse.screenshotUrl)
      ? {
          type: "image",
          url: browserUse.screenshotUrl,
          alt: `${browserUse.title} screenshot`,
        }
      : undefined;
  const className = [
    "transcript-activity",
    "transcript-browser-use",
    entry.tone === "warning" ? "transcript-activity--warning" : "",
  ].filter(Boolean).join(" ");

  return (
    <aside
      className={className}
      data-browser-standalone={browserUse.standalone ? "true" : undefined}
      data-expanded={props.hasDetails && props.isExpanded ? "true" : undefined}
    >
      <header className="transcript-activity__header">
        {props.hasDetails ? (
          <button
            type="button"
            className="transcript-activity__toggle"
            aria-controls={detailsId}
            aria-expanded={props.isExpanded}
            onClick={props.onToggleExpanded}
          >
            <span className="transcript-activity__chevron" aria-hidden="true" />
            <GlobeIcon size={14} className="transcript-browser-use__icon" aria-hidden="true" />
            <span className="transcript-activity__label">{props.displaySummary}</span>
          </button>
        ) : (
          <span className="transcript-browser-use__headline">
            <GlobeIcon size={14} className="transcript-browser-use__icon" aria-hidden="true" />
            <span className="transcript-activity__label">{props.displaySummary}</span>
          </span>
        )}
        <span className="transcript-activity__header-actions">
          <TranscriptCopyButton
            className="transcript-copy-button--activity"
            copiedLabel="Copied activity"
            desktopApi={props.desktopApi}
            label="Copy activity"
            text={props.copyText}
          />
          {entry.createdAt ? (
            <time
              className="transcript-activity__time tooltip-target"
              dateTime={new Date(entry.createdAt).toISOString()}
              data-tooltip={new Date(entry.createdAt).toISOString()}
            >
              {new Intl.DateTimeFormat(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              }).format(entry.createdAt)}
            </time>
          ) : null}
        </span>
      </header>

      {hasMeta ? (
        <div
          className={
            props.hasDetails
              ? "transcript-browser-use__meta transcript-browser-use__meta--indented"
              : "transcript-browser-use__meta"
          }
        >
          {browserUse.surfaceLabel ? (
            <span className="transcript-browser-use__chip">{browserUse.surfaceLabel}</span>
          ) : null}
          {handoffLabel ? (
            <span className="transcript-browser-use__chip transcript-browser-use__chip--handoff">
              {handoffLabel}
            </span>
          ) : null}
          {url ? (
            <a
              className="transcript-browser-use__url"
              href={url}
              target="_blank"
              rel="noreferrer"
              title={url}
            >
              {formatBrowserUrlDisplay(url)}
            </a>
          ) : null}
          {browserUse.stepCount > 1 ? (
            <span className="transcript-browser-use__steps">
              {browserUse.stepCount} steps
            </span>
          ) : null}
          {webMcpTools && webMcpTools.length > 0 ? (
            <span
              className="transcript-browser-use__webmcp"
              title={webMcpTools.map((tool) => tool.name).join(", ")}
            >
              WebMCP: {webMcpTools.map((tool) => tool.title ?? tool.name).slice(0, 2).join(", ")}
              {webMcpTools.length > 2 ? ` +${webMcpTools.length - 2}` : ""}
            </span>
          ) : null}
        </div>
      ) : null}

      {previewImage ? (
        <div
          className={
            props.hasDetails
              ? "transcript-browser-use__preview transcript-browser-use__preview--indented"
              : "transcript-browser-use__preview"
          }
        >
          <button
            type="button"
            className="transcript-browser-use__preview-button"
            aria-label={`Expand browser preview for ${browserUse.title}`}
            onClick={() => {
              props.onOpenImage?.(previewImage);
            }}
          >
            <TranscriptImage
              className="transcript-browser-use__preview-image"
              src={previewImage.url}
              alt={previewImage.alt ?? "Browser preview"}
              loading="lazy"
            />
          </button>
        </div>
      ) : null}

      {props.imagesContent}
      {props.detailsContent}
    </aside>
  );
}
