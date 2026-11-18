// Electron does not honor Node's --require preload option. Import the stubs
// before any application module can capture fetch or arm an update timer.
// Keep this entry in process.argv: profile helpers relaunch the same entry.
import "./github-release-stubs.cjs";
import { app } from "electron";
import { mkdirSync } from "node:fs";
import path from "node:path";

const chromiumRoot = process.env.PWRAGENT_E2E_CHROMIUM_ROOT;
if (!chromiumRoot) {
  throw new Error("The E2E bootstrap requires a fixture-owned Chromium root.");
}
// HOME/PWRAGENT_HOME isolate application state, but Chromium otherwise shares
// the real user's Local Storage/leveldb/LOCK. On Windows its native shutdown
// can block acquiring that lock after every application quit phase completes.
// Detached profile helpers inherit the root; each process owns its storage.
const userData = path.join(chromiumRoot, String(process.pid));
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
app.setPath("sessionData", userData);

// Set paths before the application can create its first Chromium session.
await import("../../out/main/index.js");
