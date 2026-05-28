import type { AppServerBackendKind, BackendSummary } from "@pwragent/shared";

/**
 * Resolve the user-visible chip / dropdown label for a backend kind.
 *
 * **Two-tier resolution.** The function has two label sources:
 *
 *   1. **Hardcoded short-circuits** (this function's top branches) — the
 *      canonical names for backends we ship first-party support for.
 *      Used by *every* render site regardless of whether `summaries` is
 *      supplied.
 *   2. **`summaries[].label` lookup** — the installed-agent's
 *      registered display name, fed in by the composer's provider
 *      dropdown. Useful when callers want the freshest server-supplied
 *      label (e.g. a future ACP agent whose registry record names it
 *      differently than its `acp:<id>` URI suggests).
 *
 * Many chip render sites (`ThreadHeader.tsx`, `ThreadMetaChips.tsx`)
 * call this WITHOUT the `summaries` array — so any backend that lives
 * only in tier (2) ends up rendered as its bare registry id (e.g.
 * "grok" lowercase). When adding a new built-in ACP backend, add an
 * explicit hardcoded branch here alongside Gemini / Kimi / Grok so the
 * chip reads the same everywhere.
 */
export function formatBackendLabel(
  backend: AppServerBackendKind,
  summaries: BackendSummary[] = [],
): string {
  if (backend === "acp:gemini") {
    return "Gemini";
  }
  if (backend === "acp:kimi") {
    return "Kimi";
  }
  // The "Grok" chip is reserved for the Grok CLI ACP backend. The
  // legacy direct-xAI agent-core backend is rendered as
  // "AgentCore - Grok" in its own branch below — see
  // `feat(desktop): add Grok CLI ACP backend` (PR #579) and
  // backend-registry.ts:disabledAgentCoreGrokSummary for the
  // experimental-flag policy.
  if (backend === "acp:grok") {
    return "Grok";
  }
  const summary = summaries.find((candidate) => candidate.kind === backend);
  if (summary?.label) {
    return summary.label;
  }
  if (backend === "codex") {
    return "OpenAI";
  }
  if (backend === "grok") {
    return "AgentCore - Grok";
  }
  if (backend.startsWith("acp:")) {
    const registryId = backend.slice("acp:".length);
    return registryId;
  }
  return backend;
}
