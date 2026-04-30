import type {
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
} from "@pwragnt/shared";

export type MessagingInteractionMapperResult =
  | {
      kind: "matched";
      action: MessagingSurfaceAction;
    }
  | {
      kind: "pass_through";
      text: string;
    }
  | {
      kind: "ambiguous";
      text: string;
    };

export type MessagingInteractionMapper = {
  mapText(params: {
    intent: MessagingSurfaceIntent;
    text: string;
  }): Promise<MessagingInteractionMapperResult> | MessagingInteractionMapperResult;
};
