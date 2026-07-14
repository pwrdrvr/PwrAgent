import {
  isThreadUrl,
  PWRAGENT_URL_SCHEME,
  type AppServerSkillSummary,
  type DesktopApplicationsSnapshot,
  type MarkdownFileViewerContext,
} from "@pwragent/shared";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { AppIcon } from "../../components/AppIcon";
import { CloseIcon, PopoutIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { repairNestedLanguageFences } from "../../lib/markdown-fences";
import {
  resolveThreadHref,
  resolveThreadIdText,
  useThreadLinks,
  type ThreadLinkContextValue,
} from "../../lib/thread-links";
import { SkillChip } from "../composer/SkillChip";
import { ThreadChip } from "./ThreadChip";
import { remarkTableProfile } from "./remark-table-profile";
import { TranscriptCopyButton } from "./TranscriptCopyButton";

type ThreadMarkdownProps = {
  applications?: DesktopApplicationsSnapshot;
  className?: string;
  desktopApi?: Pick<
    DesktopApi,
    "copyText" | "openApplication" | "openMarkdownFileViewer" | "readMarkdownFile"
  >;
  fileViewerContext?: MarkdownFileViewerContext;
  skills?: AppServerSkillSummary[];
  text: string;
  variant?: "message" | "summary";
};

type EditorApplication = DesktopApplicationsSnapshot["editors"][number];

/**
 * True while rendering inside a `<pre>`. react-markdown v10 dropped the
 * `inline` prop on `code`, and a fence with no language carries no
 * `language-` class, so the class name alone cannot distinguish block code
 * from an inline span.
 */
const CodeBlockContext = createContext(false);

function TranscriptCode(props: {
  children: ReactNode;
  className?: string;
  threadLinks: ThreadLinkContextValue | undefined;
}) {
  const insideCodeBlock = useContext(CodeBlockContext);
  const isBlockCode = insideCodeBlock || (props.className?.includes("language-") ?? false);

  if (!isBlockCode) {
    // Transcripts written before the link protocol existed — and any model
    // that ignores the `threadLink` convention — put the bare thread id in a
    // code span. Recognizing it makes those threads reachable without asking
    // anyone to re-run anything. Gated on the id resolving to a real thread,
    // so an unrelated uuid stays plain code.
    const threadLink = resolveThreadIdText(
      extractTextContent(props.children),
      props.threadLinks
    );
    if (threadLink && props.threadLinks) {
      return <ThreadChip link={threadLink} onOpen={props.threadLinks.show} />;
    }
  }

  return (
    <code className={isBlockCode ? props.className : "transcript-message__code"}>
      {props.children}
    </code>
  );
}

type LocalFileTarget = {
  path: string;
  line?: number;
  column?: number;
};

type MarkdownViewerTarget = LocalFileTarget & {
  label: string;
};

export const ThreadMarkdown = memo(function ThreadMarkdown(props: ThreadMarkdownProps) {
  const markdownText = useMemo(
    () => protectComposerHyphenListItems(repairNestedLanguageFences(props.text)),
    [props.text]
  );
  const [markdownViewerTarget, setMarkdownViewerTarget] =
    useState<MarkdownViewerTarget>();
  const threadLinks = useThreadLinks();
  const editorApplication = useMemo(
    () =>
      props.applications?.editors.find(
        (application) =>
          application.canOpenWorkspace &&
          application.id === props.applications?.preferredEditorId.value
      ) ?? props.applications?.editors.find((application) => application.canOpenWorkspace),
    [props.applications]
  );
  const skillsByPath = useMemo(
    () =>
      new Map(
        (props.skills ?? [])
          .filter(
            (skill): skill is AppServerSkillSummary & { path: string } => Boolean(skill.path)
          )
          .map((skill) => [skill.path, skill])
      ),
    [props.skills]
  );

  const openLocalFileInEditor = useCallback(
    (target: LocalFileTarget): boolean => {
      if (!editorApplication || !props.desktopApi?.openApplication) {
        return false;
      }

      void props.desktopApi
        .openApplication({
          applicationId: editorApplication.id,
          kind: "editor",
          targetPath: target.path,
          targetLine: target.line,
          targetColumn: target.column,
        })
        .catch((error: unknown) => {
          console.error("Failed to open transcript file link", error);
        });
      return true;
    },
    [editorApplication, props.desktopApi]
  );

  const openLocalFileLink = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, href: string, label: string): void => {
      const target = localFileTargetFromHref(href);
      if (!target) {
        return;
      }

      if (isMarkdownFilePath(target.path) && props.desktopApi?.readMarkdownFile) {
        event.preventDefault();
        setMarkdownViewerTarget({
          ...target,
          label: label || fileNameFromPath(target.path),
        });
        return;
      }

      if (openLocalFileInEditor(target)) {
        event.preventDefault();
      }
    },
    [openLocalFileInEditor, props.desktopApi]
  );

  const components = useMemo<Components>(
    () => ({
      a(anchorProps) {
        const href = typeof anchorProps.href === "string" ? anchorProps.href : "";
        const localTarget = localFileTargetFromHref(href);
        const isLocalMarkdownFile = Boolean(
          localTarget && isMarkdownFilePath(localTarget.path)
        );
        const skillPath = normalizeSkillPath(href);
        const label = extractTextContent(anchorProps.children).trim();
        const source = sourceForNode(markdownText, anchorProps.node);

        if (isImplicitBareAutolink({ href, label, source })) {
          return <>{anchorProps.children}</>;
        }

        if (isThreadUrl(href)) {
          const threadLink = resolveThreadHref(href, threadLinks);
          if (threadLink && threadLinks) {
            return (
              <ThreadChip
                fallbackLabel={label}
                link={threadLink}
                onOpen={threadLinks.show}
              />
            );
          }

          // The link names a thread this profile does not have, or renders on a
          // surface with no navigation (Activity, Changelog, file viewer). Show
          // the author's text rather than an anchor that goes nowhere — and
          // never let `pwragent:` reach the external-open path below.
          return <>{anchorProps.children}</>;
        }

        if (
          skillPath &&
          (skillsByPath.has(skillPath) || label.startsWith("$"))
        ) {
          const skill = skillsByPath.get(skillPath) ?? {
            name: label.replace(/^\$/, "") || skillPath.split("/").pop() || "skill",
            path: skillPath,
          };

          return <SkillChip label={label || undefined} skill={skill} />;
        }

        if (!href) {
          return <>{anchorProps.children}</>;
        }

        const link = (
          <a
            className="transcript-message__link"
            href={href || undefined}
            onClick={(event) => {
              openLocalFileLink(event, href, label);
            }}
            rel="noopener noreferrer"
            target="_blank"
            title={isLocalMarkdownFile ? "Open in PwrAgent" : href || undefined}
          >
            {anchorProps.children}
          </a>
        );

        if (isLocalMarkdownFile && localTarget) {
          return (
            <span className="thread-markdown__file-link">
              {link}
              {editorApplication && props.desktopApi?.openApplication ? (
                <button
                  type="button"
                  className="thread-markdown__editor-link"
                  aria-label={openFileInEditorLabel(
                    label || fileNameFromPath(localTarget.path),
                    editorApplication.name,
                  )}
                  title={openFileInEditorTitle(editorApplication.name)}
                  onClick={(event) => {
                    event.stopPropagation();
                    openLocalFileInEditor(localTarget);
                  }}
                >
                  <AppIcon
                    application={editorApplication}
                    className="thread-markdown__editor-link-icon"
                    size={13}
                  />
                </button>
              ) : null}
            </span>
          );
        }

        return link;
      },
      blockquote(blockquoteProps) {
        const copyText = normalizeBlockquoteCopyText(
          sourceForNode(markdownText, blockquoteProps.node) ??
            extractTextContent(blockquoteProps.children)
        );

        return (
          <blockquote
            className="transcript-message__blockquote"
            aria-label="Quoted text"
            tabIndex={0}
          >
            {copyText ? (
              <TranscriptCopyButton
                className="transcript-copy-button--section"
                copiedLabel="Copied quote"
                desktopApi={props.desktopApi}
                label="Copy quote"
                text={copyText}
              />
            ) : null}
            {blockquoteProps.children}
          </blockquote>
        );
      },
      code(codeProps) {
        return (
          <TranscriptCode className={codeProps.className} threadLinks={threadLinks}>
            {codeProps.children}
          </TranscriptCode>
        );
      },
      h1(headingProps) {
        return <h1 className="transcript-message__heading">{headingProps.children}</h1>;
      },
      h2(headingProps) {
        return <h2 className="transcript-message__heading">{headingProps.children}</h2>;
      },
      h3(headingProps) {
        return <h3 className="transcript-message__heading">{headingProps.children}</h3>;
      },
      h4(headingProps) {
        return <h4 className="transcript-message__heading">{headingProps.children}</h4>;
      },
      h5(headingProps) {
        return <h5 className="transcript-message__heading">{headingProps.children}</h5>;
      },
      h6(headingProps) {
        return <h6 className="transcript-message__heading">{headingProps.children}</h6>;
      },
      hr() {
        return <hr className="transcript-message__rule" />;
      },
      img(imageProps) {
        const altText = typeof imageProps.alt === "string" ? imageProps.alt : "";
        const src = typeof imageProps.src === "string" ? denormalizeMarkdownUrl(imageProps.src) : "";
        const title = typeof imageProps.title === "string" ? ` "${imageProps.title}"` : "";

        return (
          <span className="thread-markdown__image-literal">
            {`![${altText}](${src}${title})`}
          </span>
        );
      },
      ol(listProps) {
        return <ol className="transcript-message__list">{listProps.children}</ol>;
      },
      p(paragraphProps) {
        return (
          <p className="transcript-message__paragraph">
            {paragraphProps.children}
          </p>
        );
      },
      pre(preProps) {
        const copyText = extractTextContent(preProps.children);

        return (
          <div className="transcript-message__pre-wrap">
            {copyText ? (
              <TranscriptCopyButton
                className="transcript-copy-button--section"
                copiedLabel="Copied code"
                desktopApi={props.desktopApi}
                label="Copy code"
                text={copyText}
              />
            ) : null}
            <pre
              className="transcript-message__pre"
              aria-label="Code block"
              tabIndex={0}
            >
              {/* Tells the nested `code` renderer it is block, not inline. A
                  fence with no language produces a `<code>` with no
                  `language-` class, so the class alone cannot tell them
                  apart — and block code must never become a thread chip. */}
              <CodeBlockContext.Provider value={true}>
                {preProps.children}
              </CodeBlockContext.Provider>
            </pre>
          </div>
        );
      },
      table(tableProps) {
        return (
          <div className="thread-markdown__table-scroll" tabIndex={0}>
            <table className="thread-markdown__table">{tableProps.children}</table>
          </div>
        );
      },
      tbody(tableBodyProps) {
        return <tbody className="thread-markdown__tbody">{tableBodyProps.children}</tbody>;
      },
      td(tableCellProps) {
        return (
          <td
            className="thread-markdown__td"
            data-col-kind={dataColKind(tableCellProps.node)}
          >
            {tableCellProps.children}
          </td>
        );
      },
      th(tableHeaderCellProps) {
        return (
          <th
            className="thread-markdown__th"
            data-col-kind={dataColKind(tableHeaderCellProps.node)}
          >
            {tableHeaderCellProps.children}
          </th>
        );
      },
      thead(tableHeadProps) {
        return <thead className="thread-markdown__thead">{tableHeadProps.children}</thead>;
      },
      tr(tableRowProps) {
        return <tr className="thread-markdown__tr">{tableRowProps.children}</tr>;
      },
      ul(listProps) {
        return <ul className="transcript-message__list">{listProps.children}</ul>;
      },
    }),
    [
      editorApplication,
      markdownText,
      openLocalFileInEditor,
      openLocalFileLink,
      props.desktopApi,
      skillsByPath,
      threadLinks,
    ]
  );

  return (
    <div
      className={[
        props.className,
        "thread-markdown",
        `thread-markdown--${props.variant ?? "message"}`,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkBreaks, remarkGfm, remarkTableProfile]}
        urlTransform={normalizeMarkdownUrl}
      >
        {markdownText}
      </ReactMarkdown>
      {markdownViewerTarget ? (
        <MarkdownDocumentModal
          applications={props.applications}
          desktopApi={props.desktopApi}
          editorApplication={editorApplication}
          fileViewerContext={props.fileViewerContext}
          onClose={() => setMarkdownViewerTarget(undefined)}
          onOpenInEditor={openLocalFileInEditor}
          skills={props.skills}
          target={markdownViewerTarget}
        />
      ) : null}
    </div>
  );
});

