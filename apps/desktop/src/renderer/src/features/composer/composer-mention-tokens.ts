import type {
  AppServerSkillSummary,
  NavigationDirectorySummary,
  ThreadJumpCandidate,
  PrSummary,
} from "@pwragent/shared";
import {
  buildThreadMarkdownLink,
  buildThreadUrl,
  isRemoteFederationTarget,
  parseThreadUrl,
} from "@pwragent/shared";
import { buildDirectoryReferenceMarkdown } from "../../lib/directory-references";
import { formatHashReferenceThreadLabel } from "../../lib/hash-references";
import { buildSkillMentionMarkdown } from "../../lib/skill-mentions";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import {
  prChipModifierClasses,
  resolvePrChipPresentation,
} from "../pr-status/pr-chip-state";
import type { ComposerSkillToken } from "./ComposerInputTypes";

/**
 * Mention-token plumbing shared by every composer surface.
 *
 * These are the pure halves of the full composer's mention machinery:
 * minting a token for each chip kind, keeping token offsets aligned as the
 * plain draft changes around them, and splicing the tokens back into
 * markdown for the outgoing text. `Composer.tsx` owned all of it while it
 * was the only surface with mentions; the star map's `CompactComposer` is
 * the second, and duplicating any of this would let the two surfaces
 * serialize the same chip differently.
 *
 * Everything here is a pure function over a draft and its tokens. The
 * stateful parts — which popover is open, where the caret goes after an
 * insert — stay with the surface that owns the editor.
 */

export function createComposerSkillToken(
  skill: AppServerSkillSummary,
  index: number,
): ComposerSkillToken {
  return {
    ...skill,
    id: `${skill.path ?? skill.name}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    index,
  };
}

export function createComposerDirectoryToken(
  directory: Pick<NavigationDirectorySummary, "label" | "path">,
  index: number,
): ComposerSkillToken {
  return {
    kind: "directory",
    name: directory.label,
    path: directory.path,
    id: `${directory.path ?? directory.label}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    index,
  };
}

// Exported for the `@`-popover / picker surfaces that mint file-reference
// chips; the drop/paste tray uses the pill list instead of chips.
export function createComposerFileToken(
  file: { label: string; path: string },
  index: number,
): ComposerSkillToken {
  return {
    kind: "file",
    name: file.label,
    path: file.path,
    id: `${file.path}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    index,
  };
}

export function createComposerThreadToken(
  thread: ResolvedThreadLink,
  index: number,
): ComposerSkillToken {
  const path = buildThreadUrl({
    backend: thread.backend,
    ...(thread.instanceId ? { instanceId: thread.instanceId } : {}),
    threadId: thread.threadId,
  });
  return {
    kind: "thread",
    // Every thread chip is minted here — picker, pasted url, and the draft
    // rehydrate that rebuilds tokens from the live thread summary rather
    // than from the saved link text. Formatting at the choke point is what
    // makes the clamp survive a restore, and it makes the round trip
    // converge: `format` of an already-formatted title is itself.
    name: formatHashReferenceThreadLabel({
      id: thread.threadId,
      title: thread.title,
    }),
    path,
    id: `${path}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    index,
  };
}

