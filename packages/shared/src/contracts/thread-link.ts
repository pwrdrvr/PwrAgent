import { isAppServerBackendKind } from "./navigation";
import {
  isFederationInstanceId,
  type FederationInstanceId,
} from "./federation";
import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "./normalized-app-server";

/**
 * PwrAgent's in-app link scheme.
 *
 * ```
 * pwragent://thread/<threadId>[?backend=<kind>][&instanceId=<id>][&messageId=<id>][&profile=<name>]
 * ```
 *
 * The scheme is NAVIGATION-ONLY and must stay that way. It never grows action
 * verbs (`.../send?text=`, `.../run`, `.../approve`). Links are rendered from
 * agent-authored markdown, which is attacker-influenceable — a README, a
 * fetched page, or a tool result can carry a prompt injection into a
 * transcript. A link that moves the operator to a thread they already own is
 * harmless; a link that acts on their behalf is a confused-deputy hole.
 *
 * Consequence: `pwragent:` is allowed through the transcript markdown URL
 * filter, but is deliberately NOT in the main process' `shell.openExternal`
 * allowlist. It is resolved in-app, never handed to the OS.
 *
 * Parsed by hand rather than via `URL`: this package compiles against
 * `lib: ["ES2023"]` with no DOM, and the fixed grammar sidesteps WHATWG's
 * looser handling of non-special schemes.
 */
export const PWRAGENT_URL_SCHEME = "pwragent:";

/** The only host the scheme currently defines. */
export const THREAD_LINK_HOST = "thread";

const THREAD_URL_PREFIX = `${PWRAGENT_URL_SCHEME}//${THREAD_LINK_HOST}/`;

export type ThreadLinkRef = {
  threadId: ThreadIdentifier;
  /**
   * Optional. Renderer surfaces resolve the backend from the navigation
   * snapshot when it is absent, so a bare `pwragent://thread/<id>` still
   * works. Emitters should include it — it makes the link self-describing.
   */
  backend?: AppServerBackendKind;
  /**
   * Optional owning federation instance. Remote emitters include it so the
   * renderer can open an arbitrary thread on the correct peer even when that
   * thread is not already present in the local navigation snapshot.
   */
  instanceId?: FederationInstanceId;
  /**
   * Optional transcript message to reveal after opening the thread. This is
   * still navigation-only: it identifies existing content and never causes an
   * action in the target thread.
   */
  messageId?: string;
  /**
   * Optional profile name. Only meaningful for links that travel outside the
   * app. A link naming a profile other than the running one reports the
   * mismatch rather than silently switching profiles.
   */
  profile?: string;
};

/**
 * Thread ids that may appear in a link. Deliberately narrow: no whitespace, no
 * URL-structural characters, bounded length. A well-formedness guard, not a
 * proof the thread exists — callers still resolve the id against real state.
 */
export function isThreadLinkId(value: string): boolean {
  if (value.length === 0 || value.length > 128) {
    return false;
  }

  return !/[\s/?#%\\]/.test(value);
}

export function buildThreadUrl(ref: ThreadLinkRef): string {
  const query: string[] = [];
  if (ref.backend) {
    query.push(`backend=${encodeQueryValue(ref.backend)}`);
  }
  if (ref.instanceId) {
    query.push(`instanceId=${encodeURIComponent(ref.instanceId)}`);
  }
  if (ref.messageId) {
    query.push(`messageId=${encodeURIComponent(ref.messageId)}`);
  }
  if (ref.profile) {
    query.push(`profile=${encodeURIComponent(ref.profile)}`);
  }

  const base = `${THREAD_URL_PREFIX}${encodeURIComponent(ref.threadId)}`;
  return query.length > 0 ? `${base}?${query.join("&")}` : base;
}

function encodeQueryValue(value: string): string {
  // Colons are valid inside query values and ACP backend ids use one as part
  // of their public identity (`acp:grok`). Keep it readable instead of
  // leaking `%3A` into copied PwrAgent thread links.
  return encodeURIComponent(value).replace(/%3A/giu, ":");
}

export function parseThreadUrl(value: string): ThreadLinkRef | undefined {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(THREAD_URL_PREFIX)) {
    return undefined;
  }

  // Fragments carry no meaning yet; drop rather than fold into the id.
  const withoutFragment = trimmed.slice(THREAD_URL_PREFIX.length).split("#")[0];
  const queryStart = withoutFragment.indexOf("?");
  const path =
    queryStart >= 0 ? withoutFragment.slice(0, queryStart) : withoutFragment;
  const query = queryStart >= 0 ? withoutFragment.slice(queryStart + 1) : "";

  // Exactly one segment. Reserved shapes such as `.../turn/<turnId>` are not
  // understood yet — reject them rather than silently dropping the extra
  // segments and navigating somewhere the link did not ask for.
  if (path.length === 0 || path.includes("/")) {
    return undefined;
  }

  const threadId = safeDecode(path);
  if (threadId === undefined || !isThreadLinkId(threadId)) {
    return undefined;
  }

  const params = parseQuery(query);
  const backend = params.get("backend");
  const instanceId = params.get("instanceId");
  const messageId = params.get("messageId");
  const profile = params.get("profile");

  return {
    threadId,
    backend: backend && isAppServerBackendKind(backend) ? backend : undefined,
    instanceId:
      instanceId && isFederationInstanceId(instanceId) ? instanceId : undefined,
    messageId: messageId && isThreadLinkId(messageId) ? messageId : undefined,
    profile: profile || undefined,
  };
}

export function isThreadUrl(value: string): boolean {
  return parseThreadUrl(value) !== undefined;
}

/**
 * The string agents are told to reproduce verbatim. Handing the model a
 * finished link is the whole point — asking it to assemble one from a
 * `threadId` field is what produced bare, unclickable uuids in transcripts.
 */
export function buildThreadMarkdownLink(
  ref: ThreadLinkRef & { title?: string },
): string {
  const text = escapeMarkdownLinkText(ref.title?.trim() || ref.threadId);
  return `[${text}](${buildThreadUrl(ref)})`;
}

function parseQuery(query: string): Map<string, string> {
  const params = new Map<string, string>();
  if (query.length === 0) {
    return params;
  }

  for (const pair of query.split("&")) {
    if (pair.length === 0) {
      continue;
    }
    const separator = pair.indexOf("=");
    const rawKey = separator >= 0 ? pair.slice(0, separator) : pair;
    const rawValue = separator >= 0 ? pair.slice(separator + 1) : "";
    const key = safeDecode(rawKey);
    const value = safeDecode(rawValue);
    if (key === undefined || value === undefined || params.has(key)) {
      continue;
    }
    params.set(key, value);
  }

  return params;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return undefined;
  }
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[\\[\]]/g, "\\$&").replace(/\s+/g, " ");
}