ThreadMarkdown.displayName = "ThreadMarkdown";

function MarkdownDocumentModal(props: {
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: Pick<
    DesktopApi,
    "copyText" | "openApplication" | "openMarkdownFileViewer" | "readMarkdownFile"
  >;
  editorApplication?: EditorApplication;
  fileViewerContext?: MarkdownFileViewerContext;
  onClose: () => void;
  onOpenInEditor: (target: LocalFileTarget) => boolean;
  skills?: AppServerSkillSummary[];
  target: MarkdownViewerTarget;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [loadState, setLoadState] = useState<
    | { status: "loading" }
    | { status: "loaded"; content: string }
    | { status: "error"; error: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: "loading" });

    const readMarkdownFile = props.desktopApi?.readMarkdownFile;
    if (!readMarkdownFile) {
      setLoadState({
        status: "error",
        error: "Markdown preview is unavailable.",
      });
      return () => {
        cancelled = true;
      };
    }

    void readMarkdownFile({ path: props.target.path })
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
          error: error instanceof Error ? error.message : "Markdown file could not be read.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [props.desktopApi, props.target.path]);

  useEffect(() => {
    const restoreFocus = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] =>
      Array.from(
        contentRef.current?.querySelectorAll<HTMLElement>(
          'button, a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute("disabled"));

    focusables()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const items = focusables();
      if (items.length === 0) {
        return;
      }

      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!contentRef.current?.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      restoreFocus?.focus?.();
    };
  }, [props.onClose]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="markdown-document-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Markdown document: ${props.target.label}`}
      onClick={props.onClose}
    >
      <div
        ref={contentRef}
        className="markdown-document-modal__content"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="markdown-document-modal__head">
          <div className="markdown-document-modal__title-wrap">
            <h2 className="markdown-document-modal__title">{props.target.label}</h2>
            <p className="markdown-document-modal__path">{props.target.path}</p>
          </div>
          <div className="markdown-document-modal__actions">
            {props.editorApplication ? (
              <button
                type="button"
                className="markdown-document-modal__icon-button"
                aria-label={openFileInEditorLabel(
                  props.target.label,
                  props.editorApplication.name,
                )}
                title={openFileInEditorTitle(props.editorApplication.name)}
                onClick={() => {
                  props.onOpenInEditor(props.target);
                }}
              >
                <AppIcon
                  application={props.editorApplication}
                  className="markdown-document-modal__app-icon"
                  size={16}
                />
              </button>
            ) : null}
            {props.desktopApi?.openMarkdownFileViewer ? (
              <button
                type="button"
                className="markdown-document-modal__icon-button"
                aria-label="Open in detached files window"
                title="Open in detached files window"
                onClick={() => {
                  const context = props.fileViewerContext ??
                    fallbackFileViewerContext(props.target.path);
                  void props.desktopApi
                    ?.openMarkdownFileViewer?.({
                      context,
                      editorApplication: props.editorApplication,
                      file: {
                        path: props.target.path,
                        label: props.target.label,
                        line: props.target.line,
                        column: props.target.column,
                      },
                    })
                    .catch((error: unknown) => {
                      console.error("Failed to open markdown file viewer", error);
                    });
                }}
              >
                <PopoutIcon size={16} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              className="markdown-document-modal__icon-button"
              aria-label="Close"
              title="Close"
              onClick={props.onClose}
            >
              <CloseIcon size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="markdown-document-modal__body">
          {loadState.status === "loading" ? (
            <p className="markdown-document-modal__status">Loading document...</p>
          ) : null}
          {loadState.status === "error" ? (
            <p className="markdown-document-modal__status markdown-document-modal__status--error">
              {loadState.error}
            </p>
          ) : null}
          {loadState.status === "loaded" ? (
            <ThreadMarkdown
              applications={props.applications}
              className="markdown-document-modal__markdown"
              desktopApi={props.desktopApi}
              fileViewerContext={props.fileViewerContext}
              skills={props.skills}
              text={loadState.content}
              variant="summary"
            />
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function protectComposerHyphenListItems(markdown: string): string {
  const lines = markdown.split("\n");
  let fence: { marker: "`" | "~"; length: number } | undefined;

  return lines
    .map((line) => {
      const fenceLine = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fenceLine) {
        const sequence = fenceLine[1] ?? "";
        const marker = sequence[0] as "`" | "~";
        const trailing = fenceLine[2] ?? "";
        if (!fence) {
          fence = { marker, length: sequence.length };
        } else if (
          marker === fence.marker &&
          sequence.length >= fence.length &&
          trailing.trim() === ""
        ) {
          fence = undefined;
        }
        return line;
      }

      if (fence) {
        return line;
      }

      const hyphenOnlyListItem = line.match(/^(\s{0,3})-\s+(-+)(\s*)$/);
      if (!hyphenOnlyListItem || (hyphenOnlyListItem[2]?.length ?? 0) < 2) {
        return line;
      }

      return `${hyphenOnlyListItem[1]}- \\${hyphenOnlyListItem[2]}${hyphenOnlyListItem[3]}`;
    })
    .join("\n");
}

const normalizeMarkdownUrl: UrlTransform = (url) => {
  const trimmed = url.trim();
  if (trimmed.startsWith("/")) {
    return `file://${trimmed}`;
  }

  return isSafeMarkdownUrl(trimmed) ? trimmed : "";
};

function isSafeMarkdownUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (
    parsed.protocol === "https:" ||
    parsed.protocol === "mailto:" ||
    parsed.protocol === "file:"
  ) {
    return true;
  }

  // PwrAgent's own scheme is resolved in-app and never handed to the OS — it
  // is deliberately absent from the main process' `shell.openExternal`
  // allowlist. Navigation-only by contract; see `contracts/thread-link.ts`.
  if (parsed.protocol === PWRAGENT_URL_SCHEME) {
    return true;
  }

  return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

function isImplicitBareAutolink(params: {
  href: string;
  label: string;
  source?: string;
}): boolean {
  const source = params.source?.trim();
  if (!source || source !== params.label) {
    return false;
  }

  return (
    !source.startsWith("<") &&
    !source.startsWith("[") &&
    !/^[a-z][a-z\d+.-]*:/i.test(source)
  );
}

function dataColKind(node: unknown): string | undefined {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
  const value = properties?.["dataColKind"] ?? properties?.["data-col-kind"];
  return typeof value === "string" ? value : undefined;
}

function sourceForNode(
  markdown: string,
  node: unknown,
): string | undefined {
  const position = (
    node as {
      position?: {
        end?: { offset?: number };
        start?: { offset?: number };
      };
    }
  )?.position;
  const start = position?.start?.offset;
  const end = position?.end?.offset;

  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    start < 0 ||
    end < start
  ) {
    return undefined;
  }

  return markdown.slice(start, end);
}

function normalizeSkillPath(href: string): string | undefined {
  if (href.startsWith("file://")) {
    return stripFileLineSuffix(decodeURIComponent(href.replace(/^file:\/\//, "")));
  }

  if (href.startsWith("/")) {
    return stripFileLineSuffix(href);
  }

  return undefined;
}

function localFileTargetFromHref(
  href: string
): LocalFileTarget | undefined {
  if (href.startsWith("file://")) {
    return splitFileLineSuffix(decodeURIComponent(href.replace(/^file:\/\//, "")));
  }

  if (href.startsWith("/")) {
    return splitFileLineSuffix(href);
  }

  return undefined;
}

function isMarkdownFilePath(filePath: string): boolean {
  return /\.(?:md|markdown)$/i.test(filePath);
}

function fileNameFromPath(filePath: string): string {
  return filePath.split("/").filter(Boolean).pop() ?? filePath;
}

function openFileInEditorTitle(editorName: string): string {
  return `Open file in ${editorName}`;
}

function openFileInEditorLabel(fileLabel: string, editorName: string): string {
  return `${openFileInEditorTitle(editorName)}: ${fileLabel}`;
}

function fallbackFileViewerContext(filePath: string): MarkdownFileViewerContext {
  const directory = filePath.slice(0, Math.max(0, filePath.lastIndexOf("/"))) || filePath;
  return {
    key: `files:${directory}`,
    title: "Files",
    projectPath: directory,
  };
}

function denormalizeMarkdownUrl(url: string): string {
  if (url.startsWith("file://")) {
    return decodeURIComponent(url.replace(/^file:\/\//, ""));
  }

  return url;
}

function stripFileLineSuffix(filePath: string): string {
  return splitFileLineSuffix(filePath).path;
}

function splitFileLineSuffix(filePath: string): {
  path: string;
  line?: number;
  column?: number;
} {
  const match = /:(\d+)(?::(\d+))?$/.exec(filePath);
  if (!match) {
    return { path: filePath };
  }

  const line = Number.parseInt(match[1] ?? "", 10);
  const column = match[2] ? Number.parseInt(match[2], 10) : undefined;
  return {
    path: filePath.slice(0, match.index),
    ...(Number.isInteger(line) ? { line } : {}),
    ...(Number.isInteger(column) ? { column } : {}),
  };
}

function normalizeBlockquoteCopyText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}>\s?/, ""))
    .join("\n")
    .trim();
}

function extractTextContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (!node || typeof node === "boolean") {
    return "";
  }

  if (Array.isArray(node)) {
    return node.map((child) => extractTextContent(child)).join("");
  }

  if (typeof node === "object" && "props" in node) {
    return extractTextContent((node as { props?: { children?: ReactNode } }).props?.children);
  }

  return "";
}
