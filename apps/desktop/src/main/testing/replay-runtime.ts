import fs from "node:fs";
import type { AppServerPendingRequestNotification } from "@pwragnt/shared";
import { ReplayClient } from "./replay-client";
import type { ReplayFixture, ReplayStepOverride } from "./replay-fixture";
import { validateReplayFixture } from "./replay-fixture";

const REPLAY_FIXTURE_PATH_ENV = "PWRAGNT_REPLAY_FIXTURE_PATH";

type ReplayDriver = {
  advance(params?: { stepId?: string; override?: ReplayStepOverride }): Promise<void>;
  getPendingRequest(): AppServerPendingRequestNotification | undefined;
  respondToPendingRequest(requestId: string): Promise<void>;
};

declare global {
  // eslint-disable-next-line no-var
  var __PWRAGNT_REPLAY_DRIVER__: ReplayDriver | undefined;
}

export function createReplayClientsFromEnv():
  | {
      defaultClient: ReplayClient;
      fullAccessClient: ReplayClient;
    }
  | undefined {
  const fixturePath = process.env[REPLAY_FIXTURE_PATH_ENV]?.trim();
  if (!fixturePath) {
    return undefined;
  }

  const fixture = loadReplayFixture(fixturePath);
  const defaultClient = ReplayClient.fromFixture(fixture);
  const fullAccessClient = ReplayClient.fromFixture(fixture);

  globalThis.__PWRAGNT_REPLAY_DRIVER__ = {
    advance: async (params) => {
      await defaultClient.advance(params);
    },
    getPendingRequest: () => defaultClient.getPendingRequest(),
    respondToPendingRequest: async (requestId) => {
      await defaultClient.respondToPendingRequest(requestId);
    }
  };

  return {
    defaultClient,
    fullAccessClient
  };
}

function loadReplayFixture(filePath: string): ReplayFixture {
  const contents = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(contents) as ReplayFixture;
  validateReplayFixture(parsed);
  return parsed;
}
