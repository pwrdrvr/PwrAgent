import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  isFilePreviewPath,
  isRemoteFederationTarget,
  type FederationTarget,
} from "@pwragent/shared";
import { HTML_PREVIEW_FRAME_NAME } from "../../../../shared/html-preview";
import { splitFilePath } from "./FileViewerHeader";
import { BanIcon, FileCodeIcon, ShieldIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { useHtmlPreviewRunScripts } from "../../lib/html-preview-preferences";
import { isLoopbackHost } from "../../lib/loopback-host";
import { openExternalUrl } from "../../lib/open-external-url";
import {
  fileUrlForPath,
  htmlPreviewLocalLinkPath,
  prepareHtmlPreviewDocument,
  resolveHtmlPreviewResources,
  type HtmlPreviewAssetReader,
  type HtmlPreviewResources,
} from "./html-preview-document";

type PendingLink =
  | { kind: "web"; url: string }
  | { kind: "file"; path: string }
  | { kind: "unsupported"; target: string };

type ResourceState =
  | { status: "loading" }
  | { status: "ready"; resources: HtmlPreviewResources };

/**
 * An HTML file, shown in an opaque-origin frame that cannot reach the
 * network. Scripts start off unless the operator's setting says otherwise
 * (`useHtmlPreviewRunScripts`), and the Scripts switch turns them on or off
 * for this page. A link the page tries to follow is offered here, with its
 * URL, instead of opening on its own.
 */
export function HtmlFilePreview(props: {
  content: string;
  /**
   * The viewer's header slot for the page's permissions. Null while the slot
   * mounts; leave it out to draw them in a bar above the page.
   */
  controlsContainer?: HTMLElement | null;
  desktopApi?: Pick<
    DesktopApi,
    "readConfigBootstrap" | "readHtmlPreviewAssets" | "onHtmlPreviewNavigation"
  >;
  federationTarget?: FederationTarget;
  label: string;
  path: string;
  /** Opens another previewable file the page links to. */
  onOpenLocalFile?: (path: string) => void;
}) {
  const runScriptsByDefault = useHtmlPreviewRunScripts(props.desktopApi);
  // The operator's choice for this page, once made, outlasts the default
  // arriving or changing.
  const [chosenScripts, setChosenScripts] = useState<boolean>();
  const scripts = chosenScripts ?? runScriptsByDefault;
  const [resourceState, setResourceState] = useState<ResourceState>({ status: "loading" });
  const [pendingLink, setPendingLink] = useState<PendingLink>();
  const remote = Boolean(
    props.federationTarget && isRemoteFederationTarget(props.federationTarget),
  );
  const readHtmlPreviewAssets = props.desktopApi?.readHtmlPreviewAssets;
  const onHtmlPreviewNavigation = props.desktopApi?.onHtmlPreviewNavigation;
  const onOpenLocalFile = props.onOpenLocalFile;

  const readAssets = useCallback<HtmlPreviewAssetReader>(async (refs) => {
    if (!readHtmlPreviewAssets) {
      return { assets: [], skipped: [], error: "Files beside this page are not loaded here." };
    }
    return await readHtmlPreviewAssets({ path: props.path, refs });
  }, [props.path, readHtmlPreviewAssets]);

  useEffect(() => {
    let cancelled = false;
    setResourceState({ status: "loading" });
    void resolveHtmlPreviewResources(
      props.content,
      remote || !readHtmlPreviewAssets ? undefined : readAssets,
      remote
        ? "Files beside a page on another machine are not loaded."
        : "Files beside this page are not loaded here.",
    )
      .catch((error: unknown): HtmlPreviewResources => ({
        assets: new Map(),
        stylesheets: new Map(),
        unavailable: error instanceof Error ? error.message : "Files beside this page could not be read.",
      }))
      .then((resources) => {
        if (!cancelled) setResourceState({ status: "ready", resources });
      });
    return () => {
      cancelled = true;
    };
  }, [props.content, readAssets, readHtmlPreviewAssets, remote]);

  const fileUrl = remote ? undefined : fileUrlForPath(props.path);
  // The page is parsed and rewritten once; the scripts toggle only swaps the
  // policy in front of it.
  const prepared = useMemo(() => resourceState.status === "ready"
    ? prepareHtmlPreviewDocument(props.content, resourceState.resources, { fileUrl })
    : undefined, [fileUrl, props.content, resourceState]);
  const srcdoc = useMemo(() => prepared?.srcdoc(scripts), [prepared, scripts]);

  useEffect(() => {
    if (!onHtmlPreviewNavigation) return undefined;
    return onHtmlPreviewNavigation(({ url }) => {
      setPendingLink(classifyLink(url, Boolean(onOpenLocalFile)));
    });
  }, [onHtmlPreviewNavigation, onOpenLocalFile]);

  const unavailable = resourceState.status === "ready"
    ? resourceState.resources.unavailable
    : undefined;
  const notices = [
    prepared && prepared.blockedRemote > 0
      ? `Blocked ${countLabel(prepared.blockedRemote, "web resource")}`
      : undefined,
    unavailable,
    !unavailable && prepared && prepared.missingLocal > 0
      ? `${countLabel(prepared.missingLocal, "local file")} not loaded`
      : undefined,
  ].filter((notice): notice is string => Boolean(notice));

  // Every local file counts as not loaded when none could be read, as on a
  // peer's page, so the label shows why an image is blank either way.
  const blocked = prepared?.blockedRemote ?? 0;
  const missing = prepared?.missingLocal ?? 0;
  const statusLabel = [
    blocked > 0 ? `${blocked} blocked` : undefined,
    missing > 0 ? `${missing} not loaded` : undefined,
  ].filter(Boolean).join(" · ") || "Offline";
  const statusNotices = ["No network access", ...notices];
  const controls = (
    <div className="html-preview-controls" role="group" aria-label="Page permissions">
      <span
        className="html-preview-controls__status tooltip-target"
        data-tooltip={statusNotices.join(" · ")}
      >
        {blocked > 0 || missing > 0
          ? <BanIcon size={12} aria-hidden="true" />
          : <ShieldIcon size={12} aria-hidden="true" />}
        <span aria-hidden="true">{statusLabel}</span>
        {/* The short label is for sight; a screen reader hears each notice. */}
        {statusNotices.map((notice) => (
          <span key={notice} className="html-preview-controls__notice">{notice}</span>
        ))}
      </span>
      <span className="html-preview-controls__divider" aria-hidden="true" />
      <button
        type="button"
        role="switch"
        className="html-preview-controls__scripts tooltip-target"
        aria-checked={scripts}
        data-tooltip={scripts
          ? "Stop this page's scripts"
          : "Run this page's scripts. The page still has no network access."}
        onClick={() => {
          setPendingLink(undefined);
          setChosenScripts(!scripts);
        }}
      >
        <FileCodeIcon size={12} aria-hidden="true" />
        Scripts
        <span aria-hidden="true">{scripts ? " on" : " off"}</span>
      </button>
    </div>
  );

  return (
    <div className="html-preview">
      {props.controlsContainer === undefined ? (
        <div className="html-preview__bar">{controls}</div>
      ) : props.controlsContainer ? createPortal(controls, props.controlsContainer) : null}
      {pendingLink ? (
        <PendingLinkBar
          link={pendingLink}
          onDismiss={() => setPendingLink(undefined)}
          onOpen={() => {
            setPendingLink(undefined);
            if (pendingLink.kind === "web") openExternalUrl(pendingLink.url);
            if (pendingLink.kind === "file") onOpenLocalFile?.(pendingLink.path);
          }}
        />
      ) : null}
      {srcdoc !== undefined ? (
        <iframe
          // A new frame per mode: the sandbox attribute only applies to the
          // next document a frame loads.
          key={scripts ? "scripts" : "static"}
          className="html-preview__frame"
          name={HTML_PREVIEW_FRAME_NAME}
          title={`HTML preview: ${props.label}`}
          sandbox={scripts ? "allow-scripts" : ""}
          referrerPolicy="no-referrer"
          srcDoc={srcdoc}
        />
      ) : (
        <p className="html-preview__loading">Loading page…</p>
      )}
    </div>
  );
}

function PendingLinkBar(props: {
  link: PendingLink;
  onDismiss: () => void;
  onOpen: () => void;
}) {
  const { link } = props;
  const question = link.kind === "web"
    ? "Open this link in your browser?"
    : link.kind === "file"
      ? `Open ${splitFilePath(link.path).name} here?`
      : "This link cannot be opened from a preview.";
  const target = link.kind === "web" ? link.url : link.kind === "file" ? link.path : link.target;
  return (
    <div className="html-preview__link" role="group" aria-label="Link from the page">
      <div className="html-preview__link-text">
        <p className="html-preview__link-question">{question}</p>
        <p className="html-preview__link-target" title={target}>{target}</p>
      </div>
      <div className="html-preview__link-actions">
        <button
          type="button"
          className="button button--secondary html-preview__button"
          autoFocus
          onClick={props.onDismiss}
        >
          {link.kind === "unsupported" ? "Dismiss" : "Cancel"}
        </button>
        {link.kind === "unsupported" ? null : (
          <button
            type="button"
            className="button button--primary html-preview__button"
            onClick={props.onOpen}
          >
            Open
          </button>
        )}
      </div>
    </div>
  );
}

function classifyLink(url: string, canOpenFiles: boolean): PendingLink {
  const localPath = htmlPreviewLocalLinkPath(url);
  if (localPath !== undefined) {
    return canOpenFiles && isFilePreviewPath(localPath)
      ? { kind: "file", path: localPath }
      : { kind: "unsupported", target: localPath };
  }
  try {
    const parsed = new URL(url);
    // The app opens plain http only on this machine (main's external-url-policy.ts).
    if (
      parsed.protocol === "https:"
      || parsed.protocol === "mailto:"
      || (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
    ) {
      return { kind: "web", url: parsed.href };
    }
  } catch {
    // Not a URL at all: show it as written.
  }
  return { kind: "unsupported", target: url };
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
