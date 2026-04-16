import type { AppServerTurnInputItem, ThreadState } from "../app-server/protocol.js";

export type ProviderTurnParams = {
  thread: ThreadState;
  input: AppServerTurnInputItem[];
  previousResponseId?: string;
};

export type ProviderSteerParams = {
  thread: ThreadState;
  runId: string;
  input: AppServerTurnInputItem[];
};

export type ProviderTurnResult = {
  assistantText?: string;
  providerResponseId?: string;
};

export type ProviderActiveTurn = {
  result: Promise<ProviderTurnResult>;
  steer?: (params: ProviderSteerParams) => Promise<void>;
  interrupt?: () => Promise<void>;
};

export interface AppServerProvider {
  startTurn(params: ProviderTurnParams): Promise<ProviderActiveTurn> | ProviderActiveTurn;
}
