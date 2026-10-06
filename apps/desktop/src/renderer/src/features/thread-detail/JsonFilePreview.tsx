import { useMemo } from "react";

type JsonPreviewToken = {
  text: string;
  kind: "key" | "string" | "number" | "literal" | "punctuation";
};

export function isJsonFilePath(path: string): boolean {
  return /\.json$/i.test(path);
}

export function JsonFilePreview(props: {
  content: string;
}) {
  const preview = useMemo(() => formatJsonPreview(props.content), [props.content]);
  return (
    <div className="json-file-preview">
      {preview.error ? (
        <p className="json-file-preview__error" role="status">
          Invalid JSON. Showing the original file.
        </p>
      ) : null}
      <pre className="json-file-preview__code" aria-label="JSON contents" tabIndex={0}>
        <code>{preview.tokens ? preview.tokens.map((token, index) => (
          <span key={index} className={`json-file-preview__${token.kind}`}>{token.text}</span>
        )) : preview.text}</code>
      </pre>
    </div>
  );
}

function formatJsonPreview(content: string): {
  text: string;
  tokens?: JsonPreviewToken[];
  error?: boolean;
} {
  // Validate without serializing the parsed value: large integers, duplicate
  // keys and the original number/string spellings must survive the preview.
  try {
    JSON.parse(content);
  } catch {
    return { text: content, error: true };
  }

  const tokens = content.match(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g) ?? [];
  const parts: string[] = [];
  // Bound React's work for large files. They still receive indentation but
  // render as one text node rather than thousands of syntax elements.
  const highlighted: JsonPreviewToken[] | undefined = tokens.length <= 10000 ? [] : undefined;
  let depth = 0;
  let length = 0;
  const newline = () => `\n${"  ".repeat(Math.min(depth, 40))}`;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    let part = token;
    if (token === "{" || token === "[") {
      depth++;
      if (tokens[index + 1] !== "}" && tokens[index + 1] !== "]") part += newline();
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[index - 1] !== "{" && tokens[index - 1] !== "[") part = newline() + token;
    } else if (token === ",") {
      part += newline();
    } else if (token === ":") {
      part += " ";
    }
    length += part.length;
    // Keep highly nested/large documents from expanding without a bound.
    if (length > 4 * 1024 * 1024) return { text: content };
    parts.push(part);
    highlighted?.push({
      text: part,
      kind: token.startsWith('"')
        ? tokens[index + 1] === ":" ? "key" : "string"
        : /^(?:true|false|null)$/.test(token) ? "literal"
        : /^-?\d/.test(token) ? "number" : "punctuation",
    });
  }
  return { text: parts.join(""), tokens: highlighted };
}
