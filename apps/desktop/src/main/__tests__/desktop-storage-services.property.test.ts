import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { OwnerThreadRegistry } from "@pwragent/owner-core/thread-storage";
import type { ModelSettingsRecentsScope } from "@pwragent/shared";
import type { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { listModelSettingsRecents as storedModels, recordModelSettingsRecent as storeModel } from "../state/model-settings-recents-store";
import { listRecentFileReferencePaths as storedFiles, recordRecentFileReferencePaths as storeFiles } from "../state/recent-file-references-store";
import { listModelSettingsRecents, recordModelSettingsRecent, listRecentFileReferencePaths, recordRecentFileReferencePaths } from "../storage/desktop-recents-service";
import { desktopFederationState } from "../storage/desktop-federation-storage";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined, overlay: undefined as SqliteOverlayStore | undefined }));
vi.mock("../state/app-state", () => ({
  getAppStateDb: () => active.db!,
  getAppOverlayStore: () => active.overlay!,
}));

const scope = fc.constantFrom<ModelSettingsRecentsScope>("review", "composer", "todo-dispatch");
const fields = [
  ["instanceId", "federation_instance_id"],
  ["gatewayInstanceId", "federation_gateway_instance_id"],
  ["gatewayPublicKey", "federation_gateway_public_key_pem"],
  ["gatewayNoisePublicKey", "federation_gateway_noise_public_key"],
  ["gatewayLastEndpoint", "federation_gateway_last_endpoint"],
  ["pendingInviteToken", "federation_pending_invite_token"],
  ["gatewayEnrolledAt", "federation_gateway_enrolled_at"],
  ["celestialIconAssignments", "federation_celestial_icon_assignments"],
  ["shortNames", "federation_instance_short_names"],
  ["profileName", "profile_name"],
] as const;
const operation = fc.oneof(
  fc.record({ kind: fc.constant("files" as const), paths: fc.array(fc.string({ maxLength: 20 }), { maxLength: 24 }) }),
  fc.record({ kind: fc.constant("model" as const), scope, model: fc.string({ maxLength: 20 }), fastMode: fc.boolean() }),
  fc.record({ kind: fc.constant("federation" as const), field: fc.constantFrom(...fields), value: fc.string({ maxLength: 20 }) }),
  fc.record({ kind: fc.constant("owner" as const), threadId: fc.constantFrom("one", "two"), title: fc.string({ maxLength: 20 }) }),
);

describe("desktop storage service oracle", () => {
  it("preserves stored results and write counts through the owner and application ports", async () => {
    // The original stores are the oracle. Generated interleavings must leave
    // their durable data and total row changes identical after every operation.
    await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 35 }), async (operations) => {
      const db = openInMemoryStateDb();
      const oracle = openInMemoryStateDb();
      active.db = db;
      active.overlay = new SqliteOverlayStore(db);
      const owner: OwnerThreadRegistry = getDesktopOverlayStore();
      const oracleOwner: OwnerThreadRegistry = new SqliteOverlayStore(oracle);
      try {
        for (const op of operations) {
          if (op.kind === "files") {
            recordRecentFileReferencePaths(op.paths);
            storeFiles(oracle, op.paths);
            expect(listRecentFileReferencePaths()).toEqual(storedFiles(oracle));
          } else if (op.kind === "model") {
            const recent = { backend: "codex" as const, model: op.model, fastMode: op.fastMode };
            recordModelSettingsRecent(op.scope, recent);
            storeModel(oracle, op.scope, recent);
            expect(listModelSettingsRecents(op.scope)).toEqual(storedModels(oracle, op.scope));
          } else if (op.kind === "federation") {
            desktopFederationState.write(op.field[0], op.value);
            oracle.setMeta(op.field[1], op.value);
            expect(desktopFederationState.read(op.field[0])).toEqual(oracle.getMeta(op.field[1]));
          } else {
            const identity = { backend: "codex" as const, threadId: op.threadId };
            const patch = { title: { text: op.title, source: "explicit" as const } };
            expect(await owner.updateThreadMetadata(identity, patch)).toEqual(await oracleOwner.updateThreadMetadata(identity, patch));
            expect(await owner.getThreadMetadata(identity)).toEqual(await oracleOwner.getThreadMetadata(identity));
          }
          expect(db.raw.prepare("SELECT total_changes() AS n").get())
            .toEqual(oracle.raw.prepare("SELECT total_changes() AS n").get());
        }
      } finally {
        active.db = undefined;
        active.overlay = undefined;
        db.close();
        oracle.close();
      }
    }), { numRuns: 25 });
  });

  it("resolves the current profile at each application-service call", () => {
    const first = openInMemoryStateDb();
    const second = openInMemoryStateDb();
    try {
      active.db = first;
      desktopFederationState.write("instanceId", "first");
      recordRecentFileReferencePaths(["first.txt"]);
      active.db = second;
      expect(desktopFederationState.read("instanceId")).toBeUndefined();
      expect(listRecentFileReferencePaths()).toEqual([]);
      desktopFederationState.write("instanceId", "second");
      expect(first.getMeta("federation_instance_id")).toBe("first");
    } finally {
      active.db = undefined;
      first.close();
      second.close();
    }
  });
});
