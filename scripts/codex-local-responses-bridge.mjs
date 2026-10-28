#!/usr/bin/env node
// Compatibility launcher for local Responses servers with flat function tools
// and chat templates requiring exactly one leading system message.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS, discoverModelCatalog, startBridge } from "../apps/desktop/src/main/codex-app-server/local-responses-bridge.mjs";
export { DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS, discoverModelCatalog, startBridge, translateRequest, translateResponse } from "../apps/desktop/src/main/codex-app-server/local-responses-bridge.mjs";

async function main(args) {
  const separator = args.indexOf("--");
  const options = args.slice(0, separator);
  const value = (flag) => options[options.indexOf(flag) + 1];
  if (separator < 0 || !["--codex", "--upstream", "--provider"].every((flag) => options.includes(flag))) {
    throw new Error("Usage: codex-local-responses-bridge.mjs --codex PATH --upstream http://127.0.0.1:PORT/v1 --provider NAME [--model-catalog TEMPLATE] [--stream-idle-timeout-ms MS] -- [Codex arguments]");
  }
  const provider = value("--provider");
  if (!/^[a-zA-Z0-9_-]+$/.test(provider)) throw new Error("Invalid provider name");
  // One value for both layers, so a long silent prefill outlasts each of them.
  // startBridge validates it before Codex starts.
  const idleTimeoutMs = options.includes("--stream-idle-timeout-ms")
    ? Number(value("--stream-idle-timeout-ms"))
    : DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS;
  const codexArgs = args.slice(separator + 1);
  const versionOnly = codexArgs.includes("--version") || codexArgs.includes("-V");
  let server;
  let catalogDirectory;
  let child;
  const forward = (signal) => child?.kill(signal);
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  try {
    const overrides = [];
    if (!versionOnly) {
      if (options.includes("--model-catalog")) {
        const template = JSON.parse(await readFile(value("--model-catalog"), "utf8"));
        const catalog = await discoverModelCatalog(value("--upstream"), template);
        catalogDirectory = await mkdtemp(path.join(tmpdir(), "pwragent-local-models-"));
        const catalogPath = path.join(catalogDirectory, "models.json");
        await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
        overrides.push("-c", `model_catalog_json=${JSON.stringify(catalogPath)}`);
      }
      server = await startBridge(value("--upstream"), undefined, { idleTimeoutMs });
      overrides.push(
        "-c", `model_providers.${provider}.base_url="http://127.0.0.1:${server.address().port}/v1"`,
        "-c", `model_providers.${provider}.stream_idle_timeout_ms=${idleTimeoutMs}`,
      );
    }
    child = spawn(value("--codex"), [...codexArgs, ...overrides], { stdio: "inherit" });
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const [code, signal] = await once(child, "exit");
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    server?.closeAllConnections();
    server?.close();
    if (catalogDirectory) await rm(catalogDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
