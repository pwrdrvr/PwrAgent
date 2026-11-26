import { filePreviewKind, isFilePreviewPath } from "@pwragent/shared/file-preview";
import { findSharedSkillNames, isSharedSkillName } from "@pwragent/shared/skill-origin";
import { isThreadUrl, PWRAGENT_URL_SCHEME } from "@pwragent/shared/contracts/thread-link";
import {
  extractInlineMarkdownDestination,
  isWindowsFilesystemPath,
} from "@pwragent/shared/path-display";
import {
  type AppServerSkillSummary,
  type AppServerThreadImagePart,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  type DesktopApplicationsSnapshot,
  type MarkdownFileViewerContext,
  type ResolvedTranscriptFile,
} from "@pwragent/shared/contracts/settings";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components, type Options, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { AppIcon } from "../../components/AppIcon";
import { CloseIcon, FileIcon, FolderIcon, PopoutIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { parseInstanceReferenceUrl } from "../../lib/instance-references";
import { InstanceChip } from "../federation/InstanceGlyph";
import { decodeMarkdownDestination } from "../../lib/directory-references";
import {
  protectComposerHyphenListItems,
  repairNestedLanguageFences,
} from "../../lib/markdown-fences";
import { useIncrementalMarkdownRenderer, useMarkdownMathRuntime } from "../../lib/markdown-rendering-options";
import type { MarkdownMathRuntime } from "../../lib/markdown-math-runtime";
import { MathClipboardApiContext } from "../../lib/math-clipboard-context";
import {
  resolveThreadHref,
  resolveThreadIdText,
  useThreadLinks,
  type ThreadLinkSource,
} from "../../lib/thread-links";
import {
  resolvePullRequestHref,
  usePullRequestLinks,
} from "../../lib/pull-request-links";
import { expandTildePath, tildifyPath } from "../../lib/tildify-path";
import { useModalDialog } from "../../lib/useModalDialog";
import { useFilePreviewRead } from "./useFilePreviewRead";
import { SkillChip } from "../composer/SkillChip";
import {
  PullRequestLinkChip,
  PullRequestNumberLinkChip,
} from "../pr-status/PullRequestLinkChip";
import { ThreadChip } from "./ThreadChip";
import {
  parsePullRequestNumberHref,
  remarkPullRequestReferences,
} from "./remark-pull-request-references";
import { remarkEmojiShortcodes, type RemarkEmojiShortcodesOptions } from "./remark-emoji-shortcodes";
import { remarkTableProfile } from "./remark-table-profile";
import { useDeferredEmojiShortcodeCatalog } from "../../lib/useEmojiShortcodeCatalog";
import {
  buildSelectionClipboard,
  serializeTableElementToMarkdown,
} from "./selection-clipboard";
import { TableScrollContainer, type TableExpandContext } from "./TableScrollContainer";
import {
  TableDocumentModal,
  TableViewerConfigContext,
  type TableDocumentTarget,
} from "./TableDocumentModal";
import {
  extractTableTitleFromMarkdown,
  matchesTableRowFilter,
  parsePinFirstColumnRecommendation,
} from "./table-sticky-model";
import { TranscriptCopyButton } from "./TranscriptCopyButton";
import { MermaidDiagram } from "./MermaidDiagram";
import { useMarkdownFileSource } from "./useMarkdownFileSource";
import { FileViewerHeader, splitFilePath } from "./FileViewerHeader";
import { HtmlFilePreview } from "./HtmlFilePreview";
import { isLoopbackHost } from "../../lib/loopback-host";
import {
  TranscriptFileRegistrationContext,
  useTranscriptFileReference,
  useTranscriptFiles,
} from "./useTranscriptFiles";
import {
  FilePreviewBody,
  FilePreviewCopyButton,
  filePreviewDocumentName,
} from "./FilePreview";

type ThreadMarkdownProps = {
  applications?: DesktopApplicationsSnapshot;
  className?: string;
  desktopApi?: Pick<
    DesktopApi,
    | "copyText"
    | "copyRichText"
    | "openApplication"
    | "openMarkdownFileViewer"
    | "openPath"
    | "onHtmlPreviewNavigation"
    | "readConfigBootstrap"
    | "readHtmlPreviewAssets"
    | "readMarkdownFile"
    | "resolveTranscriptFiles"
  >;
  fileViewerContext?: MarkdownFileViewerContext;
  imageParts?: AppServerThreadImagePart[];
  onOpenImage?: (image: AppServerThreadImagePart) => void;
  skills?: AppServerSkillSummary[];
  text: string;
  threadLinkSource?: ThreadLinkSource;
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
const MarkdownLinkContext = createContext(false);
const TableBodySectionContext = createContext(false);

const MarkdownCodeApiContext = createContext<Pick<DesktopApi, "copyText"> | undefined>(undefined);

// Keep the component type stable as surrounding Markdown streams.
const MarkdownPre: NonNullable<Components["pre"]> = (preProps) => {
  const desktopApi = useContext(MarkdownCodeApiContext);
  const copyText = extractTextContent(preProps.children);
  const codeNode = preProps.node?.children[0];
  if (codeNode?.type === "element"
    && codeNode.tagName === "code"
    && Array.isArray(codeNode.properties.className)
    && codeNode.properties.className.includes("language-mermaid")) {
    return <MermaidDiagram source={copyText} desktopApi={desktopApi} />;
  }

  return (
    <div className="transcript-message__pre-wrap">
      {copyText ? (
        <TranscriptCopyButton
          className="transcript-copy-button--section"
          copiedLabel="Copied code"
          desktopApi={desktopApi}
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
};

function clipboardTextFromFragment(fragment: DocumentFragment): string {
  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.style.position = "fixed";
  container.style.left = "-100000px";
  container.style.top = "0";
  container.style.pointerEvents = "none";
  container.style.whiteSpace = "pre-wrap";
  container.append(fragment.cloneNode(true));
  document.body.append(container);
  const text = container.innerText || container.textContent || "";
  container.remove();
  return text;
}

// `user-select: all` makes Chromium select the whole chip on a mousedown
// inside it, so a plain click to open the PR left the chip highlighted and a
// drag started on it began a selection. Refusing the mousedown's default keeps
// the click and leaves a drag that merely crosses a chip atomic. Shift still
// extends an existing selection over the chip.
function suppressPullRequestChipSelectionStart(
  event: MouseEvent<HTMLDivElement>,
): void {
  if (
    event.button === 0
    && !event.shiftKey
    && event.target instanceof Element
    && event.target.closest("[data-pr-chip]")
  ) {
    event.preventDefault();
  }
}

// A selection inside one message copies as Markdown text plus clean HTML, so
// plain-text targets keep list numbers and bullets. A selection that runs past
// this message keeps the browser's copy, with PR chips rewritten to URLs.
function copyTranscriptSelection(
  event: ClipboardEvent<HTMLDivElement>,
): void {
  // A nested document viewer is portalled here through React, and its own
  // ThreadMarkdown has already answered the event.
  if (event.isDefaultPrevented()) {
    return;
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  if (event.currentTarget.contains(range.commonAncestorContainer)) {
    const clipboard = buildSelectionClipboard(range, event.currentTarget);
    if (clipboard) {
      event.clipboardData.setData("text/plain", clipboard.text);
      event.clipboardData.setData("text/html", clipboard.html);
      event.preventDefault();
    }
    return;
  }

  copySelectedPullRequestLinks(event, range);
}

function copySelectedPullRequestLinks(
  event: ClipboardEvent<HTMLDivElement>,
  range: Range,
): void {
  const fragment = range.cloneContents();
  const pullRequestChips = fragment.querySelectorAll<HTMLElement>(
    "[data-pr-chip][data-pr-url]",
  );
  if (pullRequestChips.length === 0) {
    return;
  }

  pullRequestChips.forEach((chip) => {
    const href = chip.dataset.prUrl;
    if (!href) {
      return;
    }

    const link = document.createElement("a");
    link.href = href;
    link.textContent = href;
    chip.replaceWith(link);
  });

  const plainText = clipboardTextFromFragment(fragment);
  const html = document.createElement("div");
  html.append(fragment);
  event.clipboardData.setData("text/plain", plainText);
  event.clipboardData.setData("text/html", html.innerHTML);
  event.preventDefault();
}

function TranscriptCode(props: {
  children: ReactNode;
  className?: string;
  editorName?: string;
  onOpenSkillInEditor?: (skill: SkillActionTarget) => void;
  onViewSkillMarkdown?: (skill: SkillActionTarget) => void;
  skill?: AppServerSkillSummary;
}) {
  const threadLinks = useThreadLinks();
  const insideCodeBlock = useContext(CodeBlockContext);
  const insideLink = useContext(MarkdownLinkContext);
  const isBlockCode = insideCodeBlock || (props.className?.includes("language-") ?? false);
  const inlineText = !isBlockCode && !insideLink ? extractTextContent(props.children) : "";
  useTranscriptFileReference(inlineText, !isBlockCode && !insideLink && !props.skill);

  // Only inline code on a navigation-capable surface can become a chip; skip
  // the text extraction entirely on block code and on the Activity/Changelog/
  // file-viewer surfaces (no `threadLinks` context there).
  if (!isBlockCode && !insideLink && threadLinks) {
    // Transcripts written before the link protocol existed — and any model
    // that ignores the `threadLink` convention — put the bare thread id in a
    // code span. Recognizing it makes those threads reachable without asking
    // anyone to re-run anything. Gated on the id resolving to a real thread,
    // so an unrelated uuid stays plain code.
    const threadLink = resolveThreadIdText(
      inlineText,
      threadLinks,
    );
    if (threadLink) {
      return <ThreadChip link={threadLink} onOpen={threadLinks.show} />;
    }
  }

  if (isBlockCode) {
    return <code className={props.className}>{props.children}</code>;
  }

  if (insideLink) {
    return <code className="transcript-message__code">{props.children}</code>;
  }

  if (props.skill?.path) {
    return (
      <SkillChip
        editorName={props.editorName}
        onOpenInEditor={props.onOpenSkillInEditor}
        onViewMarkdown={props.onViewSkillMarkdown}
        skill={props.skill}
        transcript={true}
      />
    );
  }

  const copyText = inlineText;

  if (!copyText) {
    return <code className="transcript-message__code">{props.children}</code>;
  }

  return <InlineTranscriptCode text={copyText}>{props.children}</InlineTranscriptCode>;
}

function InlineTranscriptCode(props: { children: ReactNode; text: string }) {
  const {
    props: markdownProps,
    inlineFiles,
    editorApplication,
    openLocalFileInEditor,
    viewLocalFile,
  } = useContext(MarkdownRenderContext)!;
  const target = inlineFiles.get(props.text);
  if (target) {
    const canPreview = target.previewable && markdownProps.desktopApi?.readMarkdownFile;
    return (
      <span className="thread-markdown__file-link">
        {canPreview || markdownProps.desktopApi?.openPath ? (
          // A resolved file is actionable; unresolved inline code still copies.
          // The chip previews or opens, so the path copies from its own button.
          <>
            <a
              className="thread-markdown__file-chip tooltip-target"
              href={`file://${encodeURI(target.path)}`}
              data-tooltip={`${canPreview ? "Preview" : "Open"} ${tildifyPath(target.path)}`}
              onClick={(event) => {
                event.preventDefault();
                if (canPreview) {
                  viewLocalFile({ ...target, label: props.text });
                } else {
                  openLocalFileWithOsDefault(markdownProps.desktopApi, target.path);
                }
              }}
            >
              {/* The word joiner keeps the glyph on the line with the name. */}
              <span aria-hidden="true">
                <FileIcon className="thread-markdown__file-chip-icon" size={12} />
                {"\u2060"}
              </span>
              <code className="thread-markdown__file-chip-code">{props.children}</code>
            </a>
            <TranscriptCopyButton
              className="thread-markdown__file-copy"
              copiedLabel="Copied path"
              desktopApi={markdownProps.desktopApi}
              label={`Copy path ${tildifyPath(target.path)}`}
              text={target.path}
            />
          </>
        ) : (
          <TranscriptCopyButton
            as="span"
            className="transcript-message__inline-code transcript-copy-button--inline"
            copiedLabel="Copied inline code"
            desktopApi={markdownProps.desktopApi}
            label="Copy inline code"
            text={props.text}
          >
            <code className="transcript-message__code">{props.children}</code>
          </TranscriptCopyButton>
        )}
        {isKnownTextFile(target.path) && editorApplication && markdownProps.desktopApi?.openApplication ? (
          <button
            type="button"
            className="thread-markdown__editor-link"
            aria-label={openFileInEditorLabel(props.text, editorApplication.name)}
            title={openFileInEditorTitle(editorApplication.name)}
            onClick={() => openLocalFileInEditor(target)}
          >
            <AppIcon application={editorApplication} className="thread-markdown__editor-link-icon" size={13} />
          </button>
        ) : null}
      </span>
    );
  }

  return (
    <TranscriptCopyButton
      as="span"
      className="transcript-message__inline-code transcript-copy-button--inline"
      copiedLabel="Copied inline code"
      desktopApi={markdownProps.desktopApi}
      label="Copy inline code"
      text={props.text}
    >
      <code className="transcript-message__code">{props.children}</code>
    </TranscriptCopyButton>
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

type SkillActionTarget = AppServerSkillSummary & LocalFileTarget;

type MarkdownRenderState = {
  props: ThreadMarkdownProps;
  markdownText: string;
  sourceMarkdownText: string;
  editorApplication?: EditorApplication;
  imagePartsByPath?: ReadonlyMap<string, AppServerThreadImagePart>;
  skillsByPath: Map<string, AppServerSkillSummary & { path: string }>;
  skillsByToken: Map<string, AppServerSkillSummary & { path: string }>;
  sharedSkillNames: ReturnType<typeof findSharedSkillNames>;
  inlineFiles: Map<string, ResolvedTranscriptFile>;
  viewLocalFile: (target: MarkdownViewerTarget) => void;
  viewTable: (target: TableDocumentTarget) => void;
  openLocalFileInEditor: (target: LocalFileTarget) => boolean;
  openLocalFileLink: (event: MouseEvent<HTMLAnchorElement>, href: string, label: string) => void;
  openSkillMarkdownInEditor: (skill: SkillActionTarget) => void;
  viewSkillMarkdown: (skill: SkillActionTarget) => void;
};

const MarkdownRenderContext = createContext<MarkdownRenderState | undefined>(undefined);

// Component types must outlive snapshot updates. Recreating them replaces the
// document's DOM, clearing selections and closing nested document viewers.
const markdownComponents: Components = {
  a: function MarkdownAnchor(anchorProps) {
    const {
      props,
      markdownText,
      editorApplication,
      imagePartsByPath,
      skillsByPath,
      sharedSkillNames,
      openSkillMarkdownInEditor,
      viewSkillMarkdown,
      openLocalFileLink,
      openLocalFileInEditor,
    } = useContext(MarkdownRenderContext)!;
    // Navigation membership affects these links, not the parsed document.
    // Subscribe in the leaf so unchanged Markdown is not parsed again.
    const threadLinks = useThreadLinks();
    const pullRequestLinks = usePullRequestLinks();
    const href = typeof anchorProps.href === "string" ? anchorProps.href : "";
    const localTarget = localFileTargetFromHref(href);
    const isLocalPreviewFile = Boolean(
      localTarget && isFilePreviewPath(localTarget.path)
    );
    const skillPath = localTarget?.path;
    const label = extractTextContent(anchorProps.children).trim();
    const source = sourceForNode(markdownText, anchorProps.node);
    const linkedImage = findMarkdownLinkedImagePart(
      imagePartsByPath,
      windowsMarkdownDestinationFromSource(source) ?? href,
    );
    const linkedChildren = (
      <MarkdownLinkContext.Provider value={true}>
        {anchorProps.children}
      </MarkdownLinkContext.Provider>
    );

    if (isImplicitBareAutolink({ href, label, source })) {
      return <>{anchorProps.children}</>;
    }

    const instanceId = parseInstanceReferenceUrl(href);
    if (instanceId) {
      return <InstanceChip instanceId={instanceId} label={label} />;
    }

    if (isThreadUrl(href)) {
      const threadLink = resolveThreadHref(
        href,
        threadLinks,
        props.threadLinkSource,
      );
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

    const pullRequestNumber = parsePullRequestNumberHref(href);
    if (pullRequestNumber) {
      return (
        <PullRequestNumberLinkChip number={pullRequestNumber}>
          {linkedChildren}
        </PullRequestNumberLinkChip>
      );
    }

    const pullRequest = resolvePullRequestHref(href, pullRequestLinks);
    if (pullRequest) {
      return <PullRequestLinkChip pr={pullRequest} />;
    }

    if (linkedImage && props.onOpenImage) {
      return (
        <a
          className="transcript-message__link"
          href={linkedImage.url}
          onClick={(event) => {
            event.preventDefault();
            props.onOpenImage?.(linkedImage);
          }}
          title="Open image in PwrAgent"
        >
          {linkedChildren}
        </a>
      );
    }

    if (label.startsWith("@") && localTarget) {
      // Composer directory-reference chip (`[@label](~/path)`) —
      // render it back as a chip in the transcript, mirroring how
      // `[$name](path)` skill links become SkillChips.
      return (
        <span
          className="chip directory-chip tooltip-target"
          data-tooltip={tildifyPath(localTarget.path)}
          tabIndex={0}
        >
          <FolderIcon size={13} aria-hidden="true" />
          <span className="skill-chip__label">{label}</span>
        </span>
      );
    }

    if (
      skillPath &&
      (
        isSkillMarkdownPath(skillPath)
        || skillsByPath.has(skillPath)
        || label.startsWith("$")
      )
    ) {
      const skill = skillsByPath.get(skillPath) ?? {
        name: skillNameFromPath(skillPath, label),
        path: skillPath,
      };
      const chipLabel = label.toLowerCase() === "skill.md"
        ? skillNameFromPath(skillPath, label)
        : label;

      return (
        <SkillChip
          editorName={editorApplication?.name}
          label={chipLabel || undefined}
          onOpenInEditor={editorApplication && props.desktopApi?.openApplication
            ? openSkillMarkdownInEditor
            : undefined}
          onViewMarkdown={props.desktopApi?.readMarkdownFile
            ? viewSkillMarkdown
            : undefined}
          showOrigin={isSharedSkillName(sharedSkillNames, skill.name)}
          skill={skill}
          target={localTarget}
          transcript={true}
        />
      );
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
        title={isLocalPreviewFile && localTarget
          ? tildifyPath(localTarget.path)
          : href || undefined}
      >
        {isLocalPreviewFile && localTarget ? (
          <FileIcon className="thread-markdown__file-link-icon" size={12} aria-hidden="true" />
        ) : null}
        {linkedChildren}
      </a>
    );

    if (localTarget && isKnownTextFile(localTarget.path)) {
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
  blockquote: function MarkdownBlockquote(blockquoteProps) {
    const { props, sourceMarkdownText } = useContext(MarkdownRenderContext)!;
    const copyText = normalizeBlockquoteCopyText(
      sourceForNode(sourceMarkdownText, blockquoteProps.node) ??
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
  code: function MarkdownCode(codeProps) {
    const {
      props,
      skillsByToken,
      editorApplication,
      openSkillMarkdownInEditor,
      viewSkillMarkdown,
    } = useContext(MarkdownRenderContext)!;
    const skill = skillsByToken.get(extractTextContent(codeProps.children));
    return (
      <TranscriptCode
        className={codeProps.className}
        editorName={editorApplication?.name}
        onOpenSkillInEditor={editorApplication && props.desktopApi?.openApplication
          ? openSkillMarkdownInEditor
          : undefined}
        onViewSkillMarkdown={props.desktopApi?.readMarkdownFile
          ? viewSkillMarkdown
          : undefined}
        skill={skill}
      >
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
  img: function MarkdownImage(imageProps) {
    const { markdownText, imagePartsByPath } = useContext(MarkdownRenderContext)!;
    const altText = typeof imageProps.alt === "string" ? imageProps.alt : "";
    const href = windowsMarkdownDestinationFromSource(sourceForNode(markdownText, imageProps.node))
      ?? (typeof imageProps.src === "string" ? imageProps.src : "");

    // The message's image strip owns previews and gallery navigation. Hide
    // markup only for a reference that main successfully materialized.
    if (findMarkdownLinkedImagePart(imagePartsByPath, href)) {
      return null;
    }

    const src = denormalizeMarkdownUrl(href);
    const title = typeof imageProps.title === "string" ? ` "${imageProps.title}"` : "";

    return (
      <span className="thread-markdown__image-literal">
        {`![${altText}](${src}${title})`}
      </span>
    );
  },
  ol(listProps) {
    return <ol className="transcript-message__list" start={listProps.start}>{listProps.children}</ol>;
  },
  p(paragraphProps) {
    return (
      <p className="transcript-message__paragraph">
        {paragraphProps.children}
      </p>
    );
  },
  pre: MarkdownPre,
  table: function MarkdownTable(tableProps) {
    const renderState = useContext(MarkdownRenderContext)!;
    const viewerConfig = useContext(TableViewerConfigContext);
    const pinRecommendation = parsePinFirstColumnRecommendation(
      dataTableProperty(tableProps.node, "dataPinFirstCol", "data-pin-first-col"),
    );
    const columnCount = parsePositiveInt(
      dataTableProperty(tableProps.node, "dataTableCols", "data-table-cols"),
    );
    const rowCount = parsePositiveInt(
      dataTableProperty(tableProps.node, "dataTableRows", "data-table-rows"),
    );
    const allowPopout = viewerConfig?.allowPopout !== false;
    const handleExpand = useCallback(
      (context: TableExpandContext) => {
        const rawSource = sourceForNode(renderState.sourceMarkdownText, tableProps.node);
        const fallbackMarkdown = context.tableElement
          ? serializeTableElementToMarkdown(context.tableElement)
          : "";
        const baseMarkdown = rawSource?.trim() || fallbackMarkdown;
        if (!baseMarkdown) {
          return;
        }
        const markdown = appendMarkdownReferenceDefinitions(
          baseMarkdown,
          renderState.sourceMarkdownText,
        );
        const title = extractTableTitleFromMarkdown(
          renderState.sourceMarkdownText,
          nodeStartOffset(tableProps.node),
        );
        renderState.viewTable({
          columnCount,
          initialPinnedFirstColumn: context.pinnedFirstColumn,
          markdown,
          pinRecommendation,
          rowCount,
          title,
        });
      },
      [
        columnCount,
        pinRecommendation,
        renderState,
        rowCount,
        tableProps.node,
      ],
    );

    return (
      <TableScrollContainer
        onExpand={allowPopout ? handleExpand : undefined}
        pinRecommendation={pinRecommendation}
        pinnedFirstColumn={viewerConfig?.pinnedFirstColumn}
        showToolbar={allowPopout}
        stickyHeader={viewerConfig?.stickyHeader ?? "scroll-ancestor"}
      >
        <table
          className="thread-markdown__table"
          data-pin-first-col={pinRecommendation !== "none" ? pinRecommendation : undefined}
        >
          {tableProps.children}
        </table>
      </TableScrollContainer>
    );
  },
  tbody(tableBodyProps) {
    return (
      <TableBodySectionContext.Provider value={true}>
        <tbody className="thread-markdown__tbody">{tableBodyProps.children}</tbody>
      </TableBodySectionContext.Provider>
    );
  },
  td(tableCellProps) {
    return (
      <td
        className="thread-markdown__td"
        style={tableCellAlignStyle(tableCellProps.style)}
        data-col-kind={dataColKind(tableCellProps.node)}
        data-cell-math={dataCellMath(tableCellProps.node)}
      >
        {tableCellProps.children}
      </td>
    );
  },
  th(tableHeaderCellProps) {
    return (
      <th
        className="thread-markdown__th"
        style={tableCellAlignStyle(tableHeaderCellProps.style)}
        data-col-kind={dataColKind(tableHeaderCellProps.node)}
        data-cell-math={dataCellMath(tableHeaderCellProps.node)}
      >
        {tableHeaderCellProps.children}
      </th>
    );
  },
  thead(tableHeadProps) {
    return <thead className="thread-markdown__thead">{tableHeadProps.children}</thead>;
  },
  tr: function MarkdownTableRow(tableRowProps) {
    const inBody = useContext(TableBodySectionContext);
    const filterQuery = useContext(TableViewerConfigContext)?.rowFilterQuery ?? "";
    const hidden = inBody && filterQuery.trim().length > 0
      ? !matchesTableRowFilter(extractTextContent(tableRowProps.children), filterQuery)
      : false;
    return (
      <tr className="thread-markdown__tr" hidden={hidden || undefined}>
        {tableRowProps.children}
      </tr>
    );
  },
  ul(listProps) {
    return <ul className="transcript-message__list">{listProps.children}</ul>;
  },
};

// Parsing belongs to the document text and parser configuration, not the
// surrounding application snapshot, file hydration, or document-viewer state.
// Context consumers below this boundary still update their links and controls.
const MarkdownDocument = memo(function MarkdownDocument(props: {
  text: string;
  mathRuntime?: MarkdownMathRuntime;
}) {
  const availableRenderer = useIncrementalMarkdownRenderer();
  const [selection, setSelection] = useState(() => ({
    text: props.text,
    renderer: availableRenderer,
  }));
  // Loading or enabling the experiment must not reparse settled messages or
  // replace their DOM (and selection). Adopt it on the next text change;
  // disabling still takes effect immediately. State keeps aborted renders
  // from changing the renderer chosen by the committed document.
  if (props.text !== selection.text || (!availableRenderer && selection.renderer)) {
    setSelection({ text: props.text, renderer: availableRenderer });
  }
  return <MarkdownDocumentContent {...props} IncrementalRenderer={selection.renderer} />;
});

const MarkdownDocumentContent = memo(function MarkdownDocumentContent(props: {
  text: string;
  mathRuntime?: MarkdownMathRuntime;
  IncrementalRenderer: ReturnType<typeof useIncrementalMarkdownRenderer>;
}) {
  const { IncrementalRenderer } = props;
  const { catalog: emojiCatalog, requestCatalog: requestEmojiCatalog } =
    useDeferredEmojiShortcodeCatalog();
  const remarkPlugins = useMemo<Options["remarkPlugins"]>(() => [
    ...(props.mathRuntime?.remarkPlugins ?? []),
    remarkBreaks,
    [remarkGfm, { singleTilde: false }],
    remarkPullRequestReferences,
    [
      remarkEmojiShortcodes,
      {
        catalog: emojiCatalog,
        onMissingCatalog: requestEmojiCatalog,
      } satisfies RemarkEmojiShortcodesOptions,
    ],
    remarkTableProfile,
  ], [emojiCatalog, props.mathRuntime, requestEmojiCatalog]);
  const components = useMemo(() => ({
    ...markdownComponents, ...props.mathRuntime?.components,
  }), [props.mathRuntime]);
  const options = {
    components,
    rehypePlugins: props.mathRuntime?.rehypePlugins,
    remarkPlugins,
    urlTransform: normalizeMarkdownUrl,
  };
  return IncrementalRenderer ? (
    <IncrementalRenderer
      mathFlow={Boolean(props.mathRuntime)}
      {...options}
    >
      {props.text}
    </IncrementalRenderer>
  ) : (
    <ReactMarkdown {...options}>{props.text}</ReactMarkdown>
  );
});

export const ThreadMarkdown = memo(function ThreadMarkdown(props: ThreadMarkdownProps) {
  const sourceMarkdownText = useMemo(
    () => protectComposerHyphenListItems(repairNestedLanguageFences(props.text)),
    [props.text]
  );
  const mathRuntime = useMarkdownMathRuntime(sourceMarkdownText);
  const markdownText = useMemo(
    () => mathRuntime?.normalize(sourceMarkdownText) ?? sourceMarkdownText,
    [mathRuntime, sourceMarkdownText]
  );
  const [markdownViewerTarget, setMarkdownViewerTarget] =
    useState<MarkdownViewerTarget>();
  const [tableViewerTarget, setTableViewerTarget] =
    useState<TableDocumentTarget>();
  const { files: inlineFiles, register: registerInlineFile } = useTranscriptFiles(props.desktopApi, props.fileViewerContext);
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
  /**
   * Names more than one skill in the catalog answers to. A chip for one of
   * those says which project it came from, the way the picker and the
   * composer's own chips do.
   *
   * This component renders once per transcript message, so the answer is
   * cached on the catalog itself rather than derived per message.
   */
  const sharedSkillNames = useMemo(
    () => findSharedSkillNames(props.skills ?? []),
    [props.skills],
  );
  // A bare `$release` in a code span names no file. With one `release` in
  // the catalog it can only mean that one; with several, any pick would be a
  // guess, and the chip would offer to open some other project's file — so
  // those stay plain code.
  const skillsByToken = useMemo(
    () =>
      new Map(
        (props.skills ?? [])
          .filter(
            (skill): skill is AppServerSkillSummary & { path: string } =>
              Boolean(skill.path) && !isSharedSkillName(sharedSkillNames, skill.name)
          )
          .map((skill) => [`$${skill.name}`, skill])
      ),
    [props.skills, sharedSkillNames]
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

      if (isFilePreviewPath(target.path) && props.desktopApi?.readMarkdownFile) {
        event.preventDefault();
        setMarkdownViewerTarget({
          ...target,
          label: label || fileNameFromPath(target.path),
        });
        return;
      }

      event.preventDefault();
      openLocalFileWithOsDefault(props.desktopApi, target.path);
    },
    [props.desktopApi]
  );

  const viewSkillMarkdown = useCallback(
    (skill: SkillActionTarget): void => {
      if (!props.desktopApi?.readMarkdownFile) {
        return;
      }

      setMarkdownViewerTarget({
        column: skill.column,
        label: `$${skill.name}`,
        line: skill.line,
        path: skill.path,
      });
    },
    [props.desktopApi]
  );

  const openSkillMarkdownInEditor = useCallback(
    (skill: SkillActionTarget): void => {
      openLocalFileInEditor({
        column: skill.column,
        line: skill.line,
        path: skill.path,
      });
    },
    [openLocalFileInEditor]
  );

  const imagePartsByPath = useMemo(
    () => indexMarkdownImagePartsByPath(props.imageParts),
    [props.imageParts],
  );

  const renderState = useMemo<MarkdownRenderState>(() => ({
    props,
    markdownText,
    sourceMarkdownText,
    editorApplication,
    imagePartsByPath,
    skillsByPath,
    skillsByToken,
    sharedSkillNames,
    inlineFiles,
    viewLocalFile: setMarkdownViewerTarget,
    viewTable: setTableViewerTarget,
    openLocalFileInEditor,
    openLocalFileLink,
    openSkillMarkdownInEditor,
    viewSkillMarkdown,
  }), [
    props,
    markdownText,
    sourceMarkdownText,
    editorApplication,
    imagePartsByPath,
    skillsByPath,
    skillsByToken,
    sharedSkillNames,
    inlineFiles,
    openLocalFileInEditor,
    openLocalFileLink,
    openSkillMarkdownInEditor,
    viewSkillMarkdown,
  ]);

  return (
    <div
      className={[
        props.className,
        "thread-markdown",
        `thread-markdown--${props.variant ?? "message"}`,
      ]
        .filter(Boolean)
        .join(" ")}
      onCopy={copyTranscriptSelection}
      onMouseDown={suppressPullRequestChipSelectionStart}
    >
      <MarkdownRenderContext.Provider value={renderState}>
        <TranscriptFileRegistrationContext.Provider value={registerInlineFile}>
          <MarkdownCodeApiContext.Provider value={props.desktopApi}>
            <MathClipboardApiContext.Provider value={props.desktopApi}>
              <MarkdownDocument
                text={markdownText}
                mathRuntime={mathRuntime}
              />
            </MathClipboardApiContext.Provider>
          </MarkdownCodeApiContext.Provider>
        </TranscriptFileRegistrationContext.Provider>
      </MarkdownRenderContext.Provider>
      {markdownViewerTarget ? (
        <MarkdownDocumentModal
          applications={props.applications}
          desktopApi={props.desktopApi}
          editorApplication={editorApplication}
          fileViewerContext={props.fileViewerContext}
          onClose={() => setMarkdownViewerTarget(undefined)}
          onOpenInEditor={openLocalFileInEditor}
          onOpenTarget={setMarkdownViewerTarget}
          skills={props.skills}
          target={markdownViewerTarget}
        />
      ) : null}
      {tableViewerTarget ? (
        <TableDocumentModal
          desktopApi={props.desktopApi}
          onClose={() => setTableViewerTarget(undefined)}
          renderTable={(config) => (
            <TableViewerConfigContext.Provider value={config}>
              <ThreadMarkdown
                applications={props.applications}
                className="table-viewer-modal__markdown"
                desktopApi={props.desktopApi}
                fileViewerContext={props.fileViewerContext}
                imageParts={props.imageParts}
                onOpenImage={props.onOpenImage}
                skills={props.skills}
                text={tableViewerTarget.markdown}
                threadLinkSource={props.threadLinkSource}
                variant="summary"
              />
            </TableViewerConfigContext.Provider>
          )}
          target={tableViewerTarget}
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
    | "copyText"
    | "copyRichText"
    | "openApplication"
    | "openMarkdownFileViewer"
    | "openPath"
    | "onHtmlPreviewNavigation"
    | "readConfigBootstrap"
    | "readHtmlPreviewAssets"
    | "readMarkdownFile"
  >;
  editorApplication?: EditorApplication;
  fileViewerContext?: MarkdownFileViewerContext;
  onClose: () => void;
  onOpenInEditor: (target: LocalFileTarget) => boolean;
  onOpenTarget: (target: MarkdownViewerTarget) => void;
  skills?: AppServerSkillSummary[];
  target: MarkdownViewerTarget;
}) {
  // The message hands this a fresh onClose each time it renders. The hook
  // reads the latest one on Escape. The effect it replaced depended on it, so
  // any re-render of the message sent focus back to the first control.
  const contentRef = useModalDialog({ onClose: props.onClose });
  // The HTML preview renders its permissions into the header row.
  const [headerControls, setHeaderControls] = useState<HTMLDivElement | null>(null);
  const previewKind = filePreviewKind(props.target.path) ?? "markdown";
  const readMarkdownFile = props.desktopApi?.readMarkdownFile;
  const { thread, federationTarget } = useMarkdownFileSource(props.fileViewerContext);
  const loadState = useFilePreviewRead(readMarkdownFile, props.target.path, thread, federationTarget);
  const onOpenTarget = props.onOpenTarget;
  const openLinkedFile = useCallback((path: string) => {
    onOpenTarget({ path, label: fileNameFromPath(path) });
  }, [onOpenTarget]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="markdown-document-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`${filePreviewDocumentName(previewKind)}: ${props.target.label}`}
      onClick={props.onClose}
    >
      <div
        ref={contentRef}
        className={[
          "markdown-document-modal__content",
          previewKind === "html" ? "markdown-document-modal__content--html" : undefined,
        ].filter(Boolean).join(" ")}
        onClick={(event) => event.stopPropagation()}
      >
        <FileViewerHeader
          actions={(
            <>
              {loadState.status === "loaded" ? (
                <FilePreviewCopyButton
                  content={loadState.content}
                  desktopApi={props.desktopApi}
                  kind={previewKind}
                />
              ) : null}
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
            </>
          )}
          controlsRef={setHeaderControls}
          desktopApi={props.desktopApi}
          headingLevel={2}
          kind={previewKind}
          path={props.target.path}
        />

        <div
          className={[
            "markdown-document-modal__body",
            previewKind === "markdown" ? undefined : "markdown-document-modal__body--file",
            previewKind === "html" ? "markdown-document-modal__body--html" : undefined,
          ].filter(Boolean).join(" ")}
        >
          {loadState.status === "loading" ? (
            <p className="markdown-document-modal__status">Loading file…</p>
          ) : null}
          {loadState.status === "error" ? (
            <p className="markdown-document-modal__status markdown-document-modal__status--error">
              {loadState.error}
            </p>
          ) : null}
          {loadState.status === "loaded" ? (previewKind === "html" ? (
            <HtmlFilePreview
              // A linked page starts over: its own scripts default and links.
              key={props.target.path}
              content={loadState.content}
              desktopApi={props.desktopApi}
              federationTarget={federationTarget}
              label={props.target.label}
              path={props.target.path}
              threadWorkspace={loadState.threadWorkspace}
              controlsContainer={headerControls}
              onOpenLocalFile={openLinkedFile}
            />
          ) : previewKind !== "markdown" ? (
            <FilePreviewBody
              content={loadState.content}
              kind={previewKind}
              targetLine={props.target.line}
            />
          ) : (
            <ThreadMarkdown
              applications={props.applications}
              className="markdown-document-modal__markdown"
              desktopApi={props.desktopApi}
              fileViewerContext={props.fileViewerContext}
              skills={props.skills}
              text={loadState.content}
              variant="summary"
            />
          )) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function encodePosixPathForFileUrl(filePath: string): string {
  return filePath
    .replace(/%(?![0-9a-fA-F]{2})/g, "%25")
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F");
}

function normalizePathSegments(segments: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized;
}

function normalizePosixPath(filePath: string): string {
  return `/${normalizePathSegments(filePath.split("/")).join("/")}`;
}

function normalizeWindowsDrivePath(filePath: string): string {
  const slashPath = filePath.replace(/\\/g, "/");
  const drive = slashPath.slice(0, 2).toUpperCase();
  const normalized = normalizePathSegments(slashPath.slice(2).split("/"));
  return `${drive}/${normalized.join("/")}`;
}

function normalizeWindowsUncPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean);
  const [host, share, ...rest] = parts;
  if (!host) {
    return "/";
  }
  if (!share) {
    return `//${host}`;
  }
  const normalized = normalizePathSegments(rest);
  return normalized.length > 0
    ? `//${host}/${share}/${normalized.join("/")}`
    : `//${host}/${share}`;
}

const normalizeMarkdownUrl: UrlTransform = (url) => {
  const trimmed = url.trim();
  if (trimmed.startsWith("/")) {
    return `file://${encodePosixPathForFileUrl(trimmed)}`;
  }
  if (isWindowsFilesystemPath(decodeMarkdownDestination(trimmed))) {
    // Directory chips serialize Windows separators as %5C. Classify the
    // decoded path, but retain its encoding here so localFileTargetFromHref
    // decodes exactly once (a filename containing literal %5C stays literal).
    return `file://${trimmed}`;
  }
  if (trimmed.startsWith("~/")) {
    // Composer directory-reference links (`[@label](~/path)`) and other
    // tilde-form local paths — expand to the same file:// form as
    // absolute paths so the local-file machinery (and the directory
    // chip) can resolve them.
    const expanded = expandTildePath(trimmed);
    return `file://${expanded.startsWith("/") ? encodePosixPathForFileUrl(expanded) : expanded}`;
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

function dataCellMath(node: unknown): string | undefined {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
  const value = properties?.["dataCellMath"] ?? properties?.["data-cell-math"];
  return value === "only" ? value : undefined;
}

function dataTableProperty(
  node: unknown,
  camelKey: string,
  kebabKey: string,
): unknown {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
  return properties?.[camelKey] ?? properties?.[kebabKey];
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function nodeStartOffset(node: unknown): number | undefined {
  const offset = (
    node as { position?: { start?: { offset?: number } } } | undefined
  )?.position?.start?.offset;
  return typeof offset === "number" && Number.isFinite(offset) && offset >= 0
    ? offset
    : undefined;
}

function appendMarkdownReferenceDefinitions(
  tableMarkdown: string,
  sourceMarkdown: string,
): string {
  const definitions = sourceMarkdown
    .split("\n")
    .filter((line) => /^\s{0,3}\[[^\]]+\]:\s+\S/.test(line));
  if (definitions.length === 0) {
    return tableMarkdown;
  }
  const missing = definitions.filter((definition) => !tableMarkdown.includes(definition));
  return missing.length > 0
    ? `${tableMarkdown}\n\n${missing.join("\n")}`
    : tableMarkdown;
}

function tableCellAlignStyle(
  style: CSSProperties | undefined,
): CSSProperties | undefined {
  const textAlign = style?.textAlign;
  return textAlign === "left" || textAlign === "center" || textAlign === "right"
    ? { textAlign }
    : undefined;
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

function isSkillMarkdownPath(filePath: string): boolean {
  return /(?:^|\/)SKILL\.md$/i.test(filePath);
}

function skillNameFromPath(filePath: string, label: string): string {
  const segments = filePath.split("/").filter(Boolean);
  if (segments.at(-1)?.toLowerCase() === "skill.md" && segments.length > 1) {
    return segments.at(-2) ?? "skill";
  }
  return label.replace(/^\$/, "") || segments.at(-1) || "skill";
}

function openLocalFileWithOsDefault(
  desktopApi: Pick<DesktopApi, "openPath"> | undefined,
  path: string,
): void {
  void desktopApi?.openPath?.({ path })
    .then((response) => {
      if (!response.opened) {
        console.error("Failed to open transcript file link", response.error);
      }
    })
    .catch((error: unknown) => {
      console.error("Failed to open transcript file link", error);
    });
}

// This only controls the optional editor button. File opens always use the
// OS default unless an in-app preview is available.
const TEXT_FILE_EXTENSIONS = new Set([
  "c", "cc", "cpp", "cs", "css", "csv", "cxx", "fish", "go", "graphql", "h", "hpp",
  "htm", "html", "ini", "java", "js", "json", "jsonc", "jsonl", "jsx", "kt", "kts", "less",
  "log", "lua", "m", "markdown", "md", "mdx", "mm", "ndjson", "php", "pl", "ps1", "py", "r",
  "rb", "rs", "rst", "sass", "scala", "scss", "sh", "sql", "svelte", "swift", "tex",
  "toml", "ts", "tsv", "tsx", "txt", "vue", "xml", "yaml", "yml", "zsh",
]);
const TEXT_FILE_NAMES = new Set([
  ".bashrc", ".bash_profile", ".editorconfig", ".env", ".gitattributes", ".gitignore",
  ".npmrc", ".zprofile", ".zshrc", "dockerfile", "gemfile", "license", "makefile", "readme",
]);

function isKnownTextFile(filePath: string): boolean {
  const name = filePath.split(/[/\\]/).at(-1)?.toLowerCase() ?? "";
  const extension = /\.([^.]+)$/.exec(name)?.[1];
  return TEXT_FILE_NAMES.has(name)
    || name.startsWith(".env.")
    || (extension !== undefined && TEXT_FILE_EXTENSIONS.has(extension));
}

function localFileTargetFromHref(
  href: string
): LocalFileTarget | undefined {
  if (/^file:\/\//i.test(href)) {
    return splitFileLineSuffix(decodeMarkdownDestination(href.replace(/^file:\/\//i, "")));
  }

  if (href.startsWith("/")) {
    return splitFileLineSuffix(href);
  }

  return undefined;
}

function windowsMarkdownDestinationFromSource(source: string | undefined): string | undefined {
  // CommonMark treats '\\.' and '\\_' as escapes, even inside Windows paths.
  // Match the original destination used by main's image materializer, before
  // Markdown removes those filesystem separators.
  const destination = extractInlineMarkdownDestination(source);
  return destination
    && destination.includes("\\")
    && isWindowsFilesystemPath(decodeMarkdownDestination(destination))
    ? `file://${destination}`
    : undefined;
}

function markdownImagePathFromHref(href: string): string | undefined {
  let imagePath = href;
  let isUnc = false;
  if (/^file:\/\//i.test(href)) {
    // Markdown encodes backslashes. The renderer's file:// wrapper can
    // therefore contain a drive or UNC path rather than a standard file URL.
    const localPath = decodeMarkdownDestination(href.slice("file://".length));
    if (/^[a-z]:[\\/]/i.test(localPath)) {
      imagePath = localPath;
    } else if (localPath.startsWith("\\\\")) {
      imagePath = localPath;
      isUnc = true;
    } else {
      try {
        const url = new URL(href);
        const hasUncHost = Boolean(url.hostname && url.hostname.toLowerCase() !== "localhost");
        isUnc = hasUncHost;
        imagePath = decodeMarkdownDestination(
          hasUncHost ? `//${url.hostname}${url.pathname}` : url.pathname,
        );
      } catch {
        return undefined;
      }
    }
  } else if (href.startsWith("\\\\")) {
    isUnc = true;
  }
  // File URLs prefix drive paths with '/', and Windows uses either separator.
  // Infer the owning platform from the path, including for federated images.
  if (!isUnc && /^\/[a-z]:[\\/]/i.test(imagePath)) imagePath = imagePath.slice(1);
  if (/^[a-z]:[\\/]/i.test(imagePath)) {
    return normalizeWindowsDrivePath(splitFileLineSuffix(imagePath.replace(/\\/g, "/")).path);
  }
  if (isUnc) {
    return normalizeWindowsUncPath(splitFileLineSuffix(imagePath.replace(/\\/g, "/")).path);
  }
  return imagePath.startsWith("/")
    ? normalizePosixPath(splitFileLineSuffix(imagePath).path)
    : undefined;
}

function indexMarkdownImagePartsByPath(
  imageParts: AppServerThreadImagePart[] | undefined,
): ReadonlyMap<string, AppServerThreadImagePart> | undefined {
  if (!imageParts?.length) {
    return undefined;
  }
  const byPath = new Map<string, AppServerThreadImagePart>();
  for (const imagePart of imageParts) {
    if (!imagePart.sourceUrl) {
      continue;
    }
    const normalized = markdownImagePathFromHref(imagePart.sourceUrl);
    if (normalized && !byPath.has(normalized)) {
      byPath.set(normalized, imagePart);
    }
  }
  return byPath.size > 0 ? byPath : undefined;
}

function findMarkdownLinkedImagePart(
  imagePartsByPath: ReadonlyMap<string, AppServerThreadImagePart> | undefined,
  href: string,
): AppServerThreadImagePart | undefined {
  if (!imagePartsByPath) {
    return undefined;
  }
  const targetPath = markdownImagePathFromHref(href);
  return targetPath ? imagePartsByPath.get(targetPath) : undefined;
}

function fileNameFromPath(filePath: string): string {
  return splitFilePath(filePath).name || filePath;
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
  if (/^file:\/\//i.test(url)) {
    return decodeMarkdownDestination(url.replace(/^file:\/\//i, ""));
  }

  return url;
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
