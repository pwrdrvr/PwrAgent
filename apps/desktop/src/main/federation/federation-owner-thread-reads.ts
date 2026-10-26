import type {
  AppServerBackendKind,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  AppServerThreadMessage,
  AppServerThreadReplay,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { getMainLogger } from "../log";
import { findAssistantMessageForText } from "../messaging/find-assistant-reply-message";
import { materializeTranscriptImageUrlsForRenderer } from "../transcript-image-protocol";
import type {
  FederationReadTurnAssistantReplyRequest,
  FederationReadTurnAssistantReplyResponse,
} from "./federation-backend-bridge";

const log = getMainLogger("pwragent:federation-owner-thread-reads");

/** The registry reads an owner answers a peer's transcript requests with. */
export type FederationOwnerThreadReadRegistry = Pick<
  DesktopBackendRegistry,
  "getThreadTranscriptImageRoots" | "readThread" | "readThreadTurnReplay"
>;

/**
 * Owner-local images in a peer's read become `pwragent-image://` URLs this
 * owner serves through `backend.readTranscriptImage`. Markdown-linked files
 * live on this machine's disk, so only the owner can materialize them.
 */
export async function materializeTranscriptImagesForPeer(
  registry: FederationOwnerThreadReadRegistry,
  thread: { backend: AppServerBackendKind; threadId: string },
  response: AppServerReadThreadResponse,
): Promise<AppServerReadThreadResponse> {
  return await materializeTranscriptImageUrlsForRenderer(response, {}, {
    includeTemporaryImageRoots: true,
    resolveApprovedLocalImageRoots: () => registry.getThreadTranscriptImageRoots({
      backend: thread.backend,
      threadId: thread.threadId,
    }),
  });
}

/** A peer's `backend.readThread`, answered from this owner's registry. */
export async function readThreadForPeer(
  registry: FederationOwnerThreadReadRegistry,
  request: AppServerReadThreadRequest,
): Promise<AppServerReadThreadResponse> {
  const backend = request.backend ?? "codex";
  const response = await registry.readThread({
    backend,
    display: request.display,
    threadId: request.threadId,
    ...(request.includeTurns !== undefined
      ? { includeTurns: request.includeTurns }
      : {}),
    ...(request.includeAllToolInvocations !== undefined
      ? { includeAllToolInvocations: request.includeAllToolInvocations }
      : {}),
    before: request.before,
    limit: request.limit,
    ...(request.viewOnly !== undefined
      ? { viewOnly: request.viewOnly }
      : {}),
  });
  return await materializeTranscriptImagesForPeer(
    registry,
    { backend, threadId: request.threadId },
    response,
  );
}

/**
 * A peer's `backend.readTurnAssistantReply`: the reply one finished turn
 * wrote, from that turn alone. A messaging gateway asked for a 20-turn page
 * at every bound turn end to find this one message. One turn's replay carries
 * the parts a page would, including the turn's tool screenshots.
 */
export async function readTurnAssistantReplyForPeer(
  registry: FederationOwnerThreadReadRegistry,
  request: FederationReadTurnAssistantReplyRequest,
): Promise<FederationReadTurnAssistantReplyResponse> {
  // Only Codex reads a single turn. Another backend's reply, or one whose
  // turn read failed, is found in the last page, as the gateway's transcript
  // read found it, but only the message crosses the wire.
  let replay: AppServerThreadReplay | undefined;
  try {
    replay = await registry.readThreadTurnReplay({
      backend: request.backend,
      threadId: request.threadId,
      turnId: request.turnId,
    });
  } catch (error) {
    log.warn("peer reply turn read failed; reading the last page", {
      backend: request.backend,
      error: error instanceof Error ? error.message : String(error),
      threadId: request.threadId,
      turnId: request.turnId,
    });
  }
  replay ??= (await registry.readThread({
    backend: request.backend,
    includeAccounting: false,
    limit: 20,
    threadId: request.threadId,
    viewOnly: true,
  })).replay;
  // The text only picks among this turn's own messages. Materializing the
  // peer's text instead would let it name files on this machine.
  const found = findAssistantMessageForText(
    replay,
    request.text,
    request.itemId,
    request.turnId,
  );
  if (!found) {
    return { message: null };
  }
  const message: AppServerThreadMessage = {
    id: found.id,
    role: found.role,
    text: found.text,
    ...(found.parts ? { parts: found.parts } : {}),
  };
  const materialized = await materializeTranscriptImagesForPeer(
    registry,
    { backend: request.backend, threadId: request.threadId },
    {
      backend: request.backend,
      fetchedAt: Date.now(),
      threadId: request.threadId,
      replay: {
        entries: [],
        messages: [message],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      },
    },
  );
  return { message: materialized.replay.messages[0] ?? null };
}
