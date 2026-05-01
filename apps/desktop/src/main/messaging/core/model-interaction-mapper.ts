import type {
  MessagingInteractionMapper,
  MessagingInteractionMapperResult,
} from "./interaction-mapper.js";

export type ModelInteractionMapperClient = {
  classify(params: {
    options: Array<{ id: string; label: string }>;
    prompt: string;
    text: string;
  }): Promise<{ actionId?: string; passThrough?: boolean }>;
};

export class ModelInteractionMapper implements MessagingInteractionMapper {
  constructor(private readonly client: ModelInteractionMapperClient | undefined) {}

  async mapText(): Promise<MessagingInteractionMapperResult> {
    return {
      kind: "ambiguous",
      text: "",
    };
  }
}
