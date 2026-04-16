import { Fragment, type ReactNode } from "react";

type MarkdownTextProps = {
  className?: string;
  text: string;
};

type MarkdownBlock =
  | {
      type: "blockquote";
      text: string;
    }
  | {
      type: "code";
      code: string;
      language?: string;
    }
  | {
      type: "heading";
      level: 1 | 2 | 3 | 4 | 5 | 6;
      text: string;
    }
  | {
      type: "ordered-list";
      items: string[];
    }
  | {
      type: "paragraph";
      text: string;
    }
  | {
      type: "unordered-list";
      items: string[];
    };

export function MarkdownText(props: MarkdownTextProps) {
  const blocks = parseBlocks(props.text);

  return (
    <div className={props.className}>
      {blocks.map((block, index) => (
        <Fragment key={`block-${index}`}>{renderBlock(block, index)}</Fragment>
      ))}
    </div>
  );
}

function renderBlock(block: MarkdownBlock, index: number): ReactNode {
  if (block.type === "code") {
    return (
      <pre className="transcript-message__pre">
        <code>{block.code}</code>
      </pre>
    );
  }

  if (block.type === "blockquote") {
    return (
      <blockquote className="transcript-message__blockquote">
        {renderInline(block.text, `blockquote-${index}`)}
      </blockquote>
    );
  }

  if (block.type === "unordered-list") {
    return (
      <ul className="transcript-message__list">
        {block.items.map((item, itemIndex) => (
          <li key={`ul-item-${index}-${itemIndex}`}>
            {renderInline(item, `ul-${index}-${itemIndex}`)}
          </li>
        ))}
      </ul>
    );
  }

  if (block.type === "ordered-list") {
    return (
      <ol className="transcript-message__list">
        {block.items.map((item, itemIndex) => (
          <li key={`ol-item-${index}-${itemIndex}`}>
            {renderInline(item, `ol-${index}-${itemIndex}`)}
          </li>
        ))}
      </ol>
    );
  }

  if (block.type === "heading") {
    const HeadingTag = `h${block.level}` as const;
    return (
      <HeadingTag className="transcript-message__heading">
        {renderInline(block.text, `heading-${index}`)}
      </HeadingTag>
    );
  }

  return (
    <p className="transcript-message__paragraph">
      {renderInline(block.text, `paragraph-${index}`)}
    </p>
  );
}

function parseBlocks(text: string): MarkdownBlock[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();

  if (!normalized) {
    return [{ type: "paragraph", text: "" }];
  }

  const lines = normalized.split("\n");
  const blocks: MarkdownBlock[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; ) {
    const line = lines[lineIndex] ?? "";

    if (!line.trim()) {
      lineIndex += 1;
      continue;
    }

    const fenceMatch = line.match(/^```([\w-]+)?\s*$/);
    if (fenceMatch) {
      const codeLines: string[] = [];
      lineIndex += 1;
      while (lineIndex < lines.length && !/^```\s*$/.test(lines[lineIndex] ?? "")) {
        codeLines.push(lines[lineIndex] ?? "");
        lineIndex += 1;
      }
      if (lineIndex < lines.length) {
        lineIndex += 1;
      }
      blocks.push({
        type: "code",
        code: codeLines.join("\n"),
        language: fenceMatch[1]
      });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (lineIndex < lines.length && /^>\s?/.test(lines[lineIndex] ?? "")) {
        quoteLines.push((lines[lineIndex] ?? "").replace(/^>\s?/, ""));
        lineIndex += 1;
      }
      blocks.push({ type: "blockquote", text: quoteLines.join("\n") });
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (lineIndex < lines.length && /^[-*]\s+/.test(lines[lineIndex] ?? "")) {
        items.push((lines[lineIndex] ?? "").replace(/^[-*]\s+/, ""));
        lineIndex += 1;
      }
      blocks.push({ type: "unordered-list", items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (lineIndex < lines.length && /^\d+\.\s+/.test(lines[lineIndex] ?? "")) {
        items.push((lines[lineIndex] ?? "").replace(/^\d+\.\s+/, ""));
        lineIndex += 1;
      }
      blocks.push({ type: "ordered-list", items });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: headingMatch[2]
      });
      lineIndex += 1;
      continue;
    }

    const paragraphLines: string[] = [];
    while (lineIndex < lines.length) {
      const currentLine = lines[lineIndex] ?? "";
      if (
        !currentLine.trim() ||
        /^```/.test(currentLine) ||
        /^>\s?/.test(currentLine) ||
        /^[-*]\s+/.test(currentLine) ||
        /^\d+\.\s+/.test(currentLine) ||
        /^(#{1,6})\s+/.test(currentLine)
      ) {
        break;
      }
      paragraphLines.push(currentLine);
      lineIndex += 1;
    }

    blocks.push({
      type: "paragraph",
      text: paragraphLines.join("\n")
    });
  }

  return blocks;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(`[^`\n]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const matchedText = match[0];
    const matchIndex = match.index ?? 0;

    if (matchIndex > lastIndex) {
      nodes.push(...renderTextSpan(text.slice(lastIndex, matchIndex), `${keyPrefix}-text-${tokenIndex}`));
    }

    if (matchedText.startsWith("`")) {
      nodes.push(
        <code key={`${keyPrefix}-code-${tokenIndex}`} className="transcript-message__code">
          {matchedText.slice(1, -1)}
        </code>
      );
    } else {
      const linkMatch = matchedText.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const href = normalizeHref(linkMatch[2]);
        if (href) {
          nodes.push(
            <a
              key={`${keyPrefix}-link-${tokenIndex}`}
              className="transcript-message__link"
              href={href}
              rel="noreferrer"
              target="_blank"
              title={linkMatch[2]}
            >
              {linkMatch[1]}
            </a>
          );
        } else {
          nodes.push(...renderTextSpan(matchedText, `${keyPrefix}-fallback-${tokenIndex}`));
        }
      }
    }

    lastIndex = matchIndex + matchedText.length;
    tokenIndex += 1;
  }

  if (lastIndex < text.length) {
    nodes.push(...renderTextSpan(text.slice(lastIndex), `${keyPrefix}-tail`));
  }

  if (nodes.length === 0) {
    return renderTextSpan(text, `${keyPrefix}-empty`);
  }

  return nodes;
}

function renderTextSpan(text: string, keyPrefix: string): ReactNode[] {
  const lines = text.split("\n");
  const nodes: ReactNode[] = [];

  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      nodes.push(<br key={`${keyPrefix}-br-${lineIndex}`} />);
    }
    if (line.length > 0) {
      nodes.push(<Fragment key={`${keyPrefix}-line-${lineIndex}`}>{line}</Fragment>);
    }
  });

  return nodes;
}

function normalizeHref(href: string): string | null {
  const trimmedHref = href.trim();

  if (
    trimmedHref.startsWith("http://") ||
    trimmedHref.startsWith("https://") ||
    trimmedHref.startsWith("mailto:")
  ) {
    return trimmedHref;
  }

  if (trimmedHref.startsWith("/")) {
    return `file://${trimmedHref}`;
  }

  return null;
}
