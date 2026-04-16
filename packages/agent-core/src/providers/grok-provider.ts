import type { AppServerProvider, ProviderActiveTurn, ProviderTurnParams } from "./provider-contract.js";
import { normalizeXaiResponse } from "./response-normalizer.js";
import { buildXaiInput, XaiResponsesClient, type XaiResponsesClientOptions } from "./xai-responses-client.js";

export type GrokProviderOptions = XaiResponsesClientOptions;

export class GrokProvider implements AppServerProvider {
  private readonly client: XaiResponsesClient;

  constructor(options: GrokProviderOptions) {
    this.client = new XaiResponsesClient(options);
  }

  startTurn(params: ProviderTurnParams): ProviderActiveTurn {
    const result = this.client
      .createResponse({
        model: params.thread.model,
        input: buildXaiInput(params.input),
        previousResponseId: params.previousResponseId,
      })
      .then((response) => {
        const normalized = normalizeXaiResponse(response);
        return {
          assistantText: normalized.assistantText,
          providerResponseId: normalized.providerResponseId,
        };
      });

    return {
      result,
      steer: async () => {
        throw new Error("GrokProvider does not support steering active turns yet");
      },
      interrupt: async () => {
        return;
      },
    };
  }
}
