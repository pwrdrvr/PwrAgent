import type { CodexMcpAuthStatus } from "./contracts/agent";
import type { McpConnectionStatus } from "./contracts/mcp-connections";

/**
 * One wording for the Codex MCP sign-in enum, shared by every surface that
 * renders it: the Settings → Plugins → MCPs pane and the thread rail's MCP
 * inventory panel.
 *
 * Two rules the previous per-surface copies broke:
 *
 * - Each label names the **state the operator is in**, never the protocol
 *   mechanism. `oAuth` used to render as "OAuth", which answers a question
 *   nobody asked; it means Codex holds OAuth credentials, so it reads
 *   "Signed in".
 * - `unsupported` means the server authenticates nobody. It used to render as
 *   "No login", which scans as *not logged in* — the opposite of the truth,
 *   and the majority state on a typical profile.
 */
export type McpAuthStatusPresentation = {
  /** Chip text. */
  label: string;
  /** Longer sentence for a title/tooltip. */
  description: string;
  /**
   * Chip tone. `notLoggedIn` is the only state that needs the operator, so it
   * is the only one that earns a warning; the rest are healthy or neutral. A
   * failed *startup* is a separate axis and owns the danger tone.
   */
  tone: "ok" | "warn" | "neutral";
  /** Whether this state can start an interactive sign-in. */
  canSignIn: boolean;
};

const PRESENTATIONS: Record<CodexMcpAuthStatus, McpAuthStatusPresentation> = {
  oAuth: {
    label: "Signed in",
    description:
      "Signed in with OAuth. PwrAgent proves the credential when the server next starts.",
    tone: "ok",
    canSignIn: true,
  },
  bearerToken: {
    label: "Signed in · token",
    description:
      "A bearer token is configured for this server. It is a working credential, just not an interactive one.",
    tone: "ok",
    canSignIn: false,
  },
  notLoggedIn: {
    label: "Sign-in required",
    description: "This server needs an interactive sign-in before it can publish tools.",
    tone: "warn",
    canSignIn: true,
  },
  unsupported: {
    label: "No sign-in needed",
    description: "This server does not authenticate. Nothing to sign in to.",
    tone: "neutral",
    canSignIn: false,
  },
  unknown: {
    label: "Sign-in state unknown",
    description:
      "The running Codex build did not report a sign-in state for this server.",
    tone: "neutral",
    canSignIn: false,
  },
};

export function describeMcpAuthStatus(
  status: CodexMcpAuthStatus,
): McpAuthStatusPresentation {
  return PRESENTATIONS[status];
}

export function formatMcpAuthStatus(status: CodexMcpAuthStatus): string {
  return describeMcpAuthStatus(status).label;
}

/**
 * The same chip for a PwrAgent-managed connection.
 *
 * Settings → Plugins lists both kinds of server one above the other, and they
 * used to describe one state in two dialects: a Codex server with no
 * credentials read `Sign-in required` while a managed one in the same position
 * read `Not set up`, and a working one read `Signed in` in one list and
 * `Ready` in the other. A managed connection is always OAuth, so it maps onto
 * two of the Codex states and takes their label and tone verbatim.
 *
 * Only the description differs, because it names who holds the credential:
 * PwrAgent here, Codex there.
 */
export function describeMcpConnectionAuth(
  connection: Pick<McpConnectionStatus, "configured" | "state">,
): McpAuthStatusPresentation {
  const signedIn =
    connection.configured
    && connection.state !== "disconnected"
    && connection.state !== "reauthorization_required";
  if (signedIn) {
    return {
      ...PRESENTATIONS.oAuth,
      description:
        "PwrAgent holds OAuth credentials for this server, encrypted in this profile, and refreshes them itself.",
    };
  }
  return {
    ...PRESENTATIONS.notLoggedIn,
    description: connection.configured
      ? "The credentials PwrAgent holds stopped working. Authorize this connection again."
      : "PwrAgent holds no credentials for this server yet. Authorize it to sign in.",
  };
}
