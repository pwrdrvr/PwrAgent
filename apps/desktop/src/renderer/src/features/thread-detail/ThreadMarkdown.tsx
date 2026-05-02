import type {
  AppServerSkillSummary,
  DesktopApplicationsSnapshot,
} from "@pwragnt/shared";
import { memo, useCallback, useMemo, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { DesktopApi } from "../../lib/desktop-api";
import { SkillChip } from "../composer/SkillChip";

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
      const targetPath = localFilePathFromHref(href);
      if (!targetPath || !editorApplication || !props.desktopApi?.openApplication) {
        return;
      }

      event.preventDefault();
      void props.desktopApi
        .openApplication({
          applicationId: editorApplication.id,
          kind: "editor",
          targetPath,
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

        return (
          <a
            className="transcript-message__link"
            href={href || undefined}
            onClick={(event) => {
              openLocalFileLink(event, href);
            }}
            rel="noreferrer"
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
      ul(listProps) {
        return <ul className="transcript-message__list">{listProps.children}</ul>;
      },
    }),
    [openLocalFileLink, skillsByPath]
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
        remarkPlugins={[remarkBreaks, remarkGfm]}
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

  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("file://")
  ) {
    return trimmed;
  }

  return "";
};

function normalizeSkillPath(href: string): string | undefined {
  if (href.startsWith("file://")) {
    return stripFileLineSuffix(decodeURIComponent(href.replace(/^file:\/\//, "")));
  }

  if (href.startsWith("/")) {
    return stripFileLineSuffix(href);
  }

  return undefined;
}

function localFilePathFromHref(href: string): string | undefined {
  if (href.startsWith("file://")) {
    return stripFileLineSuffix(decodeURIComponent(href.replace(/^file:\/\//, "")));
  }

  if (href.startsWith("/")) {
    return stripFileLineSuffix(href);
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
  return filePath.replace(/:(\d+)(?::\d+)?$/, "");
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
