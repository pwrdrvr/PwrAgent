import { buildHeadless } from "../../../apps/desktop/scripts/build-headless.mjs";
import { cp, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "dist"), { recursive: true });
await rm(path.join(root, "dist"), { recursive: true, force: true });
const result = await buildHeadless({ outputDirectory: path.join(root, "dist"), portable: true });
await mkdir(path.join(root, "native/mcp-ipc-relay"), { recursive: true });
await mkdir(path.join(root, "resources"), { recursive: true });
for (const file of ["stage-runtime.mjs", "build-mcp-ipc-relay.mjs"]) {
  await cp(new URL(`../../../apps/desktop/scripts/${file}`, import.meta.url), path.join(root, "scripts", file));
}
await cp(new URL("../../../apps/desktop/native/mcp-ipc-relay/", import.meta.url), path.join(root, "native/mcp-ipc-relay"), { recursive: true });
await cp(new URL("../../../apps/desktop/custom-git-runtime.json", import.meta.url), path.join(root, "resources/custom-git-runtime.json"));
await cp(new URL("../../../apps/desktop/resources/embedded-git/", import.meta.url), path.join(root, "resources/git-notices"), { recursive: true });
// Development builds also stage the current host. npm's files list deliberately
// omits these binaries; the same installer stages the destination's payload.
if (["linux", "darwin"].includes(process.platform)) await import("./install.mjs");

// This is the desktop owner dependency tree. Its checked-in notice and
// allowlist already cover every library bundled into these Node outputs.
for (const input of Object.keys(result.metafile.inputs)) {
  if (/node_modules\/electron\//.test(input)) throw new Error(`Electron in Node host: ${input}`);
}
await cp(new URL("../../../THIRD_PARTY_LICENSES", import.meta.url), path.join(root, "dist/THIRD_PARTY_LICENSES"));
