import type {
  AppServerSkillSummary,
  DesktopApplicationsSnapshot,
} from "@pwragent/shared";
import { memo, useCallback, useMemo, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { DesktopApi } from "../../lib/desktop-api";
import { SkillChip } from "../composer/SkillChip";
import { remarkTableProfile } from "./remark-table-profile";

type ThreadMarkdownProps = {
  applications?: DesktopApplicationsSnapshot;
  className?: string;
  desktopApi?: Pick<DesktopApi, "openApplication">;
  skills?: AppServerSkillSummary[];
  text: string;
  variant?: "message" | "summary";
};

export const ThreadMarkdown = memo(function ThreadMarkdown(props: ThreadMarkdownProps) {
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

  const openLocalFileLink = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, href: string): void => {
      const target = localFileTargetFromHref(href);
      if (!target || !editorApplication || !props.desktopApi?.openApplication) {
        return;
      }

      event.preventDefault();
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
    },
    [editorApplication, props.desktopApi]
  );

  const components = useMemo<Components>(
    () => ({
      a(anchorProps) {
        const href = typeof anchorProps.href === "string" ? anchorProps.href : "";
        const skillPath = normalizeSkillPath(href);
        const label = extractTextContent(anchorProps.children).trim();
        const source = sourceForNode(props.text, anchorProps.node);

        if (isImplicitBareAutolink({ href, label, source })) {
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

        return (
          <a
            className="transcript-message__link"
            href={href || undefined}
            onClick={(event) => {
              openLocalFileLink(event, href);
            }}
            rel="noopener noreferrer"
            target="_blank"
            title={href || undefined}
          >
            {anchorProps.children}
          </a>
        );
      },
      blockquote(blockquoteProps) {
        return (
          <blockquote className="transcript-message__blockquote">
            {blockquoteProps.children}
          </blockquote>
        );
      },
      code(codeProps) {
        const className = typeof codeProps.className === "string" ? codeProps.className : "";
        const isBlockCode = className.includes("language-");

        return (
          <code
            className={isBlockCode ? codeProps.className : "transcript-message__code"}
          >
            {codeProps.children}
          </code>
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
        return <pre className="transcript-message__pre">{preProps.children}</pre>;
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
    [openLocalFileLink, props.text, skillsByPath]
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
        {props.text}
      </ReactMarkdown>
    </div>
  );
});

ThreadMarkdown.displayName = "ThreadMarkdown";

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
): { path: string; line?: number; column?: number } | undefined {
  if (href.startsWith("file://")) {
    return splitFileLineSuffix(decodeURIComponent(href.replace(/^file:\/\//, "")));
  }

  if (href.startsWith("/")) {
    return splitFileLineSuffix(href);
  }

  return undefined;
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
