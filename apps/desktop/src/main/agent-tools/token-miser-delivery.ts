import { agentToolFailure, agentToolSuccess } from "./agent-tool-definition";
import type { TokenMiserStore } from "../token-miser/token-miser-store";

export async function retrievalSuccess(params: {
  store: TokenMiserStore;
  context: { threadId: string };
  objectId: string;
  maxResponseCharacters?: number;
  structuredContent: Record<string, unknown>;
  visibleText: string;
  kind?: "summary" | "source";
}) {
  let visibleText = params.visibleText;
  while (true) {
    const delivery = await params.store.prepareRetrievalDelivery({
      objectId: params.objectId,
      threadId: params.context.threadId,
      visibleText,
      kind: params.kind,
    });
    if (!delivery) {
      return agentToolFailure({ code: "not_found", message: "Preserved output expired or unavailable for this thread." });
    }
    const payload = {
      content: [{ type: "text", text: delivery.text }],
      structuredContent: params.structuredContent,
    };
    if (
      !params.maxResponseCharacters
      || delivery.text.length <= params.maxResponseCharacters
    ) {
      return agentToolSuccess(payload, {
        contentItems: [{ type: "inputText", text: delivery.text }],
        mcpContentItems: [{ type: "text", text: delivery.text }],
      });
    }
    params.store.abandonRetrievalDelivery(delivery.deliveryId);
    const nextLength = Math.max(
      0,
      visibleText.length
      - (delivery.text.length - params.maxResponseCharacters)
      - 64,
    );
    if (nextLength >= visibleText.length) {
      return agentToolFailure({
        code: "output_budget_exceeded",
        message: "The bounded Token Miser retrieval could not fit its response budget.",
      });
    }
    visibleText = `${visibleText.slice(0, nextLength)}\n… retrieval truncated`;
  }
}
