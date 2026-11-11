import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { call } from "./client.js";
import { serve } from "./daemon.js";
import { formatVersion, packageVersion } from "./version.js";

const commands = new Set(["status", "list", "show", "start-thread", "register-directory", "submit", "receipt", "pause", "resume", "move", "cancel", "release", "interrupt",
  "federation-status", "federation-join", "federation-invite", "federation-leave", "federation-revoke"]);
const help = `PwrAgent Outpost (Linux/macOS, Node 24+)

  pwragent serve --workspace /projects --codex-home /codex-home --codex-bin /path/to/codex
  pwragent status | list | --version
  pwragent COMMAND --params-file /request.json

Commands: ${[...commands].join(", ")}
Parameters use the desktop owner's contracts; see README.md.
Use --profile NAME or PWRAGENT_PROFILE (default: default).
State: $PWRAGENT_HOME/profiles/NAME/state (default root: ~/.pwragent).
serve runs in the foreground. Use systemd or a container to own its lifetime.
`;

export async function main(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: "boolean", short: "h" }, version: { type: "boolean" }, profile: { type: "string" },
    workspace: { type: "string" }, "codex-home": { type: "string" }, "codex-bin": { type: "string" }, "params-file": { type: "string" },
  } });
  if (values.version || positionals[0] === "version") { console.log(formatVersion(packageVersion())); return 0; }
  if (values.help || !positionals.length) { console.log(help); return 0; }
  if (positionals.length !== 1) throw new Error("Expected one command; see --help");
  const command = positionals[0];
  if (command !== "serve" && !commands.has(command)) throw new Error(`Unknown command: ${command}; see --help`);
  const profile = values.profile || process.env.PWRAGENT_PROFILE || "default";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) throw new Error("Invalid profile name");
  const root = process.env.PWRAGENT_HOME || path.join(homedir(), ".pwragent");
  if (!path.isAbsolute(root)) throw new Error("PWRAGENT_HOME must be absolute");
  process.env.PWRAGENT_HOME = root;
  process.env.PWRAGENT_PROFILE = profile;
  const directory = path.join(root, "profiles", profile, "state", "headless");
  if (command === "serve") return serve({ directory, workspace: values.workspace, home: values["codex-home"], command: values["codex-bin"], profile });
  let params = {};
  if (values["params-file"]) {
    const file = values["params-file"];
    if (!statSync(file).isFile() || statSync(file).size > 256 * 1024) throw new Error("--params-file must be a JSON file of at most 256 KiB");
    params = JSON.parse(readFileSync(file, "utf8"));
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Expected a JSON parameter object");
  }
  console.log(JSON.stringify(await call(directory, command, params)));
  return 0;
}
