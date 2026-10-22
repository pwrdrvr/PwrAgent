import type { Query } from "@anthropic-ai/claude-agent-sdk";

// Present in the installed SDK runtime (0.3.296), absent from Query's public
// types. The upstream Claude ACP adapter uses the same optional control API:
// https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/session-titles.ts
export type ClaudeTitleQuery = Query & {
  generateSessionTitle?: (description: string, options?: { persist?: boolean }) => Promise<string | null>;
};

export function normalizeClaudeTitle(text: string | undefined | null): string | undefined {
  return text?.slice(0, 4096).replace(/[\s\p{Cc}]+/gu, " ").trim().slice(0, 200) || undefined;
}

/** A native small-model request on the existing Claude account; no tools or helper session. */
export async function requestClaudeTitle(
  query: ClaudeTitleQuery, description: string, signal: AbortSignal, timeoutMs = 10_000,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (signal.aborted) return undefined;
    return await Promise.race([
      query.generateSessionTitle?.(description.slice(0, 1000), { persist: true }).then(normalizeClaudeTitle),
      new Promise<undefined>((resolve) => {
        onAbort = () => resolve(undefined);
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } catch { return undefined; }
  finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
