import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { onTestFinished } from "vitest";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../../../../../packages/pwragent/bin/pwragent.js", import.meta.url));

/** Exercise the CLI's JSON file and local socket against a fixture-owned command handler. */
export async function factoryCli<Result>(
  command: "factory-admission" | "factory-review",
  handle: (params: Record<string, unknown>) => Promise<Result>,
) {
  if (process.platform === "win32") return handle;

  const home = await mkdtemp("/tmp/pwr-factory-cli-");
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const state = path.join(home, "profiles", "fixture", "state", "headless");
  await mkdir(state, { recursive: true });
  const server = createServer((socket) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (!data.endsWith("\n")) return;
      const request = JSON.parse(data);
      if (request.version !== 1 || request.method !== command) {
        socket.end(JSON.stringify({ error: "Invalid Factory fixture request" }) + "\n");
        return;
      }
      void handle(request.params).then(
        (result) => socket.end(JSON.stringify({ result }) + "\n"),
        (error: Error) => socket.end(JSON.stringify({ error: error.message }) + "\n"),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path.join(state, "rpc.sock"), resolve);
  });
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const paramsFile = path.join(home, "request.json");
  return async (params: Record<string, unknown>) => {
    await writeFile(paramsFile, JSON.stringify(params));
    try {
      const { stdout } = await exec(process.execPath, [cli, command, "--params-file", paramsFile], {
        env: { ...process.env, PWRAGENT_HOME: home, PWRAGENT_PROFILE: "fixture" },
      });
      return JSON.parse(stdout) as Result;
    } catch (error) {
      if (error instanceof Error && "stderr" in error) throw new Error(String(error.stderr).trim(), { cause: error });
      throw error;
    }
  };
}
