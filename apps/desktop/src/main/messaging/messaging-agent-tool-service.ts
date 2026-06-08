import type {
  PwrAgentMessagingRequest,
  PwrAgentMessagingResponse,
} from "@pwragent/shared";

export type MessagingAgentToolService = {
  handlePwrAgentMessagingRequest(
    request: PwrAgentMessagingRequest,
  ): Promise<PwrAgentMessagingResponse>;
};
