import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isFilePreviewPath,
  isRemoteFederationTarget,
  type FederationTarget,
} from "@pwragent/shared";
import { HTML_PREVIEW_FRAME_NAME } from "../../../../shared/html-preview";
import type { DesktopApi } from "../../lib/desktop-api";
import { openExternalUrl } from "../../lib/open-external-url";
import {
  buildHtmlPreviewDocument,
  fileUrlForPath,
  htmlPreviewLocalLinkPath,
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
 * network. Scripts start off unless the operator's setting says otherwise,
 * and the toolbar turns them on or off for this page. A link the page tries
 * to follow is offered here, with its URL, instead of opening on its own.
 */
export function HtmlFilePreview(props: {
  content: string;
  desktopApi?: Pick<DesktopApi, "readHtmlPreviewAssets" | "onHtmlPreviewNavigation">;
  federationTarget?: FederationTarget;
  label: string;
  path: string;
  runScriptsByDefault: boolean;
  /** Opens another previewable file the page links to. */
  onOpenLocalFile?: (path: string) => void;
}) {
  const [scripts, setScripts] = useState(props.runScriptsByDefault);
  const [resourceState, setResourceState] = useState<ResourceState>({ status: "loading" });
  const [pendingLink, setPendingLink] = useState<PendingLink>();
  const remote = Boolean(
    props.federationTarget && isRemoteFederationTarget(props.federationTarget),
  );
  const readHtmlPreviewAssets = props.desktopApi?.readHtmlPreviewAssets;
  const onHtmlPreviewNavigation = props.desktopApi?.onHtmlPreviewNavigation;
  const onOpenLocalFile = props.onOpenLocalFile;

  useEffect(() => {
    setScripts(props.runScriptsByDefault);
  }, [props.runScriptsByDefault]);

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
  const document = useMemo(() => resourceState.status === "ready"
    ? buildHtmlPreviewDocument(props.content, resourceState.resources, { scripts, fileUrl })
    : undefined, [fileUrl, props.content, resourceState, scripts]);

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
    document && document.blockedRemote > 0
      ? `Blocked ${countLabel(document.blockedRemote, "web resource")}`
      : undefined,
    unavailable,
    !unavailable && document && document.missingLocal > 0
      ? `${countLabel(document.missingLocal, "local file")} not loaded`
      : undefined,
  ].filter((notice): notice is string => Boolean(notice));

  return (
    <div className="html-preview">
      <div className="html-preview__bar">
        <p className="html-preview__status">
          <span>{scripts ? "Scripts on" : "Scripts off"}</span>
          <span>No network access</span>
          {notices.map((notice) => (
            <span key={notice} className="html-preview__notice">{notice}</span>
          ))}
        </p>
        <button
          type="button"
          className="button button--secondary html-preview__button"
          aria-pressed={scripts}
          onClick={() => {
            setPendingLink(undefined);
            setScripts((current) => !current);
          }}
        >
          {scripts ? "Stop Scripts" : "Run Scripts"}
        </button>
      </div>
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
      {document ? (
        <iframe
          // A new frame per mode: the sandbox attribute only applies to the
          // next document a frame loads.
          key={scripts ? "scripts" : "static"}
          className="html-preview__frame"
          name={HTML_PREVIEW_FRAME_NAME}
          title={`HTML preview: ${props.label}`}
          sandbox={scripts ? "allow-scripts" : ""}
          referrerPolicy="no-referrer"
          srcDoc={document.srcdoc}
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
      ? `Open ${baseName(link.path)} here?`
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
    // The app opens plain http only on this machine (external-url-policy.ts).
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

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "127.0.0.1"
    || host === "::1";
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
