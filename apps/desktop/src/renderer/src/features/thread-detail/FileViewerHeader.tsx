import { useEffect, useState, type ReactNode, type Ref } from "react";
import { filePreviewKindLabel, type FilePreviewKind } from "@pwragent/shared";
import { CheckIcon, CopyIcon } from "../../icons";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import { tildifyPath } from "../../lib/tildify-path";

const COPIED_MS = 1200;

/**
 * One row naming a previewed file: its kind, its name, and its folder, which
 * copies the full path. The name comes from the path, never from the link
 * text that opened the file: agents usually write the path as the link text,
 * and the row would then say it twice.
 */
export function FileViewerHeader(props: {
  actions: ReactNode;
  /** Where the preview puts its own controls, such as an HTML page's permissions. */
  controlsRef?: Ref<HTMLDivElement>;
  desktopApi?: Pick<DesktopApi, "copyText">;
  /** h2 inside a dialog, h1 when the file fills its own window. */
  headingLevel: 1 | 2;
  kind?: FilePreviewKind;
  path?: string;
  /** Shown in place of the name when no file is selected. */
  placeholder?: string;
}) {
  const Heading = props.headingLevel === 1 ? "h1" : "h2";
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const path = props.path;
  const { folder, name } = path ? splitFilePath(path) : { folder: "", name: "" };
  const kindBadge = path ? fileKindBadge(name, props.kind) : undefined;

  return (
    <header className="file-viewer-header">
      {kindBadge ? (
        <span className="file-viewer-header__kind" aria-hidden="true">{kindBadge}</span>
      ) : null}
      <Heading className="file-viewer-header__name" title={name || undefined}>
        {name || props.placeholder}
      </Heading>
      {path ? (
        <button
          type="button"
          className="file-viewer-header__folder tooltip-target"
          aria-label="Copy path"
          data-copied={copied ? "true" : undefined}
          data-tooltip={copied ? "Copied path" : tildifyPath(path)}
          onClick={() => {
            void copyText(path, props.desktopApi).then(() => setCopied(true), () => undefined);
          }}
        >
          {folder ? (
            <span className="file-viewer-header__folder-text">{tildifyPath(folder)}</span>
          ) : null}
          {copied
            ? <CheckIcon size={12} aria-hidden="true" />
            : <CopyIcon size={12} aria-hidden="true" />}
        </button>
      ) : null}
      <div ref={props.controlsRef} className="file-viewer-header__controls" />
      <div className="file-viewer-header__actions">{props.actions}</div>
    </header>
  );
}

/** Splits at the last separator, so a Windows path splits as well as a POSIX one. */
export function splitFilePath(filePath: string): { folder: string; name: string } {
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (at < 0) return { folder: "", name: trimmed };
  // Keep the root itself ("/" or "C:\") as the folder of a file at the top.
  const folder = at === 0 || /^[a-z]:$/i.test(trimmed.slice(0, at))
    ? trimmed.slice(0, at + 1)
    : trimmed.slice(0, at);
  return { folder, name: trimmed.slice(at + 1) };
}

/** "HTML", "MD", "JSON": the extension, which is how a file names its kind. */
function fileKindBadge(name: string, kind: FilePreviewKind | undefined): string | undefined {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1];
  if (extension) return extension.toUpperCase();
  return kind ? filePreviewKindLabel(kind).toUpperCase() : undefined;
}
