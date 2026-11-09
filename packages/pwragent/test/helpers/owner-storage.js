import path from "node:path";
import { mkdirSync } from "node:fs";
import { openOutpostProfileRuntime } from "../../dist/federation-core.js";

export function ownerStorage(t, root, workspace = root) {
  const directory = path.join(root, "headless");
  mkdirSync(directory, { mode: 0o700 });
  const identity = { version: 1, workspace, codexHome: path.join(root, "codex-home") };
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: workspace });
  t.after(() => profile.close());
  const storage = profile.openOwnerStorage(directory, identity);
  return { directory, profile, identity, storage, threadRegistry: storage.threads, inventory: storage.inventory };
}
