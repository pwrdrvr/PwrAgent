import crossSpawn from "cross-spawn";
import path from "node:path";
import { pathToFileURL } from "node:url";

// This bridge already belongs to the native Job. Windows .cmd tool shims
// require a shell; that shell and every descendant inherit Job membership.
export async function runWindowsToolChild(encoded) {
  const { command, args } = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await runWindowsToolChild(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 127; }
}
