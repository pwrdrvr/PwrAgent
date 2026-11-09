import { StateDb } from "@pwragent/sqlite-storage/state-db";
import type { ThreadSandboxStorage } from "@pwragent/owner-core/mcp-connection-storage";
import { createThreadSandboxStorage } from "../../src/main/storage/desktop-runtime-storage";
import { recordCreatedSandbox } from "../../src/main/storage/desktop-mcp-connection-storage";
import { SandboxerPrCleanupService } from "../../src/main/mcp-connections/sandboxer-pr-cleanup";
import { selectResourceProfile } from "./thread-resource-profile";

let db: StateDb | undefined;
let store: ThreadSandboxStorage | undefined;

// Actual desktop factory, gateway persistence and cleanup service run in
// Electron. The transport is invented and cannot reach a real MCP connection.
export async function exerciseResourceFactories(dbPath: string, phase: "first" | "later" | "close") {
  if (phase === "close") {
    db?.close(); db = undefined; store = undefined; selectResourceProfile(undefined);
    return { before: [], after: [], calls: [] };
  }
  if (!db) {
    db = StateDb.open(dbPath); selectResourceProfile(db);
    store = createThreadSandboxStorage();
  }
  selectResourceProfile(undefined); // retained cleanup port must remain usable
  const before = store!.all();
  const calls: { name: string; sandboxId: unknown }[] = [];
  const cleanup = new SandboxerPrCleanupService({ store: store!, isEnabled: () => true, now: () => phase === "first" ? 200 : 400,
    openTransport: async () => ({ listToolNames: async () => [phase === "first" ? "stop_sandbox" : "delete_sandbox"],
      callTool: async (name, args) => { calls.push({ name, sandboxId: args.sandboxId }); return { content: [{ type: "text", text: "Invented success" }] }; },
      close: () => {},
    }),
  });
  if (phase === "first") {
    // The real event-time guard must avoid resolving an absent profile.
    recordCreatedSandbox({ connectionId: "invented", sandboxId: "guarded", threadId: "thread", now: 100 });
    selectResourceProfile(db);
    recordCreatedSandbox({ connectionId: "invented", sandboxId: "electron", backend: "codex", threadId: "thread", name: "Invented Electron resource", now: 300 });
    recordCreatedSandbox({ connectionId: "invented", sandboxId: "portable", backend: "claude", threadId: "other", now: 999 });
    selectResourceProfile(undefined);
  }
  const report = await cleanup.cleanupThread({ backend: "codex", threadId: "thread", createdBefore: phase === "first" ? 100 : 400 });
  return { before, after: store!.all(), calls, report };
}
