import type { AppServerSkillSummary } from "@pwragent/shared";
import { decodeMarkdownDestination } from "../../lib/directory-references";
import { expandTildePath } from "../../lib/tildify-path";
import { parseSkillMentionParts } from "../../lib/skill-mentions";
import { parsePullRequestUrl, resolveLivePullRequest, type PullRequestLinkContextValue } from "../../lib/pull-request-links";
import { resolveThreadHref, type ThreadLinkContextValue } from "../../lib/thread-links";
import type { ComposerSkillToken } from "./ComposerInputTypes";
import { createComposerDirectoryToken, createComposerPullRequestToken, createComposerSkillToken, createComposerThreadToken } from "./composer-mention-tokens";

export function hydrateComposerDraft(
  canonicalDraft: string,
  skills: AppServerSkillSummary[],
  threadLinks: ThreadLinkContextValue | undefined,
  pullRequestLinks: PullRequestLinkContextValue | undefined,
): {
  draft: string;
  skillTokens: ComposerSkillToken[];
} {
  let draft = "";
  const skillTokens: ComposerSkillToken[] = [];

  const hydrateSkillAndDirectoryParts = (text: string): void => {
    for (const part of parseSkillMentionParts(text)) {
      if (part.type === "text") {
        draft += part.text;
        continue;
      }

      if (part.type === "directory") {
        // Serialized paths are percent-encoded tilde form; the token
        // carries the decoded absolute path so send-time attach can use
        // it directly. File-reference chips serialize to the same
        // `[@label](~/path)` form, so restored Markdown starts as a
        // generic reference chip. The bounded main-process inspection
        // upgrades regular files to `kind: "file"` without ever scanning
        // free-form typed paths.
        skillTokens.push(
          createComposerDirectoryToken(
            {
              label: part.name,
              path: expandTildePath(decodeMarkdownDestination(part.path)),
            },
            draft.length,
          ),
        );
        continue;
      }

      const matchingSkill =
        skills.find((skill) => skill.path === part.path) ??
        skills.find((skill) => skill.name === part.name);
      skillTokens.push(
        createComposerSkillToken(
          matchingSkill ?? {
            name: part.name,
            path: part.path,
          },
          draft.length,
        ),
      );
    }
  };

  // Thread and PR labels may legitimately begin with `$` or `@`, so recognize
  // their destinations before passing surrounding Markdown through the skill
  // and directory parser. Unknown links remain literal Markdown.
  const referenceLinkPattern = /\[((?:\\.|[^\]\\\r\n])*)\]\((pwragent:\/\/thread\/[^)\s]+|https:\/\/[^)\s]+)\)/gi;
  let cursor = 0;
  for (const match of canonicalDraft.matchAll(referenceLinkPattern)) {
    const matchIndex = match.index ?? 0;
    hydrateSkillAndDirectoryParts(canonicalDraft.slice(cursor, matchIndex));
    const href = match[2] ?? "";
    const resolvedThread = resolveThreadHref(href, threadLinks);
    if (resolvedThread) {
      skillTokens.push(createComposerThreadToken(resolvedThread, draft.length));
    } else {
      const pullRequest = parsePullRequestUrl(href);
      if (pullRequest) {
        // The parsed summary knows the repo and the number and nothing else.
        // Upgrading it through the live store before minting the token is what
        // gives a restored draft the same colored chip the sidebar shows; an
        // unseen PR falls back to the parsed summary and stays gray.
        skillTokens.push(
          createComposerPullRequestToken(
            resolveLivePullRequest(pullRequest, pullRequestLinks),
            draft.length,
          ),
        );
      } else {
        draft += match[0];
      }
    }
    cursor = matchIndex + match[0].length;
  }
  hydrateSkillAndDirectoryParts(canonicalDraft.slice(cursor));

  return { draft, skillTokens };
}

