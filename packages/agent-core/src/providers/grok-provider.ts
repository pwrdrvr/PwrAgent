import type { AppServerProvider, ProviderActiveTurn, ProviderTurnParams } from "./provider-contract.js";
import { startResponsesToolLoop } from "./responses-tool-loop.js";
import { XaiResponsesClient, type XaiResponsesClientOptions } from "./xai-responses-client.js";

export type GrokProviderOptions = XaiResponsesClientOptions & {
  maxToolRounds?: number;
};

export class GrokProvider implements AppServerProvider {
  private readonly client: XaiResponsesClient;
  private readonly maxToolRounds?: number;

  constructor(options: GrokProviderOptions) {
    this.client = new XaiResponsesClient(options);
    this.maxToolRounds = options.maxToolRounds;
  }

  startTurn(params: ProviderTurnParams): ProviderActiveTurn {
    return startResponsesToolLoop({
      client: this.client,
      params,
      maxToolRounds: this.maxToolRounds,
    });
  }
}
