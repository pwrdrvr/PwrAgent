import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

/** Own the generated bundle before any desktop-main test worker imports it. */
export default async function setup(): Promise<void> {
  await promisify(execFile)(process.execPath, [path.join(process.cwd(), "packages/pwragent/scripts/build.mjs")], {
    cwd: process.cwd(),
  });
}
