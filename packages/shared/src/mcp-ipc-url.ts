/** HTTP over local IPC, using VS Code's fragment-as-request-target syntax. */
export type McpIpcEndpoint = {
  scheme: "unix" | "pipe";
  path: string;
  requestTarget: string;
  url: string;
};

export function isMcpIpcUrl(value: string): boolean {
  return /^(unix|pipe):/i.test(value.trim());
}

export function parseMcpIpcUrl(value: string): McpIpcEndpoint {
  // Parse the raw form before WHATWG URL can remove dot segments or encode
  // whitespace. Decoding exactly once keeps %252F distinct from %2F.
  const match = /^(unix|pipe):\/\/\/([^#?]*)(?:#(.*))?$/.exec(value);
  if (!match || /[\s\\\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Use unix:///absolute/path/server.sock#/mcp or pipe:///pipe/name#/mcp. Put the HTTP path and query after #.");
  }
  const scheme = match[1] as "unix" | "pipe";
  let path: string;
  try {
    if (/%(?:2f|5c)/i.test(match[2]!)) throw new Error("encoded separator");
    path = `/${decodeURIComponent(match[2]!)}`;
  } catch {
    throw new Error("The IPC endpoint has an invalid escape or encoded path separator.");
  }
  if (/[\\\u0000-\u001f\u007f]/.test(path)
    || path.split("/").some((part) => part === "." || part === "..")
    || path.includes("//") || path.endsWith("/")) {
    throw new Error("The IPC endpoint must be an absolute path without empty, dot or parent segments.");
  }
  if (scheme === "pipe" && !/^\/pipe\/[^/:?*"<>|]+$/.test(path)) {
    throw new Error("Use pipe:///pipe/name for a local Windows pipe. Remote pipe servers and nested pipe names are not supported.");
  }
  const requestTarget = match[3] ?? "/";
  if (!requestTarget.startsWith("/") || requestTarget.startsWith("//")
    || /[#\\\s\u0000-\u001f\u007f]/.test(requestTarget)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(requestTarget)
    || /%(?![0-9a-f]{2})/i.test(requestTarget)) {
    throw new Error("The IPC URL fragment must be an HTTP path, optionally followed by a query, such as #/mcp?mode=local.");
  }
  // Reject transformations (including encoded dot segments), preserving the
  // escaped HTTP path/query byte-for-byte instead of decoding the fragment.
  const httpPath = requestTarget.split("?", 1)[0]!;
  if (!/^\/[A-Za-z0-9\-._~!$&()*+,;=:@/?%]*$/.test(requestTarget)
    || requestTarget.endsWith("?")
    || httpPath.split("/").some((part) => [".", ".."].includes(part.replace(/%2e/gi, ".")))) {
    throw new Error("The IPC HTTP path must not contain dot segments or require URL normalization.");
  }
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return {
    scheme,
    path: scheme === "pipe" ? `\\\\.\\pipe\\${path.slice(6)}` : path,
    requestTarget,
    url: `${scheme}://${encodedPath}${match[3] === undefined ? "" : `#${requestTarget}`}`,
  };
}
