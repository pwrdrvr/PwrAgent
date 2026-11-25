import fc from "fast-check";
import { expect, it } from "vitest";
import { buildThreadMarkdownLink, parseThreadUrl } from "@pwragent/shared/contracts/thread-link";
import { ThreadLinkHoverStore, type ThreadLinkContextValue } from "../../../lib/thread-links";
import { hydrateComposerDraft } from "../composer-draft-hydration";
import { serializeDraftWithSkillTokens } from "../composer-mention-tokens";

// The owner supplies the display name; the link supplies its navigation identity.
function expectReference(
  backend: "codex" | "acp:antigravity",
  threadId: string,
  instanceId: string | undefined,
  messageId: string | undefined,
  copiedTitle: string,
): void {
  const thread = { backend, threadId, instanceId, title: "Owner title" };
  const links: ThreadLinkContextValue = {
    resolve: (ref) => ({ ...thread, messageId: ref.messageId }),
    openRemoteViewer: () => undefined,
    show: () => undefined,
    getSnapshot: (link) => link,
    subscribe: () => () => undefined,
    hoverTarget: new ThreadLinkHoverStore(),
  };
  const reference = { backend, threadId, instanceId, messageId, profile: undefined };
  const link = buildThreadMarkdownLink({ ...reference, title: copiedTitle });
  const draft = `See ${link} and keep \`\`${link}\`\` verbatim.`;
  const restored = hydrateComposerDraft(draft, [], links, undefined);
  expect(restored.draft).toBe(`See  and keep \`\`${link}\`\` verbatim.`);
  expect(restored.skillTokens).toHaveLength(1);
  expect(restored.skillTokens[0]).toMatchObject({ kind: "thread", index: 4, name: thread.title });
  expect(parseThreadUrl(restored.skillTokens[0]?.path ?? "")).toEqual(reference);
  expect(serializeDraftWithSkillTokens(restored.draft, restored.skillTokens))
    .toBe(draft.replace(link, buildThreadMarkdownLink({ ...reference, title: thread.title })));
}

it("restores the owner's name without losing a message anchor", () => {
  expectReference("codex", "example-thread", undefined, "message-1", "Old title");
});

it("round-trips pasted thread references by owner, backend and message", () => {
  fc.assert(fc.property(
    fc.constantFrom("codex", "acp:antigravity"),
    fc.uuid(),
    fc.option(fc.constant("peer-laptop"), { nil: undefined }),
    fc.option(fc.uuid(), { nil: undefined }),
    fc.constantFrom("Old title", "Fix [draft] crash", "Fix `foo` crash", "$Build", "@Review"),
    expectReference,
  ));
});
