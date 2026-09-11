import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ProbeMcpConnectionResponse } from "@pwragent/shared";
import { MCP_CONNECTION_PROBE_TIMEOUT_MS } from "./mcp-connection-timeouts";

/**
 * Words that begin a stdio MCP server command rather than a URL.
 *
 * Most servers an operator has already run are launched this way, and the
 * managed gateway cannot host one: it holds OAuth credentials for a remote
 * endpoint. Recognizing the shape lets the screen say where that server
 * belongs instead of reporting an OAuth discovery failure for it.
 */
const STDIO_COMMAND_HEADS = new Set([
  "npx",
  "node",
  "bunx",
  "bun",
  "deno",
  "uv",
  "uvx",
  "python",
  "python3",
  "pipx",
  "docker",
  "cargo",
  "go",
  "sh",
  "bash",
  "cmd",
  "pwsh",
  "powershell",
]);

function looksLikeStdioCommand(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const head = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (STDIO_COMMAND_HEADS.has(head)) return true;
  // A bare path with arguments is a command line too: `./server --port 3000`.
  return /\s-{1,2}\w/.test(trimmed) && !/^https?:\/\//i.test(trimmed);
}

function parseProbeUrl(value: string): URL | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!url.hostname) return undefined;
  return url;
}

type InitializeProbe =
  | { kind: "mcp"; serverName?: string }
  | { kind: "oauth_challenge"; scheme?: string }
  | { kind: "not_mcp"; status: number }
  | { kind: "unreachable"; detail: string };

/**
 * Ask the endpoint to initialize an MCP session.
 *
 * This is the one question that separates "wrong URL" from "right URL, auth
 * PwrAgent cannot hold". A 401 means it is an MCP server behind auth; a
 * JSON-RPC result means it is an MCP server that wanted no auth at all; HTML
 * or a 404 means it is not one.
 */
async function probeInitialize(
  url: URL,
  fetchFn: FetchLike,
): Promise<InitializeProbe> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    MCP_CONNECTION_PROBE_TIMEOUT_MS,
  );
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "PwrAgent", version: "probe" },
        },
      }),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      const challenge = response.headers.get("www-authenticate") ?? undefined;
      return {
        kind: "oauth_challenge",
        scheme: challenge?.split(/[\s,]/, 1)[0]?.toLowerCase(),
      };
    }
    if (!response.ok) {
      return { kind: "not_mcp", status: response.status };
    }
    const text = await response.text();
    // A streamable-HTTP server answers as SSE, so the JSON-RPC envelope can
    // arrive inside a `data:` frame rather than as the whole body.
    const payload = text.includes('"jsonrpc"')
      ? text.slice(text.indexOf("{", text.indexOf('"jsonrpc"') - 64))
      : text;
    try {
      const parsed = JSON.parse(payload) as {
        jsonrpc?: unknown;
        result?: { serverInfo?: { name?: unknown } };
      };
      if (parsed.jsonrpc !== "2.0") {
        return { kind: "not_mcp", status: response.status };
      }
      const serverName = parsed.result?.serverInfo?.name;
      return {
        kind: "mcp",
        serverName: typeof serverName === "string" ? serverName : undefined,
      };
    } catch {
      return { kind: "not_mcp", status: response.status };
    }
  } catch (error) {
    return {
      kind: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide whether the gateway can hold this endpoint, without writing a record.
 *
 * OAuth discovery is the authoritative check, because it is exactly what
 * `authorize` will run. The initialize probe only exists to explain a
 * discovery failure in terms the operator can act on.
 */
export async function probeMcpConnectionUrl(
  serverUrl: string,
  fetchFn: FetchLike,
): Promise<ProbeMcpConnectionResponse> {
  if (looksLikeStdioCommand(serverUrl)) {
    return {
      ok: false,
      problem: "looks_like_stdio",
      message:
        "That looks like a command line, not a URL. Command-line (stdio) MCP servers are configured in the agent itself — PwrAgent's gateway holds credentials for remote servers.",
    };
  }
  const url = parseProbeUrl(serverUrl);
  if (!url) {
    return {
      ok: false,
      problem: "not_a_url",
      message: "Enter an https:// address for a remote MCP server.",
    };
  }

  try {
    await discoverOAuthServerInfo(url, { fetchFn });
    return { ok: true, serverUrl: url.href, authMode: "oauth" };
  } catch {
    // Discovery failing is not yet an answer: the initialize probe below
    // decides whether the address is wrong, unreachable, or simply
    // authenticated in a way the gateway cannot hold.
  }

  const initialize = await probeInitialize(url, fetchFn);
  if (initialize.kind === "unreachable") {
    return {
      ok: false,
      problem: "unreachable",
      message: `PwrAgent could not reach ${url.host}. Check the address and that the server is running.`,
    };
  }
  if (initialize.kind === "not_mcp") {
    return {
      ok: false,
      problem: "not_mcp",
      message: `${url.host} answered, but not as an MCP server. Check that the address includes the server's MCP path.`,
    };
  }
  if (initialize.kind === "oauth_challenge") {
    // It is protected, and it is not OAuth-discoverable: a bearer token or an
    // API key. Naming the scheme is the difference between a usable message
    // and "authorization failed".
    const scheme = initialize.scheme && initialize.scheme !== "bearer"
      ? initialize.scheme
      : "a token";
    return {
      ok: false,
      problem: "unsupported_auth",
      message: `${url.host} is an MCP server, but it authenticates with ${scheme} rather than OAuth. The managed gateway can only hold OAuth credentials — configure this one in the agent itself.`,
    };
  }
  return {
    ok: false,
    problem: "unsupported_auth",
    message: `${url.host} is an MCP server that needs no authorization, so there is nothing for the gateway to hold. Configure it in the agent itself.`,
  };
}
