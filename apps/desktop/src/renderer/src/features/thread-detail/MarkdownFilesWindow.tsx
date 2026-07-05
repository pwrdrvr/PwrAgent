import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type {
  DesktopApplicationsSnapshot,
  MarkdownFileViewerFile,
  MarkdownFileViewerSnapshot,
} from "@pwragent/shared";
import { AppIcon } from "../../components/AppIcon";
import { CloseIcon } from "../../icons";
import { useDesktopApi } from "../../lib/desktop-api";
import { ThreadMarkdown } from "./ThreadMarkdown";

type LoadState =
  | { status: "idle" | "loading" }
  | { status: "loaded"; content: string }
  | { status: "error"; error: string };

export function MarkdownFilesWindow() {
  const desktopApi = useDesktopApi();
  const contextKey = useMemo(() => markdownFilesContextKeyFromHash(), []);
  const [snapshot, setSnapshot] = useState<
    MarkdownFileViewerSnapshot | undefined
  >();
  const selectedFile =
    snapshot?.files.find((file) => file.path === snapshot.selectedPath)
    ?? snapshot?.files[0];
  const markdownApplications = useMemo(
    () => applicationsSnapshotForEditor(snapshot),
    [snapshot],
  );
  const breadcrumbParts = useMemo(
    () => markdownFilesBreadcrumbParts(snapshot?.context),
    [snapshot?.context],
  );
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });

  useEffect(() => {
    if (!snapshot?.context.title) {
      return;
    }
    document.title = snapshot.context.title;
  }, [snapshot?.context.title]);

  useEffect(() => {
    if (!contextKey || !desktopApi?.readMarkdownFileViewerSnapshot) {
      return;
    }

    let cancelled = false;
    void desktopApi
      .readMarkdownFileViewerSnapshot({ contextKey })
      .then((response) => {
        if (!cancelled) {
          setSnapshot(response.snapshot);
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to read markdown files snapshot", error);
      });

    return () => {
      cancelled = true;
    };
  }, [contextKey, desktopApi]);

  useEffect(() => {
    if (!desktopApi?.onMarkdownFileViewerSnapshotChanged) {
      return undefined;
    }

    return desktopApi.onMarkdownFileViewerSnapshotChanged((response) => {
      if (!contextKey || response.snapshot?.context.key !== contextKey) {
        return;
      }
      setSnapshot(response.snapshot);
    });
  }, [contextKey, desktopApi]);

  useEffect(() => {
    const reader = desktopApi?.readMarkdownFile;
    if (!reader || !selectedFile) {
      return;
    }

    let cancelled = false;
    setLoadState({ status: "loading" });
    void reader({ path: selectedFile.path })
      .then((response) => {
        if (cancelled) return;
        if (response.error || response.content === undefined) {
          setLoadState({
            status: "error",
            error: response.error ?? "Markdown file could not be read.",
          });
          return;
        }
        setLoadState({ status: "loaded", content: response.content });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadState({
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Markdown file could not be read.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [desktopApi, selectedFile?.path]);

  const selectFile = useCallback(
    (file: MarkdownFileViewerFile) => {
      if (!snapshot) {
        return;
      }
      setSnapshot({
        ...snapshot,
        selectedPath: file.path,
      });
    },
    [snapshot],
  );

  const openSelectedFileInEditor = useCallback(() => {
    if (
      !desktopApi?.openApplication
      || !snapshot?.editorApplication
      || !selectedFile
    ) {
      return;
    }
    void desktopApi
      .openApplication({
        applicationId: snapshot.editorApplication.id,
        kind: "editor",
        targetPath: selectedFile.path,
        targetLine: selectedFile.line,
        targetColumn: selectedFile.column,
      })
      .catch((error: unknown) => {
        console.error("Failed to open markdown file in editor", error);
      });
  }, [desktopApi, selectedFile, snapshot?.editorApplication]);

  return (
    <div className="document-window markdown-files-window">
      <section aria-label="Files" className="activity-screen">
        <header className="activity-titlebar">
          <p className="activity-titlebar__brand">
            Pwr<span className="activity-titlebar__brand-accent">Agent</span>
          </p>
          <div
            className="activity-titlebar__breadcrumb"
            aria-label={breadcrumbParts.join(" > ")}
          >
            {breadcrumbParts.map((part, index) => (
              <Fragment key={`${part}:${index}`}>
                {index > 0 ? (
                  <span
                    aria-hidden="true"
                    className="activity-titlebar__separator"
                  >
                    ›
                  </span>
                ) : null}
                <span
                  className={
                    index === breadcrumbParts.length - 1
                      ? "activity-titlebar__current"
                      : "activity-titlebar__crumb"
                  }
                >
                  {part}
                </span>
              </Fragment>
            ))}
          </div>
          <div className="activity-titlebar__spacer" />
        </header>

        <main className="markdown-files-window__shell">
          <aside
            className="markdown-files-window__sidebar"
            aria-label="Open files"
          >
            <p className="markdown-files-window__sidebar-label">Files</p>
            <div className="markdown-files-window__file-list">
              {(snapshot?.files ?? []).map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className={[
                    "markdown-files-window__file-button",
                    file.path === selectedFile?.path
                      ? "markdown-files-window__file-button--active"
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  title={file.path}
                  onClick={() => selectFile(file)}
                >
                  <span>{file.label}</span>
                  <span>
                    {relativeFilePath(file.path, snapshot?.context.projectPath)}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <article className="markdown-files-window__content">
            <header className="markdown-files-window__file-header">
              <div className="markdown-files-window__file-title-wrap">
                <h1 className="markdown-files-window__file-title">
                  {selectedFile?.label ?? "No file selected"}
                </h1>
                {selectedFile ? (
                  <p className="markdown-files-window__file-path">
                    {selectedFile.path}
                  </p>
                ) : null}
                {snapshot?.context.projectPath ? (
                  <p className="markdown-files-window__project">
                    Project: {snapshot.context.projectPath}
                  </p>
                ) : null}
              </div>
              <div className="markdown-files-window__file-actions">
                {snapshot?.editorApplication && selectedFile ? (
                  <button
                    type="button"
                    className="markdown-files-window__icon-button"
                    aria-label={`Open file in ${snapshot.editorApplication.name}: ${selectedFile.label}`}
                    title={`Open file in ${snapshot.editorApplication.name}`}
                    onClick={openSelectedFileInEditor}
                  >
                    <AppIcon
                      application={snapshot.editorApplication}
                      className="markdown-files-window__app-icon"
                      size={16}
                    />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="markdown-files-window__icon-button"
                  aria-label="Close window"
                  title="Close"
                  onClick={() => window.close()}
                >
                  <CloseIcon size={18} aria-hidden="true" />
                </button>
              </div>
            </header>

            <div className="markdown-files-window__markdown-scroll">
              {loadState.status === "loading" ? (
                <p className="markdown-files-window__status">
                  Loading document...
                </p>
              ) : null}
              {loadState.status === "error" ? (
                <p className="markdown-files-window__status markdown-files-window__status--error">
                  {loadState.error}
                </p>
              ) : null}
              {loadState.status === "loaded" ? (
                <ThreadMarkdown
                  applications={markdownApplications}
                  className="markdown-files-window__markdown"
                  desktopApi={desktopApi}
                  fileViewerContext={snapshot?.context}
                  text={loadState.content}
                  variant="summary"
                />
              ) : null}
            </div>
          </article>
        </main>
      </section>
    </div>
  );
}

function markdownFilesContextKeyFromHash(): string | undefined {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash.startsWith("files/")) {
    return undefined;
  }

  return decodeURIComponent(hash.slice("files/".length));
}

function relativeFilePath(
  filePath: string,
  projectPath: string | undefined,
): string {
  if (!projectPath) {
    return filePath;
  }

  return filePath === projectPath || filePath.startsWith(`${projectPath}/`)
    ? filePath.slice(projectPath.length).replace(/^\//, "") || filePath
    : filePath;
}

function markdownFilesBreadcrumbParts(
  context: MarkdownFileViewerSnapshot["context"] | undefined,
): string[] {
  const projectLabel = projectLabelFromPath(context?.projectPath);
  const threadTitle = context?.threadTitle?.trim();

  const parts = [projectLabel, threadTitle, "Files"].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts : ["Files"];
}

function projectLabelFromPath(
  projectPath: string | undefined,
): string | undefined {
  const label = projectPath?.split(/[\\/]/).filter(Boolean).at(-1)?.trim();
  return label || undefined;
}

function applicationsSnapshotForEditor(
  snapshot: MarkdownFileViewerSnapshot | undefined,
): DesktopApplicationsSnapshot | undefined {
  if (!snapshot?.editorApplication) {
    return undefined;
  }

  return {
    editors: [snapshot.editorApplication],
    terminals: [],
    preferredEditorId: {
      value: snapshot.editorApplication.id,
      source: "config",
    },
    preferredTerminalId: {
      value: "",
      source: "default",
    },
    gh: {
      path: { value: "", source: "default" },
      discovery: { candidates: [] },
    },
    git: {
      discovery: { candidates: [] },
    },
  };
}
