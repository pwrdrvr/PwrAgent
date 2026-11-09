import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { openOutpostProfileRuntime } from "../../dist/federation-core.js";

export function ownerStorage(t, root, workspace = root, legacyThreads) {
  const directory = path.join(root, "headless");
  mkdirSync(directory, { mode: 0o700 });
  const identity = { version: 1, workspace, codexHome: path.join(root, "codex-home") };
  if (legacyThreads) {
    writeFileSync(path.join(directory, "identity.json"), JSON.stringify(identity));
    writeFileSync(path.join(directory, "threads.json"), JSON.stringify({ version: 1, threads: legacyThreads }));
  }
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: workspace });
  t.after(() => profile.close());
  const storage = profile.openOwnerStorage(directory, identity);
  return { directory, profile, identity, storage, threadRegistry: storage.threads, inventory: storage.inventory };
}
