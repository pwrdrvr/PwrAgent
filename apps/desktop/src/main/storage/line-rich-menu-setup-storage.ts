import path from "node:path";
import { lock } from "proper-lockfile";
import type { MessagingProviderSetupStore } from "@pwragent/messaging-interface";
import {
  LineRichMenuSetupError,
  readLineRichMenuOwnership,
  validateLineUserId,
  type LineRichMenuOwnership,
} from "@pwragent/messaging-provider-line";
import { resolveActiveProfilePath } from "../profile";
import { getAppStateDb, getAppStateMode } from "../state/app-state";

/** This lock protects one LINE setup operation across app instances sharing the profile. */
export function createLineRichMenuSetupStorage(): MessagingProviderSetupStore<LineRichMenuOwnership> {
  if (getAppStateMode() !== "active-profile") throw new LineRichMenuSetupError("request-failed");
  const stateDb = getAppStateDb();
  const profileStateDir = resolveActiveProfilePath("state");
  return {
    async withAccount(accountId, run) {
      if (!validateLineUserId(accountId).ok) throw new LineRichMenuSetupError("request-failed");
      const file = path.join(profileStateDir, `line-rich-menu-${accountId}`);
      const key = `line_rich_menu:${accountId}`;
      let compromised = false;
      const release = await lock(file, {
        realpath: false,
        retries: 0,
        stale: 60_000,
        update: 10_000,
        onCompromised: () => { compromised = true; },
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ELOCKED") throw new LineRichMenuSetupError("busy");
        throw error;
      });
      try {
        const state = readLineRichMenuOwnership(stateDb.getMeta(key));
        const assertCurrent = () => {
          if (compromised || getAppStateDb() !== stateDb) throw new LineRichMenuSetupError("busy");
        };
        assertCurrent();
        return await run(state, async (next) => {
          assertCurrent();
          stateDb.setMeta(key, JSON.stringify(next));
        }, assertCurrent);
      } finally {
        await release().catch(() => undefined);
      }
    },
  };
}
