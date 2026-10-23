import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { call } from "./client.js";
import { serve } from "./daemon.js";
import { ACTIVE } from "./store.js";

const help = `PwrAgent Headless (experimental, Linux/macOS, Node >=22)

  pwragent serve --workspace /project --codex-home /codex-home --codex-bin /path/to/codex
  pwragent status | list
  pwragent submit --id JOB --prompt-file /task.txt [--sandbox read-only|workspace-write]
                  [--model MODEL] [--thread THREAD_ID]
  pwragent show|read|interrupt|wait --id JOB
  pwragent federation-join --invite-file /invite.txt --gateway ws://127.0.0.1:47830 [--label NAME]
  pwragent federation-invite [--port 47831] [--label NAME]
  pwragent federation-status | federation-leave
  pwragent federation-revoke --peer INSTANCE_ID

Use --profile NAME (or PWRAGENT_PROFILE, default: default).
State: $PWRAGENT_HOME/profiles/NAME/state/headless (default root: ~/.pwragent).
serve runs in the foreground; use systemd to own its lifetime remotely.
submit returns durable acceptance. wait exits 0 only for completed, 2 otherwise.
Approvals are never granted. Job IDs cannot be reused for different input.
Federation uses private retained identity files and the standard encrypted protocol.
No provisioning, login, queue, automatic replay, or desktop services.
`;

export async function main(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: "boolean", short: "h" },
    profile: { type: "string" },
    workspace: { type: "string" },
    "codex-home": { type: "string" },
    "codex-bin": { type: "string" },
    id: { type: "string" },
    "prompt-file": { type: "string" },
    thread: { type: "string" },
    model: { type: "string" },
    sandbox: { type: "string" },
    "invite-file": { type: "string" },
    gateway: { type: "string" },
    label: { type: "string" },
    port: { type: "string" },
    peer: { type: "string" },
  } });
  if (values.help || !positionals.length) { console.log(help); return 0; }
  if (positionals.length !== 1) throw new Error("Expected one command; see --help");
  const command = positionals[0];
  const allowed = {
    serve: ["workspace", "codex-home", "codex-bin"],
    submit: ["id", "prompt-file", "thread", "model", "sandbox"],
    show: ["id"], read: ["id"], interrupt: ["id"], wait: ["id"], status: [], list: [],
    "federation-join": ["invite-file", "gateway", "label"],
    "federation-invite": ["port", "label"],
    "federation-status": [], "federation-leave": [], "federation-revoke": ["peer"],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error(`Unknown command: ${command}`);
  for (const option of Object.keys(values)) {
    if (option !== "profile" && !allowed[command].includes(option)) throw new Error(`--${option} does not apply to ${command}`);
  }
  const profile = values.profile || process.env.PWRAGENT_PROFILE || "default";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) throw new Error("Invalid profile name");
  const root = process.env.PWRAGENT_HOME || path.join(homedir(), ".pwragent");
  if (!path.isAbsolute(root)) throw new Error("PWRAGENT_HOME must be absolute");
  const directory = path.join(root, "profiles", profile, "state", "headless");
  if (command === "serve") {
    return serve({ directory, workspace: values.workspace, home: values["codex-home"], command: values["codex-bin"], profile });
  }
  if (command.startsWith("federation-")) {
    let invite;
    if (command === "federation-join") {
      const file = values["invite-file"];
      if (!file || !statSync(file).isFile() || statSync(file).size > 64 * 1024) throw new Error("--invite-file must name a file of at most 64 KiB");
      invite = readFileSync(file, "utf8").trim();
    }
    console.log(JSON.stringify(await call(directory, command, { invite, gateway: values.gateway, label: values.label,
      port: values.port === undefined ? undefined : Number(values.port), peer: values.peer })));
    return 0;
  }
  if (allowed[command].includes("id") && !values.id) throw new Error("--id is required");
  if (command === "submit") {
    const file = values["prompt-file"];
    if (!file || !statSync(file).isFile() || statSync(file).size > 256 * 1024) throw new Error("--prompt-file must name a file of at most 256 KiB");
    const result = await call(directory, "submit", { id: values.id, prompt: readFileSync(file, "utf8"),
      threadId: values.thread, model: values.model, sandbox: values.sandbox });
    console.log(JSON.stringify(result));
    return 0;
  }
  if (command === "wait") {
    for (;;) {
      const job = await call(directory, "show", { id: values.id });
      if (!ACTIVE.has(job.status)) {
        console.log(JSON.stringify(job));
        return job.status === "completed" ? 0 : 2;
      }
      await delay(1000);
    }
  }
  console.log(JSON.stringify(await call(directory, command, { id: values.id })));
  return 0;
}
