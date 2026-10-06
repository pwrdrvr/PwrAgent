import { useMemo } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import { TranscriptCopyButton } from "./TranscriptCopyButton";

export function isJsonFilePath(path: string): boolean {
  return /\.json$/i.test(path);
}

export function JsonFilePreview(props: {
  content: string;
  desktopApi?: Pick<DesktopApi, "copyText">;
}) {
  const preview = useMemo(() => formatJsonPreview(props.content), [props.content]);
  return (
    <div className="json-file-preview">
      <div className="json-file-preview__toolbar">
        {preview.error ? (
          <p className="json-file-preview__error" role="status">
            Invalid JSON. Showing the original file.
          </p>
        ) : null}
        <TranscriptCopyButton
          desktopApi={props.desktopApi}
          label="Copy JSON"
          copiedLabel="Copied JSON"
          text={props.content}
        />
      </div>
      <pre className="json-file-preview__code" aria-label="JSON contents" tabIndex={0}>
        <code>{preview.text}</code>
      </pre>
    </div>
  );
}

function formatJsonPreview(content: string): { text: string; error?: boolean } {
  // Validate without serializing the parsed value: large integers, duplicate
  // keys and the original number/string spellings must survive the preview.
  try {
    JSON.parse(content);
  } catch {
    return { text: content, error: true };
  }

  const tokens = content.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  const parts: string[] = [];
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
  }
  return { text: parts.join("") };
}