export function createComposerPullRequestToken(
  pullRequest: PrSummary,
  index: number,
): ComposerSkillToken {
  return {
    kind: "pull-request",
    name: `#${pullRequest.number}`,
    path: pullRequest.url,
    description: pullRequest.title,
    shortDescription: `${pullRequest.org}/${pullRequest.repo}`,
    id: `${pullRequest.url}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    index,
    // Every PR chip in the composer is minted here — picker, pasted URL, and
    // draft rehydration — so this is the one place the chip's status can be
    // read off the summary. A summary that carries no status at all resolves
    // to the same "unknown" gray the chip renders without it, so a PR nothing
    // has observed is not dressed up as a state we know.
    prChipModifiers: prChipModifierClasses(
      resolvePrChipPresentation(pullRequest),
    ),
  };
}

export function resolveThreadSummaryReference(
  thread: ThreadJumpCandidate,
): ResolvedThreadLink {
  const federationTarget = thread.federation?.ref.target;
  return {
    backend: thread.source,
    ...(federationTarget && isRemoteFederationTarget(federationTarget)
      ? { instanceId: federationTarget.instanceId }
      : {}),
    threadId: thread.id,
    title: thread.title,
    titleSource: thread.titleSource,
    gitBranch: thread.gitBranch,
    linkedDirectories: thread.linkedDirectories,
  };
}

export function getComposerSkillTokensSignature(skillTokens: ComposerSkillToken[]): string {
  return JSON.stringify(
    skillTokens.map((token) => ({
      id: token.id,
      index: token.index,
      kind: token.kind,
      name: token.name,
      path: token.path,
    })),
  );
}

export function clampSkillTokenIndex(index: number, draft: string): number {
  return Math.max(0, Math.min(index, draft.length));
}

export function serializeDraftWithSkillTokens(
  draft: string,
  skillTokens: ComposerSkillToken[],
): string {
  if (skillTokens.length === 0) {
    return draft;
  }

  const sortedTokens = [...skillTokens].sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index;
    }
    return left.id.localeCompare(right.id);
  });

  let output = "";
  let cursor = 0;
  for (const token of sortedTokens) {
    const index = clampSkillTokenIndex(token.index, draft);
    output += draft.slice(cursor, index);
    // Directory- and file-reference chips serialize to `[@label](~/path)`
    // markdown — the parens bound the path so adjacent text can't glue
    // onto it, the transcript renders it back as a chip, and
    // hydrateComposerDraft rebuilds the token from a prompt-only restore.
    // Skills keep their `[$name](path)` markdown.
    if (token.kind === "directory" || token.kind === "file") {
      output += buildDirectoryReferenceMarkdown({
        label: token.name,
        path: token.path ?? "",
      });
    } else if (token.kind === "thread") {
      const ref = parseThreadUrl(token.path ?? "");
      output += ref
        ? buildThreadMarkdownLink({ ...ref, title: token.name })
        : token.path ?? token.name;
    } else if (token.kind === "pull-request") {
      output += token.path
        ? `[${token.name}](${token.path})`
        : token.name;
    } else {
      output += buildSkillMentionMarkdown(token);
    }
    cursor = index;
  }

  output += draft.slice(cursor);
  return output;
}

export function adjustSkillTokenIndexesForTextChange(params: {
  currentDraft: string;
  nextDraft: string;
  skillTokens: ComposerSkillToken[];
}): ComposerSkillToken[] {
  const { currentDraft, nextDraft, skillTokens } = params;
  if (currentDraft === nextDraft || skillTokens.length === 0) {
    return skillTokens;
  }

  let prefixLength = 0;
  while (
    prefixLength < currentDraft.length &&
    prefixLength < nextDraft.length &&
    currentDraft[prefixLength] === nextDraft[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < currentDraft.length - prefixLength &&
    suffixLength < nextDraft.length - prefixLength &&
    currentDraft[currentDraft.length - 1 - suffixLength] ===
      nextDraft[nextDraft.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const currentChangedEnd = currentDraft.length - suffixLength;
  const nextChangedEnd = nextDraft.length - suffixLength;
  const delta = nextChangedEnd - currentChangedEnd;

  return skillTokens.map((token) => {
    if (token.index <= prefixLength) {
      return token;
    }

    if (token.index >= currentChangedEnd) {
      return {
        ...token,
        index: clampSkillTokenIndex(token.index + delta, nextDraft),
      };
    }

    return {
      ...token,
      index: clampSkillTokenIndex(prefixLength, nextDraft),
    };
  });
}

export function rankSkillAutocompleteMatch(
  skill: AppServerSkillSummary,
  normalizedQuery: string,
): number | undefined {
  if (!normalizedQuery) {
    return 0;
  }

  const name = skill.name.toLowerCase();
  const shortDescription = skill.shortDescription?.toLowerCase() ?? "";
  const description = skill.description?.toLowerCase() ?? "";

  if (name === normalizedQuery) {
    return 0;
  }
  if (name.startsWith(`${normalizedQuery}:`)) {
    return 1;
  }
  if (name.startsWith(normalizedQuery)) {
    return 2;
  }
  if (name.includes(normalizedQuery)) {
    return 3;
  }
  if (shortDescription.includes(normalizedQuery)) {
    return 4;
  }
  if (description.includes(normalizedQuery)) {
    return 5;
  }

  return undefined;
}

/**
 * The `$` autocomplete's candidate list: skills that rank against the
 * query, best rank first, ties broken by the source order so the same
 * query always produces the same list.
 *
 * Skills without a `path` are skipped — a mention chip serializes to
 * `[$name](path)`, and there is nothing to point at without one.
 */
export function filterSkillAutocompleteCandidates(
  skills: readonly AppServerSkillSummary[],
  query: string,
): AppServerSkillSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  return skills
    .map((skill, index) => ({
      index,
      score: skill.path
        ? rankSkillAutocompleteMatch(skill, normalizedQuery)
        : undefined,
      skill,
    }))
    .filter(
      (
        match,
      ): match is { index: number; score: number; skill: AppServerSkillSummary } =>
        match.score !== undefined,
    )
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return left.index - right.index;
    })
    .map((match) => match.skill);
}
